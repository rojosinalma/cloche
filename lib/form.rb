# frozen_string_literal: true

require "json"
require "rack/utils"

# Form shares: the spec an agent attaches to a share (validated and normalised
# once at create time, stored as JSON in shares.form) and the two ways answers
# come in — a lenient draft while the user is still picking, a strict submit.
# Nothing a spec does not define is ever kept.
module Form
  class Invalid < StandardError
    attr_reader :errors

    def initialize(message, errors = nil)
      super(message)
      @errors = errors
    end
  end

  ID_FORMAT = /\A[a-z0-9_]{1,64}\z/
  TYPES = %w[checklist radio select text tasklist markdown].freeze
  OPTION_TYPES = %w[checklist radio select].freeze
  MULTI_TYPES = %w[checklist tasklist].freeze
  SINGLE_TYPES = %w[radio select].freeze
  PROSE_TYPES = %w[tasklist markdown].freeze
  TASK_LINE = /\A\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s+(.*)\z/
  LABEL_MAX = 500
  HELP_MAX = 2000

  Option = Struct.new(:value, :label, :hint, :label_html, keyword_init: true) do
    def to_h = { value: value, label: label, hint: hint }.compact
  end

  Field = Struct.new(:id, :type, :label, :help, :required, :default, :options, :markdown, :html,
                     :multiline, :placeholder, :max_chars, :min, :max, keyword_init: true) do
    def markdown? = type == "markdown"

    def multi? = MULTI_TYPES.include?(type)

    def single? = SINGLE_TYPES.include?(type)

    def text? = type == "text"

    def tasklist? = type == "tasklist"

    def answerable? = !markdown?

    def option(value) = options&.find { |o| o.value == value }

    def option_values = options.to_a.map(&:value)

    # The stored/normalised form: rendered HTML is recomputed on parse.
    def to_h
      { id: id, type: type, label: label, help: help, required: (required || nil), default: default,
        options: (options&.map(&:to_h) unless tasklist?), markdown: markdown, multiline: (multiline || nil),
        placeholder: placeholder, max_chars: max_chars, min: min, max: max }.compact
    end
  end

  module_function

  def max_fields = Setting.get("form_max_fields")

  def max_options = Setting.get("form_max_options")

  def text_max_chars = Setting.get("form_text_max_chars")

  def max_bytes = Setting.get("form_max_bytes")

  def bulk_threshold = Setting.get("form_bulk_threshold")

  def string_or_nil(value, max, what)
    return nil if value.nil?
    raise Invalid, "#{what} must be a string" unless value.is_a?(String)

    text = value.strip
    text.empty? ? nil : text[0, max]
  end

  def integer_or_nil(value, what)
    return nil if value.nil? || value == ""
    return value if value.is_a?(Integer)
    return Integer(value, 10) if value.is_a?(String) && value.match?(/\A-?\d+\z/)

    raise Invalid, "#{what} must be an integer"
  end

  def truthy?(value) = value == true || %w[true 1 yes on].include?(value.to_s.downcase)

  def ordinal(value)
    return value if value.is_a?(Integer)
    return Integer(value, 10) if value.is_a?(String) && value.match?(/\A\d+\z/)

    nil
  end

  class Spec
    attr_reader :intro, :fields

    def self.parse(raw)
      raise Invalid, "form must be an object {intro?, fields[]}" unless raw.is_a?(Hash)

      size = JSON.generate(raw).bytesize
      raise Invalid, "form spec is #{size} bytes, over the #{Form.max_bytes} byte cap" if size > Form.max_bytes

      new(raw)
    end

    def initialize(raw)
      raw = raw.transform_keys(&:to_s)
      @intro = Form.string_or_nil(raw["intro"], Form.max_bytes, "intro")
      list = raw["fields"]
      raise Invalid, "fields must be a non-empty array" unless list.is_a?(Array) && !list.empty?
      raise Invalid, "#{list.size} fields, over the #{Form.max_fields} field cap" if list.size > Form.max_fields

      @fields = list.each_with_index.map { |f, i| FieldParser.new(f, i).field }
      check_unique_ids
    end

    def field(id) = fields.find { |f| f.id == id.to_s }

    def answerable = fields.select(&:answerable?)

    def intro_html = intro && TextView.render_markdown(intro)

    def to_h = { intro: intro, fields: fields.map(&:to_h) }.compact

    def to_json(*args) = JSON.generate(to_h, *args)

    # The pre-filled draft a fresh share starts with.
    def defaults
      answerable.each_with_object({}) { |f, acc| acc[f.id] = f.default unless f.default.nil? }
    end

    private

    def check_unique_ids
      seen = {}
      fields.each do |f|
        raise Invalid, "field id #{f.id.inspect} is used twice" if seen[f.id]

        seen[f.id] = true
      end
    end
  end

  class FieldParser
    def initialize(raw, index)
      raise Invalid, "fields[#{index}] must be an object" unless raw.is_a?(Hash)

      @raw = raw.transform_keys(&:to_s)
      @index = index
    end

    def field
      type = @raw["type"].to_s
      raise Invalid, "#{where}: type must be one of #{TYPES.join(', ')}" unless TYPES.include?(type)

      f = Field.new(id: parse_id(type), type: type, label: string("label", LABEL_MAX),
                    help: string("help", HELP_MAX), required: Form.truthy?(@raw["required"]))
      case type
      when "checklist", "radio", "select" then with_options(f)
      when "text" then with_text(f)
      when "tasklist" then with_tasklist(f)
      when "markdown" then with_markdown(f)
      end
      f
    end

    private

    def where = @raw["id"].to_s.empty? ? "fields[#{@index}]" : "field #{@raw['id']}"

    def string(key, max) = Form.string_or_nil(@raw[key], max, "#{where}: #{key}")

    def integer(key) = Form.integer_or_nil(@raw[key], "#{where}: #{key}")

    def parse_id(type)
      id = @raw["id"].to_s.strip
      return "md_#{@index + 1}" if id.empty? && type == "markdown"
      raise Invalid, "fields[#{@index}]: id is required (#{ID_FORMAT.source})" if id.empty?
      raise Invalid, "field #{id}: id must match #{ID_FORMAT.source}" unless id.match?(ID_FORMAT)

      id
    end

    def with_options(f)
      f.options = parse_options(@raw["options"])
      if f.multi?
        f.min = integer("min")
        f.max = integer("max")
        check_bounds(f)
        f.default = Answers.coerce_multi(f, @raw["default"], strict: true, where: where)
      else
        f.default = Answers.coerce_single(f, @raw["default"], strict: true, where: where)
      end
    end

    def with_text(f)
      cap = Form.text_max_chars
      f.multiline = Form.truthy?(@raw["multiline"])
      f.placeholder = string("placeholder", LABEL_MAX)
      f.max_chars = integer("max_chars")
      raise Invalid, "#{where}: max_chars must be between 1 and #{cap}" if f.max_chars && !f.max_chars.between?(1, cap)

      f.max_chars ||= cap
      default = @raw["default"]
      raise Invalid, "#{where}: default must be a string" unless default.nil? || default.is_a?(String)

      f.default = default&.[](0, f.max_chars)
    end

    def with_tasklist(f)
      f.markdown = prose
      items = []
      prose_lines = []
      f.markdown.each_line(chomp: true) do |line|
        if (m = TASK_LINE.match(line))
          items << [m[2].strip, m[1].casecmp?("x")]
        else
          prose_lines << line
        end
      end
      raise Invalid, "#{where}: the markdown has no task items (- [ ] …)" if items.empty?
      raise Invalid, "#{where}: #{items.size} items, over the #{Form.max_options} option cap" if items.size > Form.max_options

      f.options = items.each_with_index.map do |(text, _), i|
        Option.new(value: i + 1, label: text, hint: nil, label_html: TextView.render_inline_markdown(text))
      end
      f.html = TextView.render_markdown(prose_lines.join("\n")) unless prose_lines.join.strip.empty?
      f.min = integer("min")
      f.max = integer("max")
      check_bounds(f)
      checked = items.each_index.select { |i| items[i][1] }.map { |i| i + 1 }
      f.default = @raw.key?("default") ? Answers.coerce_multi(f, @raw["default"], strict: true, where: where) : checked
    end

    def with_markdown(f)
      f.markdown = prose
      f.html = TextView.render_markdown(f.markdown)
    end

    # Inline markdown, or a file under an allowed root read once, now.
    def prose
      text = @raw["markdown"]
      path = @raw["path"]
      raise Invalid, "#{where}: give either markdown or path, not both" if text && path
      raise Invalid, "#{where}: markdown must be a string" if text && !text.is_a?(String)
      return text if text && !text.strip.empty?
      raise Invalid, "#{where}: markdown or path is required" if path.to_s.strip.empty?

      read_file(path.to_s.strip)
    end

    def read_file(path)
      real = PathGuard.validate_path(path)
      raise Invalid, "#{where}: #{path} is not a file" unless File.file?(real)
      raise Invalid, "#{where}: #{path} is over the #{Form.max_bytes} byte cap" if File.size(real) > Form.max_bytes

      text = File.read(real, encoding: "UTF-8")
      raise Invalid, "#{where}: #{path} is not UTF-8 text" unless text.valid_encoding?

      text
    rescue PathGuard::Denied => e
      raise Invalid, "#{where}: #{e.message}"
    end

    def parse_options(list)
      raise Invalid, "#{where}: options must be a non-empty array" unless list.is_a?(Array) && !list.empty?
      raise Invalid, "#{where}: #{list.size} options, over the #{Form.max_options} option cap" if list.size > Form.max_options

      seen = {}
      list.each_with_index.map do |opt, i|
        option = parse_option(opt, i)
        raise Invalid, "#{where}: option value #{option.value.inspect} is used twice" if seen[option.value]

        seen[option.value] = true
        option
      end
    end

    def parse_option(opt, i)
      opt = { "value" => opt } unless opt.is_a?(Hash)
      opt = opt.transform_keys(&:to_s)
      value = opt["value"]
      value = value.to_s if value.is_a?(Numeric)
      raise Invalid, "#{where}: options[#{i}] value must be a non-empty string" unless value.is_a?(String) && !value.strip.empty?

      value = value.strip[0, LABEL_MAX]
      label = Form.string_or_nil(opt["label"], LABEL_MAX, "#{where}: options[#{i}] label") || value
      hint = Form.string_or_nil(opt["hint"], HELP_MAX, "#{where}: options[#{i}] hint")
      Option.new(value: value, label: label, hint: hint, label_html: Rack::Utils.escape_html(label))
    end

    def check_bounds(f)
      count = f.options.size
      raise Invalid, "#{where}: min must be between 0 and #{count}" if f.min && !f.min.between?(0, count)
      raise Invalid, "#{where}: max must be between 1 and #{count}" if f.max && !f.max.between?(1, count)
      raise Invalid, "#{where}: min is greater than max" if f.min && f.max && f.min > f.max
    end
  end

  # Answer normalisation. draft: lenient, keeps whatever fits the spec and
  # drops the rest. submit: strict, returns [answers, errors].
  module Answers
    module_function

    def draft(spec, raw)
      raise Invalid, "answers must be an object {field_id: value}" unless raw.is_a?(Hash)

      spec.answerable.each_with_object({}) do |f, acc|
        next unless raw.key?(f.id) || raw.key?(f.id.to_sym)

        value = coerce(f, raw.key?(f.id) ? raw[f.id] : raw[f.id.to_sym], strict: false)
        acc[f.id] = value unless value.nil?
      end
    end

    def submit(spec, raw)
      raise Invalid, "answers must be an object {field_id: value}" unless raw.is_a?(Hash)

      answers = {}
      errors = {}
      spec.answerable.each do |f|
        value = raw.key?(f.id) ? raw[f.id] : raw[f.id.to_sym]
        begin
          answers[f.id] = validate(f, value)
        rescue Invalid => e
          errors[f.id] = e.message
        end
      end
      [answers, errors]
    end

    def coerce(f, value, strict:)
      return coerce_multi(f, value, strict: strict) if f.multi?
      return coerce_single(f, value, strict: strict) if f.single?

      coerce_text(f, value, strict: strict)
    end

    def coerce_multi(f, value, strict:, where: nil)
      return nil if value.nil?

      list = value.is_a?(Array) ? value : [value]
      pairs = list.map { |v| [v, f.tasklist? ? Form.ordinal(v) : (v.is_a?(Numeric) ? v.to_s : v)] }
      known, unknown = pairs.partition { |(_, v)| f.option(v) }
      if strict && !unknown.empty?
        shown = unknown.first(3).map { |(given, _)| given.inspect }.join(", ")
        raise Invalid, "#{where ? "#{where}: default has " : ''}unknown option#{'s' if unknown.size > 1} #{shown}"
      end

      known.map(&:last).uniq
    end

    def coerce_single(f, value, strict:, where: nil)
      return nil if value.nil? || value == ""

      value = value.to_s if value.is_a?(Numeric)
      return value if f.option(value)
      raise Invalid, "#{where ? "#{where}: default is an " : ''}unknown option #{value.inspect}" if strict

      nil
    end

    def coerce_text(f, value, strict:)
      return nil if value.nil?
      unless value.is_a?(String) || value.is_a?(Numeric)
        raise Invalid, "must be text" if strict

        return nil
      end

      text = value.to_s
      raise Invalid, "#{text.size} characters, the limit is #{f.max_chars}" if strict && text.size > f.max_chars

      text[0, f.max_chars]
    end

    def validate(f, value)
      if f.multi?
        list = coerce_multi(f, value.nil? ? [] : value, strict: true)
        raise Invalid, "pick at least one" if f.required && list.empty?
        raise Invalid, "pick at least #{f.min}" if f.min&.positive? && list.size < f.min && (f.required || !list.empty?)
        raise Invalid, "pick at most #{f.max}" if f.max && list.size > f.max

        list
      elsif f.single?
        picked = coerce_single(f, value, strict: true)
        raise Invalid, "pick one" if f.required && picked.nil?

        picked
      else
        text = coerce_text(f, value, strict: true).to_s
        raise Invalid, "required" if f.required && text.strip.empty?

        text
      end
    end
  end
end
