# frozen_string_literal: true

require "socket"

class Setting < Sequel::Model(:settings)
  unrestrict_primary_key

  class Invalid < StandardError; end
  class UnknownKey < Invalid; end

  INTEGER_KEYS = %w[
    idle_timeout result_retention callback_pool_size callback_queue_size callback_history wait_max_timeout
    callback_open_timeout callback_read_timeout text_view_max_bytes text_view_max_rows text_view_sniff_bytes
    model_view_max_bytes form_max_fields form_max_options form_text_max_chars form_max_bytes form_bulk_threshold
    form_idle_timeout external_link_default_ttl external_link_max_ttl external_link_max_live
  ].freeze
  BOOLEAN_KEYS = %w[mcp_debug external_links_enabled].freeze
  LIST_KEYS = %w[allowed_roots].freeze

  # Defaults are seeded into the settings table on first boot only
  # (seed_defaults! ignores existing rows), so the CLOCHE_ROOTS, PUBLIC_BASE_URL,
  # LAN_BASE_URL and OPENCODE_URL env vars act as first-boot seeds: once a row
  # exists it is the DB value that counts, editable through the settings API.
  def self.defaults
    @defaults ||= begin
      home = ENV.fetch("HOST_HOME", Dir.home)
      public_url = url_env("PUBLIC_BASE_URL", "http://localhost:9292")
      {
        "allowed_roots" => ENV.fetch("CLOCHE_ROOTS") { home }.split(",").map(&:strip).reject(&:empty?).join(","),
        "idle_timeout" => "1800",
        "public_base_url" => public_url,
        "lan_base_url" => url_env("LAN_BASE_URL", public_url),
        "result_retention" => "86400",
        "opencode_url" => url_env("OPENCODE_URL", "http://host.docker.internal:4096"),
        "callback_pool_size" => "2",
        "callback_queue_size" => "100",
        "callback_mode" => "instruction",
        "callback_entry_key" => "cloche",
        "callback_history" => "3",
        "callback_open_timeout" => "5",
        "callback_read_timeout" => "15",
        "wait_max_timeout" => "300",
        "mcp_debug" => "false",
        "text_view_max_bytes" => (2 * 1024 * 1024).to_s,
        "text_view_max_rows" => "500",
        "text_view_sniff_bytes" => "8192",
        "model_view_max_bytes" => (100 * 1024 * 1024).to_s,
        "form_max_fields" => "50",
        "form_max_options" => "1000",
        "form_text_max_chars" => "4000",
        "form_max_bytes" => (512 * 1024).to_s,
        "form_bulk_threshold" => "8",
        "form_idle_timeout" => "86400",
        "external_links_enabled" => "true",
        "external_link_default_ttl" => "86400",
        "external_link_max_ttl" => "0",
        "external_link_max_live" => "20",
        "instance_name" => ENV.fetch("HOSTNAME") { Socket.gethostname }
      }.freeze
    end
  end

  def self.url_env(name, fallback)
    value = ENV[name].to_s.strip
    (value.empty? ? fallback : value).sub(%r{/+\z}, "")
  end

  def self.known?(key) = defaults.key?(key.to_s)

  # The default of a key, cast to its type (Integer, true/false, Array or String).
  def self.typed_default(key)
    key = key.to_s
    raise UnknownKey, "Unknown setting #{key}" unless known?(key)

    cast!(defaults[key], type_of(key))
  end

  def self.type_of(key)
    if INTEGER_KEYS.include?(key) then 0
    elsif BOOLEAN_KEYS.include?(key) then false
    elsif LIST_KEYS.include?(key) then []
    else ""
    end
  end

  # Typed value of a seeded key: the stored row cast to the default's type,
  # falling back to the default itself.
  def self.get(key) = fetch(key, typed_default(key))

  # Values are stored as text and cast to the type of the given default.
  def self.fetch(key, default = nil)
    row = self[key.to_s]
    return default if row.nil? || row.value.nil?

    cast(row.value, default)
  end

  def self.set(key, value)
    stored = value.is_a?(Array) ? value.join(",") : value.to_s
    dataset.insert_conflict(:replace).insert(key: key.to_s, value: stored)
    stored
  end

  # Validated write for the settings API: the key must be seeded and the value
  # must cast to the key's type. Returns the stored string.
  def self.update!(key, value)
    key = key.to_s
    raise UnknownKey, "Unknown setting #{key}" unless known?(key)
    raise Invalid, "Setting #{key} needs a value (DELETE it to reset to the default)" if value.nil?

    stored = value.is_a?(Array) ? value.join(",") : value.to_s.strip
    cast!(stored, type_of(key))
    set(key, stored)
  rescue ArgumentError, TypeError => e
    raise Invalid, "Invalid value for #{key}: #{e.message}"
  end

  # Drop the row so the default (or a first-boot seed on the next boot) applies.
  def self.reset!(key)
    key = key.to_s
    raise UnknownKey, "Unknown setting #{key}" unless known?(key)

    where(key: key).delete
    defaults[key]
  end

  # One entry per seeded key for the settings API, values as stored strings.
  def self.listing
    rows = dataset.to_hash(:key, :value)
    defaults.map do |key, default|
      stored = rows[key]
      { key: key, value: stored.nil? ? default : stored, default: default, source: stored.nil? ? "default" : "db" }
    end
  end

  def self.seed_defaults!
    defaults.each { |key, value| dataset.insert_conflict(:ignore).insert(key: key, value: value) }
  end

  def self.cast(value, default)
    cast!(value, default)
  rescue ArgumentError, TypeError
    $log.warn "[settings] invalid value #{value.inspect}, using default #{default.inspect}"
    default
  end

  def self.cast!(value, default)
    case default
    when Integer then Integer(value, 10)
    when Float then Float(value)
    when true, false then boolean!(value)
    when Array then value.split(",").map(&:strip).reject(&:empty?)
    else value
    end
  end

  def self.boolean!(value)
    case value.to_s.strip.downcase
    when "true", "1", "yes", "on" then true
    when "false", "0", "no", "off" then false
    else raise ArgumentError, "expected true or false, got #{value.inspect}"
    end
  end
end
