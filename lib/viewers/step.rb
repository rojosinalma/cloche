# frozen_string_literal: true

require "digest"
require "fileutils"
require "json"
require "net/http"
require "openssl"
require "securerandom"
require "set"
require "time"
require "tmpdir"
require "uri"

module Viewers
  # STEP (.step, .stp) in the 3D view. cad-render (step_view_cad_render_url)
  # converts the file to STL on the server: ?data=step&part=convert runs the
  # conversion (or finds it cached) and answers JSON, ?data=step sends the
  # STL (the one download of the file). The STL is cached in the container's
  # temp directory, keyed by real path, mtime and size, bounded by
  # step_view_cache_max_bytes and step_view_cache_max_files (least recently
  # used goes first); at most step_view_max_jobs conversions run at once, a
  # second request for the same file waits for the first. Info shows the
  # STEP header and the conversion. Without a cad-render URL, or above
  # step_view_max_bytes, the file gets Info only, with a notice.
  module Step
    extend Preview::Viewer

    MODEL = Preview::View.new(id: "model", label: "3D", tip: "Converted to a mesh by cad-render")
    INFO = Preview::View.new(id: "info", label: "Info", tip: "STEP header and conversion")
    HEADER_BYTES = 64 * 1024 # the HEADER section of a STEP file is a few hundred bytes
    SCHEMAS = { "AUTOMOTIVE_DESIGN" => "AP214", "CONFIG_CONTROL_DESIGN" => "AP203", "AP203_CONFIGURATION_CONTROLLED" => "AP203e2",
                "AP242_MANAGED_MODEL_BASED_3D_ENGINEERING" => "AP242" }.freeze
    LOCK = Mutex.new
    RUNNING = Set.new # cache keys converting now; never more than step_view_max_jobs

    def self.label = "STEP"

    def self.icon = "boxes"

    def self.priority = 50

    def self.exts = %w[step stp]

    def self.binary? = true

    def self.views(target) = refusal(target.size) ? [INFO] : [MODEL, INFO]

    def self.settings
      { "step_view_cad_render_url" => "", "step_view_cad_render_ca_file" => "", "step_view_timeout" => 120,
        "step_view_max_bytes" => 50 * 1024 * 1024, "step_view_max_jobs" => 2,
        "step_view_cache_max_bytes" => 500 * 1024 * 1024, "step_view_cache_max_files" => 200 }
    end

    def self.data(ctx)
      case ctx.part
      when nil then stl(ctx)
      when "convert" then ctx.json(convert(ctx))
      when "info" then ctx.json(info(ctx))
      else ctx.not_found!
      end
    end

    # Why this file gets no 3D view, nil when it does.
    def self.refusal(size)
      return "The 3D view of STEP files is off: cloche has no cad-render URL (setting step_view_cad_render_url)." if url.empty?

      max = Setting.get("step_view_max_bytes")
      "This file is #{Listing.human_size(size)}, above the #{Listing.human_size(max)} STEP conversion limit: Info only." if size > max
    end

    def self.url = Setting.get("step_view_cad_render_url").strip.sub(%r{/+\z}, "")

    def self.stl(ctx)
      result = convert(ctx)
      return ctx.json(result, count: false) unless result[:ok]

      ctx.send_file(path: stl_path(key_of(ctx.real)), type: "model/stl")
    end

    def self.info(ctx)
      meta = cached(key_of(ctx.real), touch: false)
      notice = refusal(ctx.size)
      conversion = if notice then "Off"
                   elsif meta then "#{describe(meta)} (cached)"
                   else "Not converted yet: open the 3D tab"
                   end
      fields = [{ label: "File size", value: Listing.human_size(ctx.size) }, *header(ctx.real),
                { label: "Conversion", value: conversion }]
      { ok: true, notice: notice, cached: !meta.nil?, fields: fields }
    end

    def self.describe(meta)
      parts = ["#{format('%.1f', meta['seconds'])} s by cad-render", "#{Listing.human_size(meta['stl_bytes'])} STL"]
      parts << "#{meta['warnings']} warnings" if meta["warnings"].to_i.positive?
      parts << Time.parse(meta["converted_at"].to_s).utc.strftime("%Y-%m-%d %H:%M UTC") if meta["converted_at"]
      parts.join(", ")
    rescue ArgumentError
      parts.join(", ")
    end

    # ─── Conversion ───

    def self.convert(ctx)
      if (problem = refusal(ctx.size))
        return { ok: false, message: problem }
      end

      key = key_of(ctx.real)
      deadline = now + Setting.get("step_view_timeout")
      loop do
        if (meta = cached(key)) then return { ok: true, cached: true, conversion: describe(meta) } end

        case claim(key)
        when :mine
          begin
            return run(ctx.real, key)
          ensure
            LOCK.synchronize { RUNNING.delete(key) }
          end
        when :busy
          jobs = Setting.get("step_view_max_jobs")
          return { ok: false, message: "cloche already runs #{jobs} STEP conversion#{'s' unless jobs == 1} (step_view_max_jobs); try again in a moment." }
        end
        return { ok: false, message: "The conversion did not finish within #{Setting.get('step_view_timeout')} s." } if now > deadline

        sleep 0.25 # the same file is converting for another request
      end
    end

    def self.claim(key)
      LOCK.synchronize do
        next :waiting if RUNNING.include?(key)
        next :busy if RUNNING.size >= Setting.get("step_view_max_jobs")

        RUNNING << key
        :mine
      end
    end

    def self.run(real, key)
      started = now
      FileUtils.mkdir_p(cache_dir)
      part = File.join(cache_dir, "#{key}.#{SecureRandom.hex(4)}.part")
      response, written = post(real, part)
      return { ok: false, message: reason(response) } unless response.is_a?(Net::HTTPSuccess)
      return { ok: false, message: "cad-render produced an empty model from this file." } if response["x-cad-empty"] == "1" || written.zero?

      meta = { "seconds" => (now - started).round(2), "cad_seconds" => response["x-cad-seconds"]&.to_f,
               "warnings" => response["x-cad-warnings"].to_i, "bbox" => response["x-cad-bbox"], "stl_bytes" => written,
               "converted_at" => Time.now.utc.iso8601 }
      File.write(meta_path(key), JSON.generate(meta))
      File.rename(part, stl_path(key))
      evict!
      $log.info "[step] #{real}: converted in #{meta['seconds']} s (#{Listing.human_size(written)} STL)"
      { ok: true, cached: false, conversion: describe(meta) }
    rescue TooLarge => e
      { ok: false, message: e.message }
    rescue Net::OpenTimeout, Net::ReadTimeout, Net::WriteTimeout
      log_failure(real, "timeout")
      { ok: false, message: "cad-render did not answer within #{Setting.get('step_view_timeout')} s." }
    rescue SocketError, SystemCallError, IOError, OpenSSL::SSL::SSLError, Net::HTTPBadResponse => e
      log_failure(real, "#{e.class}: #{e.message}")
      { ok: false, message: "cad-render at #{url} is not reachable: #{e.message}" }
    ensure
      FileUtils.rm_f(part) if part
    end

    class TooLarge < StandardError; end

    # POSTs the file to cad-render's /convert and streams a successful STL
    # into part. Returns the response and the bytes written.
    def self.post(real, part)
      uri = URI("#{url}/convert")
      max = Setting.get("step_view_cache_max_bytes")
      written = 0
      result = nil
      File.open(real, "rb") do |io|
        request = Net::HTTP::Post.new(uri)
        request.set_form([["file", io, { filename: File.basename(real), content_type: "application/octet-stream" }], %w[format stl]],
                         "multipart/form-data")
        http(uri).request(request) do |response|
          result = response
          next response.read_body unless response.is_a?(Net::HTTPSuccess)

          File.open(part, "wb") do |out|
            response.read_body do |chunk|
              written += chunk.bytesize
              raise TooLarge, "The converted mesh is larger than the #{Listing.human_size(max)} STEP cache." if written > max

              out.write(chunk)
            end
          end
        end
      end
      [result, written]
    end

    def self.http(uri)
      timeout = Setting.get("step_view_timeout")
      http = Net::HTTP.new(uri.host, uri.port)
      http.open_timeout = http.read_timeout = http.write_timeout = timeout
      http.use_ssl = uri.scheme == "https"
      ca = Setting.get("step_view_cad_render_ca_file").strip
      if http.use_ssl? && !ca.empty?
        store = OpenSSL::X509::Store.new
        store.set_default_paths
        store.add_file(ca)
        http.cert_store = store
      end
      http
    end

    # cad-render answers errors as JSON {ok: false, message, log}; the first
    # ERR line of the log usually names the problem.
    def self.reason(response)
      case response.code.to_i
      when 503 then return "cad-render is busy (its queue is full); try again in a moment."
      when 504 then return "cad-render stopped the conversion: it ran past its own time limit."
      end
      data = begin
        JSON.parse(response.body.to_s)
      rescue JSON::ParserError
        {}
      end
      message = data.is_a?(Hash) && data["message"] ? data["message"] : "HTTP #{response.code}"
      detail = data.is_a?(Hash) ? data["log"].to_s.gsub(/\e\[[\d;]*m/, "").lines.map(&:strip).find { |l| l.match?(/\bERR\b/) } : nil
      detail = detail&.gsub(/\A\**\s*|\s*\**\z/, "")
      "cad-render could not convert this file: #{[message, detail].compact.join(' – ')}"[0, 500]
    end

    def self.log_failure(real, what) = $log.warn("[step] #{real}: cad-render at #{url}: #{what}")

    # ─── Cache: container temp, never next to the shared file ───

    def self.cache_dir = File.join(Dir.tmpdir, "cloche-step")

    def self.key_of(real)
      stat = File.stat(real)
      Digest::SHA256.hexdigest([real, stat.mtime.to_r, stat.size].join("\0"))
    end

    def self.stl_path(key) = File.join(cache_dir, "#{key}.stl")

    def self.meta_path(key) = File.join(cache_dir, "#{key}.json")

    # The cached conversion's metadata, nil when absent. A hit marks the
    # entry as recently used.
    def self.cached(key, touch: true)
      return unless File.file?(stl_path(key))

      meta = JSON.parse(File.read(meta_path(key)))
      FileUtils.touch(stl_path(key)) if touch
      meta
    rescue SystemCallError, JSON::ParserError
      nil
    end

    def self.evict!
      files = Dir[File.join(cache_dir, "*.stl")].filter_map { |f| [f, File.stat(f)] rescue nil }.sort_by { |_, s| s.mtime }
      total = files.sum { |_, s| s.size }
      max_bytes = Setting.get("step_view_cache_max_bytes")
      max_files = Setting.get("step_view_cache_max_files")
      while files.any? && (files.size > max_files || total > max_bytes)
        path, stat = files.shift
        total -= stat.size
        FileUtils.rm_f([path, path.sub(/\.stl\z/, ".json")])
      end
    end

    def self.now = Process.clock_gettime(Process::CLOCK_MONOTONIC)

    # ─── STEP header (ISO 10303-21) ───

    def self.header(real)
      text = (File.binread(real, HEADER_BYTES) || "").force_encoding(Encoding::UTF_8).scrub("")
      head = text[/\A\s*ISO-10303-21;\s*HEADER;(.*?)ENDSEC;/m, 1] or return [{ label: "Header", value: "No ISO 10303-21 header found" }]

      description = Array(args(head, "FILE_DESCRIPTION")[0]).reject(&:empty?).join(" ")
      name, stamp, authors, orgs, preprocessor, system = args(head, "FILE_NAME")
      schema = Array(args(head, "FILE_SCHEMA")[0]).first.to_s
      ap = SCHEMAS.find { |k, _| schema.upcase.start_with?(k) }&.last
      created_with = [system, preprocessor].map(&:to_s).reject(&:empty?).uniq
      [["Schema", [ap, schema.sub(/\s*\{.*\}\s*\z/, "")].compact.uniq.join(" · ")], ["Name", name], ["Description", description],
       ["Created", stamp], ["Author", Array(authors).reject(&:empty?).join(", ")],
       ["Organisation", Array(orgs).reject(&:empty?).join(", ")],
       ["Created with", created_with.first && "#{created_with.first}#{" (#{created_with[1]})" if created_with[1]}"]]
        .filter_map { |label, value| { label: label, value: value } unless value.to_s.strip.empty? }
    end

    # The arguments of one header entity: strings, and lists of strings.
    def self.args(head, entity)
      start = head =~ /\b#{entity}\s*\(/ or return []

      i = head.index("(", start) + 1
      out = []
      stack = [out]
      while i < head.size
        c = head[i]
        if c == "'"
          j = i + 1
          j += (head[j] == "'" && head[j + 1] == "'" ? 2 : 1) until j >= head.size || (head[j] == "'" && head[j + 1] != "'")
          stack.last << decode(head[(i + 1)...j].gsub("''", "'"))
          i = j
        elsif c == "("
          stack.last << []
          stack << stack.last.last
        elsif c == ")"
          break if stack.size == 1

          stack.pop
        end
        i += 1
      end
      out
    end

    # \X2\00E9\X0\ (UTF-16 hex) escapes, as CAD tools write accented names.
    def self.decode(string)
      string.gsub(/\\X2\\((?:[0-9A-F]{4})+)\\X0\\/i) { [Regexp.last_match(1)].pack("H*").force_encoding("UTF-16BE").encode("UTF-8") }
    rescue EncodingError
      string
    end
  end
end
