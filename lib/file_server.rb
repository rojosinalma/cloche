# frozen_string_literal: true

require "erb"
require "rack/files"
require "rack/mime"
require "rack/utils"

module FileServer
  EXTRA_MIME = {
    ".png" => "image/png", ".jpg" => "image/jpeg", ".jpeg" => "image/jpeg", ".gif" => "image/gif",
    ".webp" => "image/webp", ".svg" => "image/svg+xml", ".avif" => "image/avif", ".bmp" => "image/bmp",
    ".ico" => "image/vnd.microsoft.icon",
    ".mp4" => "video/mp4", ".webm" => "video/webm", ".ogv" => "video/ogg", ".m4v" => "video/mp4",
    ".mov" => "video/quicktime",
    ".mp3" => "audio/mpeg", ".ogg" => "audio/ogg", ".oga" => "audio/ogg", ".wav" => "audio/wav",
    ".flac" => "audio/flac", ".m4a" => "audio/mp4", ".opus" => "audio/opus", ".aac" => "audio/aac"
  }.freeze
  DEFAULT_MIME = "application/octet-stream"
  FILE_CACHE = "private, max-age=0"
  PAGE_CACHE = "private, no-store"

  # Keeps the share's idle clock from running out while the body is still streaming.
  class TrackedBody
    def initialize(body, share_id)
      @body = body
      @share_id = share_id
      @closed = false
      IdleSweeper.begin_transfer(share_id)
    end

    def each(&) = @body.each(&)

    def respond_to_missing?(name, include_private = false)
      (name == :to_path && @body.respond_to?(:to_path)) || super
    end

    def method_missing(name, *args, &)
      return @body.to_path if name == :to_path && @body.respond_to?(:to_path)

      super
    end

    def close
      return if @closed

      @closed = true
      begin
        @body.close if @body.respond_to?(:close)
      ensure
        IdleSweeper.end_transfer(@share_id)
      end
    end
  end

  module_function

  def serve(request:, share:, real_path:, name:, download: false, preview: false, sandbox: true)
    status, headers, body = Rack::Files.new(File.dirname(real_path)).serving(request, real_path)
    if success?(status)
      multipart = headers["content-type"].to_s.start_with?("multipart/")
      headers.merge!(file_headers(real_path, name, download: download, sandbox: sandbox))
      headers["content-type"] = "multipart/byteranges; boundary=#{Rack::Files::MULTIPART_BOUNDARY}" if multipart
      count(request: request, share: share, name: name) unless preview || skip_count?(request)
    end
    [status, headers, TrackedBody.new(body, share.id)]
  end

  def zip(request:, share:, items:, filename:)
    headers = { "content-type" => "application/zip", "content-disposition" => attachment(filename),
                "cache-control" => FILE_CACHE }
    return [200, headers, []] if request.head?

    count(request: request, share: share, name: filename)
    [200, headers, TrackedBody.new(Zipper.new(items), share.id)]
  end

  def raw_directory(request:, share:, real_dir:, url_path:)
    root = File.realpath(share.entries.first.path)
    index = guarded(File.join(real_dir, "index.html"), root)
    if index && File.file?(index)
      return serve(request: request, share: share, real_path: index, name: raw_name(index, root), sandbox: false, preview: true)
    end

    html = listing_html(real_dir, root, url_path)
    [200, { "content-type" => "text/html; charset=utf-8", "cache-control" => PAGE_CACHE }, [html]]
  end

  def attachment(name) = "attachment; filename*=UTF-8''#{ERB::Util.url_encode(name)}"

  def mime_for(path)
    ext = File.extname(path).downcase
    EXTRA_MIME[ext] || Rack::Mime.mime_type(ext, DEFAULT_MIME)
  end

  def kind_of(path)
    require_relative "listing" unless defined?(::Listing)
    ::Listing.kind_of(path)
  end

  def file_headers(real_path, name, download:, sandbox:)
    headers = { "content-type" => mime_for(real_path), "cache-control" => FILE_CACHE }
    if download || (sandbox && !::Listing.media_kind?(kind_of(real_path)))
      headers["content-disposition"] = attachment(File.basename(name))
    else
      headers["content-disposition"] = "inline"
      headers["content-security-policy"] = "sandbox" if sandbox
    end
    headers
  end

  def success?(status) = status == 200 || status == 206

  def skip_count?(request)
    return true if request.head?

    range = request.get_header("HTTP_RANGE")
    !range.nil? && !range.match?(/\Abytes=0-/)
  end

  def count(request:, share:, name:)
    Download.create(share_id: share.id, name: name, ip: request.ip, created_at: Time.now)
    $log.info "[download] #{share.id} #{name} #{request.ip}"
  end

  def guarded(path, root)
    real = File.realpath(path)
    real if PathGuard.within?(real, root) && PathGuard.allowed?(real)
  rescue SystemCallError
    nil
  end

  def raw_name(real, root) = real.delete_prefix(root).delete_prefix("/")

  def listing_html(real_dir, root, url_path)
    rows = raw_children(real_dir, root).map do |child, dir|
      label = dir ? "#{child}/" : child
      %(<li><a href="#{ERB::Util.url_encode(child)}#{'/' if dir}">#{Rack::Utils.escape_html(label)}</a></li>)
    end
    rows.unshift(%(<li><a href="../">../</a></li>)) unless real_dir == root
    title = Rack::Utils.escape_html("Index of #{url_path}")
    <<~HTML
      <!DOCTYPE html>
      <html lang="en"><head><meta charset="UTF-8"><title>#{title}</title></head>
      <body><h1>#{title}</h1><ul>
      #{rows.join("\n")}
      </ul></body></html>
    HTML
  end

  def raw_children(real_dir, root)
    Dir.children(real_dir).filter_map do |child|
      real = guarded(File.join(real_dir, child), root) or next
      [child, File.directory?(real)]
    end.sort_by { |child, dir| [dir ? 0 : 1, child.downcase] }
  end
end
