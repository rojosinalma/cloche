# frozen_string_literal: true

require "csv"
require "json"
require "redcarpet"
require "rouge"

# Decides which files are viewable text, reads them within the size cap and
# renders the viewer card's content: a line-numbered, highlighted source view
# for everything, plus a "pretty" form for Markdown, JSON, JSON Lines and
# CSV/TSV. Nothing here touches the raw file routes.
module TextView
  TEXT_EXTS = %w[
    txt text log md markdown mdown mkd rst adoc asciidoc tex json jsonl ndjson json5 jsonc csv tsv
    yaml yml toml xml xsl xsd svg html htm xhtml ini cfg conf config env properties editorconfig
    rb erb rake gemspec ru js mjs cjs ts tsx jsx vue svelte py pyi c h cc cpp cxx hpp hh m mm go rs
    java kt kts scala swift cs fs php pl pm lua sql psql diff patch sh bash zsh fish ps1 bat cmd
    css scss sass less scad ino hs ex exs erl clj cljs lisp el vim dockerfile makefile mk cmake
    gradle proto graphql gql tf nix r jl dart zig v nim ipynb srt vtt sub lrc m3u m3u8 pem crt csr key pub asc
  ].freeze
  TEXT_NAMES = %w[
    dockerfile makefile gemfile gemfile.lock rakefile procfile guardfile brewfile vagrantfile
    readme license licence copying changelog changes authors contributors todo notice version
    .env .gitignore .gitattributes .gitmodules .dockerignore .editorconfig .npmrc .nvmrc .ruby-version
    .tool-versions .bashrc .zshrc .profile .vimrc .inputrc cmakelists.txt
  ].freeze
  BINARY_EXTS = %w[
    zip gz tgz bz2 xz zst 7z rar tar jar war ear apk deb rpm iso img dmg pkg msi exe dll so dylib
    o a lib obj bin dat db sqlite sqlite3 pdf doc docx xls xlsx ppt pptx odt ods odp woff woff2 ttf
    otf eot class pyc pyo wasm stl 3mf step stp igs iges blend fbx glb gltf psd ai eps ps swf
  ].freeze
  LEXERS_BY_NAME = {
    ".env" => "shell", ".log" => "plaintext", ".txt" => "plaintext", ".text" => "plaintext",
    ".jsonl" => "json", ".ndjson" => "json", ".jsonc" => "json", ".json5" => "json", ".scad" => "c",
    ".ino" => "cpp", ".gemspec" => "ruby", ".ru" => "ruby", ".csv" => "plaintext", ".tsv" => "plaintext",
    ".srt" => "plaintext", ".vtt" => "plaintext", ".conf" => "ini", ".cfg" => "ini", ".config" => "ini",
    ".properties" => "ini"
  }.freeze
  FORMATS = {
    ".md" => :markdown, ".markdown" => :markdown, ".mdown" => :markdown, ".mkd" => :markdown,
    ".json" => :json, ".jsonl" => :jsonl, ".ndjson" => :jsonl, ".csv" => :csv, ".tsv" => :tsv
  }.freeze
  LABELS = { markdown: "Markdown", json: "JSON", jsonl: "JSON Lines", csv: "CSV", tsv: "TSV" }.freeze
  UTF8_BOM = "\xEF\xBB\xBF".b.freeze
  SAFE_SCHEMES = %w[http https mailto].freeze

  View = Struct.new(:name, :size, :format, :label, :lines, :pretty_html, :source_html, :notices, :too_large,
                    :max_bytes, keyword_init: true) do
    def too_large? = too_large

    def pretty? = !pretty_html.nil?

    def empty? = lines.to_i.zero?
  end

  # Resolves Markdown links/images relative to the viewed file against the
  # share entry it lives in, through the same guard as every other request.
  class ShareLinks
    def initialize(share, index, rel)
      @share = share
      @entry = share&.entries&.[](index)
      @index = index
      @dir = rel.to_s.include?("/") ? File.dirname(rel) : ""
    end

    def resolve(link, image: false)
      return nil unless @entry&.dir && TextView.relative?(link)

      path = link.split(/[?#]/, 2).first.to_s
      child_rel = File.expand_path(path, "/#{@dir}").delete_prefix("/")
      real = PathGuard.resolve(@entry, child_rel) or return nil
      return Listing.href(@share, @index, child_rel, dir: true) if File.directory?(real)

      href = Listing.href(@share, @index, child_rel)
      return "#{href}?preview=1" if image
      return "#{href}?view=1" if Listing.previewable?(Listing.kind_of(real))

      "#{href}?dl=1"
    end
  end

  class MarkdownRenderer < Redcarpet::Render::HTML
    def initialize(links)
      super(escape_html: true, safe_links_only: true, hard_wrap: false)
      @links = links
    end

    def block_code(code, language)
      lexer = (language && Rouge::Lexer.find_fancy(language.strip, code)) || Rouge::Lexers::PlainText.new
      %(<pre class="md-code hl"><code>#{Rouge::Formatters::HTML.new.format(lexer.lex(code))}</code></pre>\n)
    end

    def list_item(text, _list_type)
      task = text.match(/\A\s*\[( |x|X)\]\s+/)
      return "<li>#{text}</li>\n" unless task

      checked = task[1].casecmp?("x") ? " checked" : ""
      %(<li class="task-item"><input type="checkbox" disabled#{checked}> #{text[task[0].size..]}</li>\n)
    end

    def link(link, title, content)
      href = TextView.href_for(link, @links)
      return %(<span class="md-missing" data-tip="Link not available here">#{content}</span>) unless href

      %(<a href="#{h(href)}"#{title_attr(title)}#{external_attrs(link)}>#{content}</a>)
    end

    def autolink(link, link_type)
      href = link_type == :email ? "mailto:#{link}" : link
      return h(link) unless TextView.safe_url?(href)

      %(<a href="#{h(href)}"#{external_attrs(href)}>#{h(link)}</a>)
    end

    def image(link, title, alt_text)
      href = TextView.href_for(link, @links, image: true)
      return %(<span class="md-missing" data-tip="Image not in this share"><svg class="t-icon" aria-hidden="true"><use href="/tailor/icons.svg#bi-image"/></svg> #{h(alt_text)}</span>) unless href

      %(<img src="#{h(href)}" alt="#{h(alt_text)}"#{title_attr(title)} loading="lazy">)
    end

    def table(header, body) = %(<div class="table-wrap"><table class="t-table md-table"><thead>#{header}</thead><tbody>#{body}</tbody></table></div>\n)

    private

    def h(text) = Rack::Utils.escape_html(text.to_s)

    def title_attr(title) = title.to_s.empty? ? "" : %( data-tip="#{h(title)}")

    def external_attrs(link) = TextView.relative?(link) ? "" : %( target="_blank" rel="noopener noreferrer")
  end

  module_function

  def max_bytes = Setting.get("text_view_max_bytes")

  def max_rows = Setting.get("text_view_max_rows")

  def sniff_bytes = Setting.get("text_view_sniff_bytes")

  # Extension or well-known name first; unknown extensions are sniffed
  # (first sniff_bytes: no NUL byte and valid UTF-8), known binaries never are.
  def text?(path)
    ext = File.extname(path).delete_prefix(".").downcase
    base = File.basename(path).downcase
    return true if TEXT_EXTS.include?(ext) || TEXT_NAMES.include?(base) || base.start_with?(".env")
    return false if BINARY_EXTS.include?(ext) || Listing::KINDS.values.any? { |exts| exts.include?(ext) }

    sniff(path)
  end

  def sniff(path)
    limit = sniff_bytes
    chunk = File.binread(path, limit) || "".b
    return false if chunk.include?("\0")

    utf8?(chunk, truncated: chunk.bytesize == limit)
  rescue SystemCallError
    false
  end

  # A chunk cut mid-sequence is still valid UTF-8 once the partial tail goes.
  def utf8?(chunk, truncated:)
    text = chunk.dup.force_encoding(Encoding::UTF_8)
    return true if text.valid_encoding?
    return false unless truncated

    (1..3).any? { |n| text.byteslice(0, text.bytesize - n).valid_encoding? }
  end

  def build(real, name:, share: nil, index: nil, rel: nil)
    ext = File.extname(real).downcase
    format = FORMATS.fetch(ext, :code)
    view = View.new(name: name, size: File.size(real), format: format, notices: [], max_bytes: max_bytes)
    view.too_large = view.size > view.max_bytes
    return view.tap { |v| v.label = LABELS.fetch(format, "Text") } if view.too_large?

    text = read_text(real, view)
    lexer = lexer_for(format, real, text)
    view.label = LABELS.fetch(format) { title_of(lexer) }
    view.lines, view.source_html = highlight_lines(text, lexer)
    view.pretty_html = pretty(format, text, view, ShareLinks.new(share, index, rel)) unless view.empty?
    view
  end

  def title_of(lexer)
    title = lexer.class.title.to_s
    title.match?(/\A[a-z]/) ? title.capitalize : title
  end

  def read_text(real, view)
    bytes = File.binread(real, view.max_bytes) || "".b
    bytes = bytes.byteslice(UTF8_BOM.bytesize..) if bytes.start_with?(UTF8_BOM)
    text = bytes.force_encoding(Encoding::UTF_8)
    unless text.valid_encoding?
      view.notices << "Invalid UTF-8 sequences were replaced with \uFFFD."
      text = text.scrub("\uFFFD")
    end
    text.gsub("\r\n", "\n")
  end

  def lexer_for(format, real, text)
    case format
    when :markdown then Rouge::Lexers::Markdown.new
    when :json, :jsonl then Rouge::Lexers::JSON.new
    when :csv, :tsv then Rouge::Lexers::PlainText.new
    else guess_lexer(real, text)
    end
  end

  def guess_lexer(real, text)
    name = File.basename(real)
    ext = File.extname(name).downcase
    if (tag = LEXERS_BY_NAME[ext] || (name.downcase.start_with?(".env") && "shell"))
      return Rouge::Lexer.find(tag).new
    end

    Rouge::Lexer.guess(filename: name, source: text.byteslice(0, 4096).to_s) { |guesses| guesses.first }.new
  rescue StandardError
    Rouge::Lexers::PlainText.new
  end

  # One <div class="line"> per source line so CSS counters can number them
  # and textContent still reads back as the plain text (Copy relies on that).
  class LineFormatter < Rouge::Formatters::HTML
    attr_reader :count

    def stream(tokens)
      @count = 0
      token_lines(tokens) do |line|
        @count += 1
        yield %(<div class="line">)
        line.each { |tok, val| yield span(tok, val) }
        yield "</div>\n"
      end
    end
  end

  def highlight_lines(text, lexer)
    formatter = LineFormatter.new
    html = formatter.format(lexer.lex(text))
    [formatter.count, html]
  end

  def pretty(format, text, view, links)
    case format
    when :markdown then markdown(text, links)
    when :json then pretty_json(text, view)
    when :jsonl then pretty_jsonl(text, view)
    when :csv then pretty_table(text, ",", view)
    when :tsv then pretty_table(text, "\t", view)
    end
  end

  def markdown(text, links)
    %(<div class="md-body">#{render_markdown(text, links)}</div>)
  end

  # Markdown → HTML with the viewer's renderer (escape_html on, safe links
  # only). Without share links, relative links/images render as muted text.
  def render_markdown(text, links = nil)
    renderer = MarkdownRenderer.new(links || ShareLinks.new(nil, nil, ""))
    md = Redcarpet::Markdown.new(renderer, tables: true, fenced_code_blocks: true, autolink: true,
                                           strikethrough: true, footnotes: true, no_intra_emphasis: true,
                                           lax_spacing: true)
    md.render(text.to_s)
  end

  # Inline Markdown (emphasis, code, links) for a single line: the block
  # wrapper Redcarpet adds around a paragraph is stripped.
  def render_inline_markdown(text)
    html = render_markdown(text.to_s.strip).strip
    html.match?(%r{\A<p>.*</p>\z}m) && html.scan("<p>").size == 1 ? html.delete_prefix("<p>").delete_suffix("</p>") : html
  end

  def pretty_json(text, view)
    json_lines(JSON.pretty_generate(JSON.parse(text)))
  rescue JSON::ParserError, JSON::NestingError => e
    view.notices << "Not valid JSON, showing the source as-is (#{short_error(e)})."
    nil
  end

  def pretty_jsonl(text, view)
    bad = 0
    blocks = text.each_line(chomp: true).reject(&:empty?).map do |line|
      JSON.pretty_generate(JSON.parse(line))
    rescue JSON::ParserError, JSON::NestingError
      bad += 1
      line
    end
    return nil if blocks.empty?

    if bad.positive?
      return nil.tap { view.notices << "No line is valid JSON, showing the source as-is." } if bad == blocks.size

      view.notices << "#{bad} of #{blocks.size} lines are not valid JSON and are shown as-is."
    end
    json_lines(blocks.join("\n"))
  end

  def json_lines(text) = %(<div class="code-lines hl">#{highlight_lines(text, Rouge::Lexers::JSON.new).last}</div>)

  def pretty_table(text, sep, view)
    csv = CSV.new(text, col_sep: sep, liberal_parsing: true)
    header = csv.shift or return nil
    shown = []
    total = 0
    csv.each do |row|
      total += 1
      shown << row if total <= max_rows
    end
    view.notices << "Showing the first #{max_rows} of #{total} rows." if total > max_rows
    table_html(header, shown)
  rescue CSV::MalformedCSVError => e
    view.notices << "Not well-formed #{sep == "\t" ? 'TSV' : 'CSV'}, showing the source as-is (#{short_error(e)})."
    nil
  end

  def table_html(header, rows)
    h = ->(cell) { Rack::Utils.escape_html(cell.to_s) }
    head = header.map { |c| "<th>#{h.(c)}</th>" }.join
    body = rows.map { |row| "<tr>#{row.map { |c| "<td>#{h.(c)}</td>" }.join}</tr>" }.join("\n")
    %(<div class="table-wrap"><table class="t-table csv-table"><thead><tr><th class="row-num"></th>#{head}</tr></thead><tbody>#{body}</tbody></table></div>)
  end

  def short_error(error) = error.message.lines.first.to_s.strip[0, 120]

  def relative?(url)
    url = url.to_s
    !url.empty? && !url.start_with?("/", "#", "//") && url[/\A[a-z][a-z0-9+.-]*:/i].nil?
  end

  def safe_url?(url)
    scheme = url.to_s[/\A([a-z][a-z0-9+.-]*):/i, 1]
    scheme.nil? || SAFE_SCHEMES.include?(scheme.downcase)
  end

  # Relative links go through the share guard; absolute ones must be a safe
  # scheme. Anything else (javascript:, data:, unresolvable) renders as text.
  def href_for(link, links, image: false)
    return nil unless safe_url?(link)
    return links.resolve(link, image: image) if relative?(link)
    return nil if link.to_s.start_with?("/") && !link.to_s.start_with?("//")

    link
  end
end
