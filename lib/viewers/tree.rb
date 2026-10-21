# frozen_string_literal: true

require "date"
require "json"
require "psych"
require "strscan"

module Viewers
  # JSON, JSON with comments, JSON5, YAML, TOML and JSON Lines as a
  # collapsible tree. The server parses (stdlib JSON and Psych, tomlrb for
  # TOML, a small JSON5 reader below) and sends a bounded node list, so the
  # browser never runs a parser on the file and the node cap holds before
  # anything leaves the server. Keys keep their file order: objects travel
  # as [key, node] pairs, numbers as their text.
  module Tree
    extend Preview::Viewer

    TREE = Preview::View.new(id: "tree", label: "Tree", tip: "Collapsible tree of keys and values")
    FORMATS = {
      "json" => :json, "jsonc" => :jsonc, "json5" => :json5, "yaml" => :yaml, "yml" => :yaml, "toml" => :toml,
      "jsonl" => :jsonl, "ndjson" => :jsonl
    }.freeze
    LABELS = { json: "JSON", jsonc: "JSONC", json5: "JSON5", yaml: "YAML", toml: "TOML", jsonl: "JSON Lines" }.freeze
    YAML_CLASSES = %w[Date Time Symbol].freeze
    UTF8_BOM = "\xEF\xBB\xBF".b.freeze

    # A file that does not parse; the message reaches the browser as is.
    class Malformed < StandardError; end

    def self.icon = "braces"

    # Above text (10), so Tree is the first tab of these files.
    def self.priority = 15

    def self.exts = FORMATS.keys

    def self.views(_target) = [TREE]

    def self.settings
      { "tree_view_max_bytes" => 2 * 1024 * 1024, "tree_view_max_nodes" => 20_000, "tree_view_max_depth" => 100,
        "tree_view_expand_depth" => 2, "tree_view_yaml_aliases" => false }
    end

    def self.max_bytes_key = "tree_view_max_bytes"

    # { ok, format, docs: [[label, node]…], nodes, truncated, expand_depth } or
    # { ok: false, message } when the file does not parse (not counted).
    def self.data(ctx)
      return ctx.json({ ok: false, message: "The file is above the tree viewer limit." }, count: false) if ctx.too_large?

      format = FORMATS.fetch(File.extname(ctx.real).delete_prefix(".").downcase)
      encoder = Encoder.new(max_nodes: Setting.get("tree_view_max_nodes"), max_depth: Setting.get("tree_view_max_depth"))
      docs = parse(format, read(ctx.real)).map { |label, value| [label, encoder.node(value)] }
      ctx.json({ ok: true, format: LABELS[format], docs: docs, nodes: encoder.count, truncated: encoder.truncated,
                 max_nodes: encoder.max_nodes, expand_depth: Setting.get("tree_view_expand_depth") })
    rescue Malformed => e
      ctx.json({ ok: false, message: e.message }, count: false)
    end

    def self.read(path)
      text = File.binread(path).delete_prefix(UTF8_BOM).force_encoding(Encoding::UTF_8)
      raise Malformed, "The file is not valid UTF-8." unless text.valid_encoding?

      text
    end

    # [[label or nil, value]…]: one entry per YAML document or JSON line.
    def self.parse(format, text)
      depth = Setting.get("tree_view_max_depth")
      case format
      when :json then [[nil, JSON.parse(text, **json_options(depth))]]
      when :jsonc then [[nil, JSON.parse(text, **json_options(depth), allow_comments: true, allow_trailing_comma: true)]]
      when :json5 then [[nil, Json5.new(text, max_depth: depth).parse]]
      when :yaml then yaml(text)
      when :toml then [[nil, toml(text)]]
      when :jsonl then json_lines(text, depth)
      end
    rescue JSON::ParserError, Psych::Exception => e
      raise Malformed, e.message.sub(/\A\(<unknown>\): /, "")
    rescue SystemStackError
      raise Malformed, "The file is nested too deeply to show as a tree."
    end

    # tomlrb loads on first use, so an image without it still serves the
    # other formats.
    def self.toml(text)
      require "tomlrb"
      Tomlrb.parse(text)
    rescue LoadError
      raise Malformed, "TOML needs the tomlrb gem, which this installation lacks."
    rescue Tomlrb::ParseError => e
      raise Malformed, e.message
    end

    def self.json_options(depth) = { max_nesting: depth, allow_nan: true, allow_duplicate_key: true }

    # Every document of the stream through Psych's safe loader: plain data,
    # dates and symbols only, aliases only when tree_view_yaml_aliases is on.
    def self.yaml(text)
      loader = Psych::ClassLoader::Restricted.new(YAML_CLASSES, [])
      scanner = Psych::ScalarScanner.new(loader)
      visitor = Setting.get("tree_view_yaml_aliases") ? Psych::Visitors::ToRuby : Psych::Visitors::NoAliasRuby
      docs = Psych.parse_stream(text).children
      docs.each_with_index.map do |doc, i|
        [docs.size > 1 ? "Document #{i + 1}" : nil, visitor.new(scanner, loader, symbolize_names: false, freeze: false).accept(doc)]
      end
    rescue Psych::AliasesNotEnabled
      raise Malformed, "The file uses YAML aliases, which the tree viewer does not expand (tree_view_yaml_aliases)."
    rescue Psych::DisallowedClass => e
      raise Malformed, "The file holds a value the tree viewer does not load: #{e.message.sub(/\ATried to load /, '')}"
    end

    # One tree per line; a line that does not parse is an error node, the
    # file is malformed only when no line parses.
    def self.json_lines(text, depth)
      docs = []
      text.each_line.with_index(1) do |line, n|
        next if line.strip.empty?

        docs << begin
          ["Line #{n}", JSON.parse(line, **json_options(depth))]
        rescue JSON::ParserError => e
          ["Line #{n}", Error.new(e.message)]
        end
      end
      raise Malformed, "No line of the file is valid JSON." if docs.none? { |_, v| !v.is_a?(Error) }

      docs
    end

    Error = Struct.new(:message)

    # Ruby values → compact nodes, at most max_nodes of them:
    #   ["o", [[key, node]…]]  ["a", [node…]]  ["s", text]  ["n", "12.5"]
    #   ["b", true]  ["z"] (null)  ["d", "2026-10-21"]  ["x", message]  ["more"] (cut here)
    class Encoder
      attr_reader :count, :truncated, :max_nodes

      def initialize(max_nodes:, max_depth:)
        @max_nodes = max_nodes
        @max_depth = max_depth
        @count = 0
        @truncated = false
      end

      def node(value, depth = 0)
        raise Malformed, "The file is nested deeper than #{@max_depth} levels." if depth > @max_depth

        @count += 1
        case value
        when Hash then ["o", children(value) { |(k, v)| [key(k), node(v, depth + 1)] }]
        when Array then ["a", children(value) { |v| node(v, depth + 1) }]
        when String then ["s", text(value)]
        when Integer, Float then ["n", number(value)]
        when true, false then ["b", value]
        when nil then ["z"]
        when Symbol then ["s", ":#{value}"]
        when Time, DateTime then ["d", value.iso8601]
        when Date then ["d", value.iso8601]
        when Error then ["x", value.message]
        else ["d", value.to_s]
        end
      end

      private

      def children(collection)
        out = []
        collection.each do |item|
          if @count >= @max_nodes
            @truncated = true
            out << ["more"]
            break
          end
          out << yield(item)
        end
        out
      end

      def key(value) = value.is_a?(String) ? text(value) : value.to_s

      def number(value)
        return value.to_s unless value.is_a?(Float) && !value.finite?

        value.nan? ? "NaN" : (value.positive? ? "Infinity" : "-Infinity")
      end

      def text(value)
        s = value.encoding == Encoding::UTF_8 ? value : value.dup.force_encoding(Encoding::UTF_8)
        s.valid_encoding? ? s : "(binary, #{value.bytesize} bytes)"
      end
    end

    # JSON5 (json5.org): comments, trailing commas, unquoted keys, single
    # quotes, hex, leading/trailing dots, +/-, Infinity and NaN.
    class Json5
      IDENT = /[$_\p{L}][$\p{L}\p{N}\p{Mn}\p{Mc}\p{Pc}\u200C\u200D]*/
      NUMBER = /[+-]?(?:0[xX]\h+|Infinity|NaN|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/
      ESCAPES = { "b" => "\b", "f" => "\f", "n" => "\n", "r" => "\r", "t" => "\t", "v" => "\v", "0" => "\0" }.freeze

      def initialize(text, max_depth:)
        @s = StringScanner.new(text)
        @max_depth = max_depth
      end

      def parse
        value = value(0)
        skip
        fail!("unexpected content after the value") unless @s.eos?
        value
      end

      private

      def value(depth)
        fail!("nested deeper than #{@max_depth} levels") if depth > @max_depth
        skip
        case @s.peek(1)
        when "{" then object(depth)
        when "[" then array(depth)
        when '"', "'" then string
        else literal
        end
      end

      def object(depth)
        @s.getch
        out = {}
        loop do
          skip
          break if @s.scan(/\}/)

          key = %w[" '].include?(@s.peek(1)) ? string : (@s.scan(IDENT) || fail!("expected a key"))
          skip
          @s.scan(/:/) || fail!("expected ':' after key #{key.inspect}")
          out[key] = value(depth + 1)
          skip
          next if @s.scan(/,/)

          @s.scan(/\}/) ? break : fail!("expected ',' or '}'")
        end
        out
      end

      def array(depth)
        @s.getch
        out = []
        loop do
          skip
          break if @s.scan(/\]/)

          out << value(depth + 1)
          skip
          next if @s.scan(/,/)

          @s.scan(/\]/) ? break : fail!("expected ',' or ']'")
        end
        out
      end

      def string
        quote = @s.getch
        out = +""
        loop do
          chunk = @s.scan(quote == '"' ? /[^"\\\n]+/ : /[^'\\\n]+/)
          out << chunk if chunk
          case @s.getch
          when quote then return out
          when "\\" then out << escape
          else fail!("unterminated string")
          end
        end
      end

      def escape
        case (c = @s.getch || fail!("unterminated string"))
        when "\n", "\u2028", "\u2029" then ""
        when "\r"
          @s.skip(/\n/)
          ""
        when "x" then [(@s.scan(/\h{2}/) || fail!("bad \\x escape")).hex].pack("U")
        when "u" then [(@s.scan(/\h{4}/) || fail!("bad \\u escape")).hex].pack("U")
        else ESCAPES.fetch(c, c)
        end
      end

      def literal
        return true if @s.scan(/true\b/)
        return false if @s.scan(/false\b/)
        return nil if @s.scan(/null\b/)

        text = @s.scan(NUMBER) or fail!("unexpected #{@s.eos? ? 'end of file' : "character #{@s.peek(1).inspect}"}")
        number(text)
      end

      def number(text)
        sign = text.start_with?("-") ? -1 : 1
        body = text.delete_prefix("+").delete_prefix("-")
        return sign * Float::INFINITY if body == "Infinity"
        return Float::NAN if body == "NaN"
        return sign * body.hex if body.match?(/\A0[xX]/)
        return sign * Integer(body, 10) if body.match?(/\A\d+\z/)

        sign * Float(body.end_with?(".") ? "#{body}0" : body.sub(/\A\./, "0."))
      end

      def skip = @s.skip(%r{(?:\s|\u2028|\u2029|\uFEFF|//[^\n]*|/\*.*?\*/)+}m)

      def fail!(what)
        line = @s.string.byteslice(0, @s.pos).count("\n") + 1
        raise Malformed, "JSON5: #{what} at line #{line}"
      end
    end
  end
end
