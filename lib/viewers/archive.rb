# frozen_string_literal: true

module Viewers
  # What is inside an archive, read-only: names, sizes and dates, nothing
  # extracted and no entry served. ZIP is read from its central directory
  # here (no tool, no decompression, so a zip bomb lists like any zip); tar
  # in every compression goes through `tar --list`, 7z through `7z l`, both
  # with a time limit and stopped at the entry cap.
  module Archive
    extend Preview::Viewer

    CONTENTS = Preview::View.new(id: "contents", label: "Contents", tip: "Files inside the archive, nothing extracted")
    SUFFIXES = {
      ".tar.gz" => [:tar, "TAR.GZ"], ".tar.bz2" => [:tar, "TAR.BZ2"], ".tar.xz" => [:tar, "TAR.XZ"],
      ".tgz" => [:tar, "TGZ"], ".tar" => [:tar, "TAR"], ".zip" => [:zip, "ZIP"], ".7z" => [:sevenzip, "7Z"]
    }.freeze
    STDERR_KEEP = 2048
    READ_CHUNK = 65_536

    # An archive that cannot be listed; the message reaches the browser.
    class Unreadable < StandardError; end

    # [path, size or nil, "YYYY-MM-DD HH:MM:SS" or nil, type ("f" file, "d" dir, "l" link), note or nil]
    Contents = Struct.new(:entries, :total, :truncated, :timed_out, :warning, keyword_init: true)

    def self.label = "Archive"

    def self.icon = "file-earmark-zip"

    def self.priority = 50

    def self.exts = %w[zip tar tgz 7z]

    def self.binary? = true

    def self.match?(target) = !format_of(target.basename).nil?

    def self.views(_target) = [CONTENTS]

    def self.settings
      { "archive_view_max_bytes" => 4 * 1024 * 1024 * 1024, "archive_view_max_entries" => 10_000, "archive_view_timeout" => 10 }
    end

    def self.max_bytes_key = "archive_view_max_bytes"

    def self.format_of(basename) = SUFFIXES.find { |suffix, _| basename.end_with?(suffix) }&.last

    # The listing is not the file: it never counts as a download.
    def self.data(ctx)
      return ctx.json({ ok: false, message: "The file is above the archive viewer limit." }, count: false) if ctx.too_large?

      kind, label = format_of(File.basename(ctx.real).downcase)
      max = Setting.get("archive_view_max_entries")
      list = send(:"list_#{kind}", ctx.real, max, Setting.get("archive_view_timeout"))
      ctx.json({ ok: true, format: label, entries: list.entries, total: list.total, truncated: list.truncated,
                 timed_out: list.timed_out, warning: list.warning, max_entries: max }, count: false)
    rescue Unreadable => e
      ctx.json({ ok: false, message: e.message }, count: false)
    end

    # ── ZIP: end of central directory → central directory records ──────────
    def self.list_zip(path, max, _timeout)
      File.open(path, "rb") do |io|
        count, cd_size, cd_offset = zip_directory(io)
        raise Unreadable, "The ZIP central directory points outside the file." if cd_offset + cd_size > io.size

        io.seek(cd_offset)
        entries = []
        [count, max].min.times do
          head = io.read(46)
          raise Unreadable, "The ZIP central directory is damaged." unless head&.bytesize == 46 && head.start_with?("PK\x01\x02".b)

          entries << zip_entry(io, head)
        end
        Contents.new(entries: entries, total: count, truncated: count > max)
      end
    end

    def self.zip_directory(io)
      tail_size = [io.size, 65_535 + 22].min
      io.seek(io.size - tail_size)
      tail = io.read(tail_size)
      at = tail.rindex("PK\x05\x06".b)
      raise Unreadable, "This is not a ZIP archive (no central directory found)." unless at && tail.bytesize - at >= 22

      count, cd_size, cd_offset = tail.byteslice(at + 10, 10).unpack("vVV")
      return [count, cd_size, cd_offset] unless [count, cd_size, cd_offset].any? { |v| v == 0xFFFF || v == 0xFFFFFFFF }

      zip64_directory(io, io.size - tail_size + at)
    end

    def self.zip64_directory(io, eocd_at)
      raise Unreadable, "The ZIP64 locator is missing." if eocd_at < 20

      io.seek(eocd_at - 20)
      locator = io.read(20)
      raise Unreadable, "The ZIP64 locator is missing." unless locator.start_with?("PK\x06\x07".b)

      io.seek(locator.byteslice(8, 8).unpack1("Q<"))
      record = io.read(56)
      raise Unreadable, "The ZIP64 directory record is damaged." unless record&.bytesize == 56 && record.start_with?("PK\x06\x06".b)

      record.byteslice(32, 24).unpack("Q<Q<Q<")
    end

    def self.zip_entry(io, head)
      flags, mtime, mdate = head.unpack("@8v@12vv")
      usize, name_len, extra_len, comment_len = head.unpack("@24Vvvv")
      attrs = head.unpack1("@38V")
      name = io.read(name_len).to_s
      extra = io.read(extra_len).to_s
      io.seek(comment_len, IO::SEEK_CUR)
      usize, unix_time = zip_extra(extra, usize)
      name = zip_name(name, utf8: flags.anybits?(0x800))
      type = name.end_with?("/") ? "d" : ((attrs >> 16) & 0o170000) == 0o120000 ? "l" : "f"
      when_s = unix_time ? Time.at(unix_time).utc.strftime("%F %T") : dos_time(mdate, mtime)
      [name.chomp("/"), type == "d" ? nil : usize, when_s, type, flags.anybits?(1) ? "encrypted" : nil]
    end

    # ZIP64 sizes (0x0001) and the Unix timestamp (0x5455) from the extra field.
    def self.zip_extra(extra, usize)
      unix_time = nil
      pos = 0
      while pos + 4 <= extra.bytesize
        id, len = extra.byteslice(pos, 4).unpack("vv")
        data = extra.byteslice(pos + 4, len).to_s
        usize = data.unpack1("Q<") if id == 0x0001 && usize == 0xFFFFFFFF && data.bytesize >= 8
        unix_time = data.byteslice(1, 4).unpack1("l<") if id == 0x5455 && data.bytesize >= 5 && data.getbyte(0).anybits?(1)
        pos += 4 + len
      end
      [usize, unix_time]
    end

    def self.zip_name(raw, utf8:)
      name = raw.dup.force_encoding(Encoding::UTF_8)
      return name.scrub("?") if utf8 || name.valid_encoding?

      raw.dup.force_encoding(Encoding::IBM437).encode(Encoding::UTF_8)
    end

    def self.dos_time(date, time)
      return nil if date.zero?

      format("%04d-%02d-%02d %02d:%02d:%02d", 1980 + (date >> 9), (date >> 5) & 15, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2)
    end

    # ── tar (any compression GNU tar reads) ─────────────────────────────────
    TAR_LINE = /\A(?<type>\S)\S{9}\S*\s+\S+\s+(?<size>\d+|\d+,\s*\d+)\s+(?<date>\d{4}-\d\d-\d\d \d\d:\d\d(?::\d\d)?)\s(?<name>.*)\z/

    def self.list_tar(path, max, timeout)
      entries = []
      result = run(["tar", "--list", "--verbose", "--full-time", "--numeric-owner", "--file", path], timeout) do |line|
        entry = tar_entry(line) or next
        entries << entry
        :stop if entries.size > max
      end
      listing(entries.first(max), result, "tar")
    end

    def self.tar_entry(line)
      m = TAR_LINE.match(line) or return nil
      name = m[:name]
      type = { "d" => "d", "l" => "l", "h" => "l" }.fetch(m[:type], "f")
      note = nil
      name, note = name.split(" -> ", 2) if m[:type] == "l"
      if m[:type] == "h"
        name, target = name.split(" link to ", 2)
        note = "hard link to #{unescape(target.to_s)}"
      end
      note = "→ #{unescape(note)}" if m[:type] == "l" && note
      [unescape(name).chomp("/"), type == "f" ? m[:size].to_i : nil, m[:date], type, note]
    end

    # GNU tar's default quoting: \\, \n, \t… and \ooo octal bytes.
    def self.unescape(text)
      out = text.b.gsub(/\\(\d{3}|.)/n) do
        c = Regexp.last_match(1)
        c.match?(/\A\d{3}\z/) ? c.to_i(8).chr : { "n" => "\n", "t" => "\t", "r" => "\r", "f" => "\f", "v" => "\v", "a" => "\a", "b" => "\b" }.fetch(c, c)
      end
      out.force_encoding(Encoding::UTF_8).scrub("?")
    end

    # ── 7z ──────────────────────────────────────────────────────────────────
    def self.list_sevenzip(path, max, timeout)
      entries = []
      record = {}
      flush = lambda do
        entries << seven_entry(record) if record["Path"]
        record = {}
        :stop if entries.size > max
      end
      result = run(["7z", "l", "-slt", "-ba", "-bd", "-sccUTF-8", "-p", path], timeout) do |line|
        next flush.call if line.empty?

        key, value = line.split(" = ", 2)
        record[key] = value.to_s if value
        nil
      end
      flush.call unless result[:stopped]
      listing(entries.first(max), result, "7z")
    end

    def self.seven_entry(rec)
      dir = rec["Attributes"].to_s.start_with?("D") || rec["Folder"] == "+"
      link = rec["Attributes"].to_s.include?(" l")
      when_s = rec["Modified"].to_s[0, 19]
      note = rec["Encrypted"] == "+" ? "encrypted" : nil
      [rec["Path"].to_s.scrub("?"), dir ? nil : rec["Size"].to_i, when_s.empty? ? nil : when_s, dir ? "d" : (link ? "l" : "f"), note]
    end

    def self.listing(entries, result, tool)
      if !result[:ok] && entries.empty? && !result[:timed_out]
        reason = result[:stderr].lines.map(&:strip).reject(&:empty?).last(2).join(" ")
        raise Unreadable, "#{tool} could not read the archive#{reason.empty? ? '' : ": #{reason}"}"
      end

      warning = result[:ok] || result[:stopped] || result[:timed_out] ? nil : "#{tool} stopped with an error; the list may be incomplete."
      Contents.new(entries: entries, total: result[:stopped] || result[:timed_out] ? nil : entries.size,
                  truncated: result[:stopped], timed_out: result[:timed_out], warning: warning)
    end

    # Runs cmd with no stdin, feeding each stdout line (UTF-8, chomped) to the
    # block; :stop from the block or the time limit kills the process group.
    def self.run(cmd, timeout)
      out_r, out_w = IO.pipe
      err_r, err_w = IO.pipe
      pid = begin
        Process.spawn(*cmd, in: File::NULL, out: out_w, err: err_w, pgroup: true)
      rescue SystemCallError => e
        raise Unreadable, "#{cmd.first} is not available here (#{e.message})."
      end
      [out_w, err_w].each(&:close)
      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
      buffer = +""
      stderr = +""
      state = { stopped: false, timed_out: false }
      open = [out_r, err_r]
      until open.empty?
        left = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
        if left <= 0
          state[:timed_out] = true
          break
        end
        ready, = IO.select(open, nil, nil, left)
        next unless ready

        ready.each do |io|
          chunk = io.read_nonblock(READ_CHUNK, exception: false)
          next if chunk == :wait_readable

          if chunk.nil?
            open.delete(io)
          elsif io == err_r
            stderr = (stderr + chunk)[-STDERR_KEEP..] || stderr + chunk
          else
            buffer << chunk
            while (nl = buffer.index("\n"))
              line = buffer.slice!(0, nl + 1).chomp.force_encoding(Encoding::UTF_8)
              next unless yield(line) == :stop

              state[:stopped] = true
              break
            end
          end
          break if state[:stopped]
        end
        break if state[:stopped]
      end
      stop(pid) if state[:stopped] || state[:timed_out]
      status = Process.wait2(pid).last
      state.merge(ok: status.success?, stderr: stderr.force_encoding(Encoding::UTF_8).scrub("?"))
    ensure
      [out_r, err_r].each { |io| io&.close unless io&.closed? }
    end

    def self.stop(pid)
      Process.kill("KILL", -pid)
    rescue Errno::ESRCH
      nil
    end
  end
end
