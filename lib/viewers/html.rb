# frozen_string_literal: true

require "cgi"
require "erb"

module Viewers
  # HTML pages, rendered in an <iframe sandbox="allow-scripts"> from
  # ?data=html, served with "Content-Security-Policy: sandbox allow-scripts":
  # scripts run in an opaque origin that never reaches cloche (no cookies, no
  # storage, no top navigation). The text viewer adds the source as Source.
  #
  # Relative assets (stylesheets, scripts, images, fonts, linked pages) are
  # rewritten to ?data=html&part=<path in the share entry>, resolved through
  # PathGuard like every request, served sandboxed and never counted. The
  # page itself is the one download. URLs a script builds at run time are not
  # rewritten; they reach the plain file route.
  module Html
    extend Preview::Viewer

    RENDERED = Preview::View.new(id: "rendered", label: "Rendered", tip: "The page as a browser shows it")
    CSP = "sandbox allow-scripts"
    DOC_EXTS = %w[html htm xhtml].freeze

    def self.icon = "filetype-html"

    def self.priority = 20

    def self.exts = DOC_EXTS

    def self.views(_target) = [RENDERED]

    def self.settings = { "html_view_max_bytes" => 5 * 1024 * 1024 }

    def self.max_bytes_key = "html_view_max_bytes"

    def self.data(ctx)
      return asset(ctx) if ctx.part
      return too_large(ctx) if ctx.too_large?

      document(ctx, ctx.real, count: true)
    end

    def self.too_large(ctx)
      ctx.html("This page is #{Listing.human_size(ctx.size)}, above the #{Listing.human_size(max_bytes)} viewer limit.",
               status: 413)
    end

    # part = a path inside the share entry the page belongs to. Pages and
    # stylesheets get their own references rewritten; anything else is sent
    # as it is, with CORS open so module scripts and fonts load from the
    # sandbox's opaque origin.
    def self.asset(ctx)
      entry = ctx.share.entries[ctx.index]
      real = entry&.dir && PathGuard.resolve(entry, ctx.part)
      ctx.not_found! unless real && File.file?(real)

      ext = File.extname(real).delete_prefix(".").downcase
      return document(ctx, real, count: false) if DOC_EXTS.include?(ext) && File.size(real) <= max_bytes
      return document(ctx, real, count: false, css: true) if ext == "css" && File.size(real) <= max_bytes

      status, headers, body = ctx.send_file(csp: CSP, count: false, path: real)
      headers["access-control-allow-origin"] = "*"
      [status, headers, body]
    end

    def self.document(ctx, real, count:, css: false)
      ctx.count! if count
      source = File.binread(real)
      rewriter = Rewriter.new(ctx, real)
      body = css ? rewriter.css(source) : rewriter.html(source)
      headers = { "content-type" => FileServer.mime_for(real), "cache-control" => FileServer::PAGE_CACHE,
                  "content-security-policy" => CSP, "x-content-type-options" => "nosniff" }
      headers["access-control-allow-origin"] = "*" if ctx.part
      [200, headers, [body]]
    end

    # Turns relative references in a page or stylesheet into part URLs of
    # the page being viewed. A reference that does not resolve to a file in
    # the share entry stays as written.
    class Rewriter
      ATTR = /(?<lead>[\s"'])(?<name>src|href|poster|background|data)(?<eq>\s*=\s*)(?:"(?<dq>[^"]*)"|'(?<sq>[^']*)')/i
      SRCSET = /(?<lead>[\s"'])(?<name>srcset|imagesrcset)(?<eq>\s*=\s*)(?:"(?<dq>[^"]*)"|'(?<sq>[^']*)')/i
      CSS_URL = /url\(\s*(?<q>["']?)(?<url>[^"')]+)\k<q>\s*\)/i
      CSS_IMPORT = /@import\s+(?<q>["'])(?<url>[^"']+)\k<q>/i

      def initialize(ctx, real)
        @ctx = ctx
        @entry = ctx.share.entries[ctx.index]
        @page = "#{Listing.href(ctx.share, ctx.index, ctx.rel)}?data=html&part="
        root = File.realpath(@entry.path)
        @dir = File.dirname(real).delete_prefix(root).delete_prefix("/")
      end

      def html(source)
        return source unless @entry&.dir

        text = source.b
        text = text.gsub(ATTR) { attr(Regexp.last_match) }
        text = text.gsub(SRCSET) { srcset(Regexp.last_match) }
        css(text)
      end

      def css(source)
        return source unless @entry&.dir

        text = source.b
        text = text.gsub(CSS_URL) { |all| (u = url($~[:url], html: false)) ? "url(#{$~[:q]}#{u}#{$~[:q]})" : all }
        text.gsub(CSS_IMPORT) { |all| (u = url($~[:url], html: false)) ? "@import #{$~[:q]}#{u}#{$~[:q]}" : all }
      end

      private

      def attr(m)
        quote = m[:dq] ? '"' : "'"
        value = m[:dq] || m[:sq]
        rewritten = url(value)
        rewritten ? "#{m[:lead]}#{m[:name]}#{m[:eq]}#{quote}#{attr_safe(rewritten)}#{quote}" : m[0]
      end

      def srcset(m)
        quote = m[:dq] ? '"' : "'"
        list = (m[:dq] || m[:sq]).split(",").map do |candidate|
          url_part, descriptor = candidate.strip.split(/\s+/, 2)
          rewritten = url(url_part.to_s)
          [rewritten ? attr_safe(rewritten) : url_part, descriptor].compact.join(" ")
        end
        "#{m[:lead]}#{m[:name]}#{m[:eq]}#{quote}#{list.join(', ')}#{quote}"
      end

      def attr_safe(url) = url.gsub("&", "&amp;")

      # The part URL for a relative reference, nil when it is absolute or
      # does not resolve to a file. HTML attribute values are entity-decoded
      # first; the result has no quotes or brackets (path and fragment are
      # URL-encoded), and attribute values escape its "&".
      def url(raw, html: true)
        value = raw.to_s.dup.force_encoding(Encoding::UTF_8)
        return nil unless value.valid_encoding?

        value = CGI.unescapeHTML(value) if html
        value = value.strip
        return nil unless TextView.relative?(value)

        path, fragment = value.split("#", 2)
        path = path.split("?", 2).first.to_s
        return nil if path.empty?

        rel = File.expand_path(CGI.unescape(path.gsub("+", "%2B")), "/#{@dir}").delete_prefix("/")
        real = PathGuard.resolve(@entry, rel)
        return nil unless real && File.file?(real)

        "#{@page}#{ERB::Util.url_encode(rel)}#{"##{ERB::Util.url_encode(fragment)}" if fragment}"
      end
    end
  end
end
