# frozen_string_literal: true

require "json"
require "securerandom"

module Viewers
  # Jupyter notebooks (nbformat 4), rendered server-side and never executed:
  # Markdown cells through the text viewer's renderer, code cells highlighted
  # with Rouge, saved outputs as they were stored. text/html outputs go into
  # an <iframe sandbox="allow-scripts" srcdoc> whose own CSP allows only the
  # one script that reports the height (a nonce per render): the notebook's
  # scripts never run, and the frame is an opaque origin either way. The
  # browser module sets srcdoc from data-srcdoc with the page's colour scheme. Images
  # are data: URLs in <img>, so an SVG runs nothing. The text viewer adds the
  # JSON as Raw.
  module Notebook
    extend Preview::Viewer

    NOTEBOOK = Preview::View.new(id: "notebook", label: "Notebook", tip: "Cells and saved outputs")
    ANSI = /\e\[[0-9;?]*[ -\/]*[@-~]|\e[@-Z\\-_]/
    IMAGE_TYPES = %w[image/png image/jpeg image/gif].freeze
    BASE64 = %r{\A[A-Za-z0-9+/=\s]*\z}

    def self.icon = "journal-code"

    def self.priority = 20

    def self.exts = %w[ipynb]

    def self.views(_target) = [NOTEBOOK]

    def self.settings = { "notebook_view_max_bytes" => 20 * 1024 * 1024 }

    def self.max_bytes_key = "notebook_view_max_bytes"

    def self.data(ctx)
      return ctx.html(notice("This file is #{Listing.human_size(ctx.size)}, above the viewer limit."), status: 413) if ctx.too_large?

      nb = parse(File.read(ctx.real, mode: "rb").force_encoding(Encoding::UTF_8).scrub("\uFFFD").delete_prefix("\uFEFF"))
      return ctx.html(notice(nb)) if nb.is_a?(String)

      ctx.html(Renderer.new(nb, TextView::ShareLinks.new(ctx.share, ctx.index, ctx.rel)).html)
    end

    # The parsed notebook, or the reason it cannot be shown.
    def self.parse(text)
      nb = JSON.parse(text)
      return "This is not a Jupyter notebook: the JSON is not an object." unless nb.is_a?(Hash)

      format = nb["nbformat"].to_i
      return "Notebook format #{format} is not supported; only format 4 renders here." if format.positive? && format != 4
      return "This is not a Jupyter notebook: it has no list of cells." unless nb["cells"].is_a?(Array)

      nb
    rescue JSON::ParserError, JSON::NestingError => e
      "This notebook is not valid JSON (#{TextView.short_error(e)})."
    end

    def self.notice(message) = %(<div class="nb-notebook" data-error="#{Rack::Utils.escape_html(message)}"></div>)

    # One notebook to an HTML fragment for the modal. Everything from the
    # file is escaped, rendered by the escaping Markdown renderer, or kept in
    # an attribute (srcdoc, data: URL).
    class Renderer
      def initialize(nb, links)
        @nb = nb
        @links = links
        meta = nb["metadata"].is_a?(Hash) ? nb["metadata"] : {}
        info = meta["language_info"].is_a?(Hash) ? meta["language_info"] : {}
        kernel = meta["kernelspec"].is_a?(Hash) ? meta["kernelspec"] : {}
        @language = (info["name"] || kernel["language"] || "python").to_s
        @kernel = kernel["display_name"].to_s
        @lexer = Rouge::Lexer.find(@language.downcase) || Rouge::Lexers::PlainText
      end

      def html
        cells = @nb["cells"].select { |c| c.is_a?(Hash) }
        body = cells.map { |c| cell(c) }.join("\n")
        body = %(<div class="t-empty">This notebook has no cells.</div>) if cells.empty?
        %(<div class="nb-notebook" data-cells="#{cells.size}" data-language="#{h(language_label)}" data-kernel="#{h(@kernel)}">#{body}</div>)
      end

      private

      def h(text) = Rack::Utils.escape_html(text.to_s)

      def language_label = @lexer == Rouge::Lexers::PlainText ? @language.capitalize : @lexer.title

      def text(value) = value.is_a?(Array) ? value.join : value.to_s

      def cell(c)
        source = text(c["source"])
        case c["cell_type"]
        when "markdown" then %(<div class="nb-cell nb-markdown"><div class="md-body">#{TextView.render_markdown(source, @links)}</div></div>)
        when "code" then code_cell(c, source)
        else %(<div class="nb-cell nb-raw"><pre class="nb-pre">#{h(source)}</pre></div>)
        end
      end

      def code_cell(c, source)
        count = c["execution_count"]
        outputs = Array(c["outputs"]).select { |o| o.is_a?(Hash) }.map { |o| output(o, count) }.join
        <<~HTML
          <div class="nb-cell nb-code">
            <div class="nb-row"><span class="nb-prompt">In [#{h(count || ' ')}]</span><pre class="nb-source hl"><code>#{Rouge::Formatters::HTML.new.format(@lexer.new.lex(source))}</code></pre></div>
            #{%(<div class="nb-outputs">#{outputs}</div>) unless outputs.empty?}
          </div>
        HTML
      end

      def output(o, count)
        prompt = o["output_type"] == "execute_result" ? "Out [#{h(o['execution_count'] || count)}]" : ""
        body = case o["output_type"]
               when "stream" then %(<pre class="nb-pre#{' nb-stderr' if o['name'] == 'stderr'}">#{h(strip(text(o['text'])))}</pre>)
               when "error" then error(o)
               when "execute_result", "display_data" then rich(o["data"].is_a?(Hash) ? o["data"] : {})
               end
        return "" if body.to_s.empty?

        %(<div class="nb-row nb-output"><span class="nb-prompt">#{prompt}</span><div class="nb-out-body">#{body}</div></div>)
      end

      def error(o)
        trace = Array(o["traceback"]).map { |l| strip(l.to_s) }.join("\n")
        trace = "#{o['ename']}: #{o['evalue']}" if trace.strip.empty?
        %(<pre class="nb-pre nb-error">#{h(trace)}</pre>)
      end

      # The richest saved representation, in Jupyter's order (scripts left out).
      def rich(data)
        if data.key?("text/html") then html_output(text(data["text/html"]))
        elsif data.key?("text/markdown") then %(<div class="md-body">#{TextView.render_markdown(text(data['text/markdown']), @links)}</div>)
        elsif data.key?("image/svg+xml") then image("image/svg+xml", [text(data["image/svg+xml"])].pack("m0"))
        elsif (type = IMAGE_TYPES.find { |t| data.key?(t) }) then image(type, text(data[type]))
        elsif data.key?("application/json") then %(<pre class="nb-pre">#{h(JSON.pretty_generate(data['application/json']))}</pre>)
        elsif data.key?("text/plain") then %(<pre class="nb-pre">#{h(strip(text(data['text/plain'])))}</pre>)
        end
      end

      def image(type, base64)
        return nil unless base64.match?(BASE64)

        %(<img class="nb-image" src="data:#{type};base64,#{base64.delete(" \n\r\t")}" alt="Output image" loading="lazy">)
      end

      def html_output(markup)
        nonce = SecureRandom.hex(12)
        doc = <<~HTML
          <!doctype html><html><head><meta charset="utf-8">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'nonce-#{nonce}'">
          <script nonce="#{nonce}">addEventListener('load',function(){var s=function(){parent.postMessage({clocheNotebookHeight:document.documentElement.getBoundingClientRect().height},'*')};s();new ResizeObserver(s).observe(document.documentElement)})</script>
          <style>:root{color-scheme:light dark}body{margin:0;padding:.25rem;font:13px/1.45 system-ui,sans-serif;color:CanvasText;background:transparent}table{border-collapse:collapse}th,td{border:1px solid color-mix(in srgb,CanvasText 25%,transparent);padding:.2rem .5rem;text-align:right}thead th{background:color-mix(in srgb,CanvasText 8%,transparent)}</style>
          </head><body>#{markup}</body></html>
        HTML
        %(<iframe class="nb-html" sandbox="allow-scripts" referrerpolicy="no-referrer" loading="lazy" title="HTML output" data-srcdoc="#{h(doc)}"></iframe>)
      end

      def strip(value) = value.gsub(ANSI, "")
    end
  end
end
