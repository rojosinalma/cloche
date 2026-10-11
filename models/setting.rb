# frozen_string_literal: true

require "socket"

class Setting < Sequel::Model(:settings)
  unrestrict_primary_key

  def self.defaults
    home = ENV.fetch("HOST_HOME", Dir.home)
    {
      "allowed_roots" => [File.join(home, "dev"), File.join(home, "data"), File.join(home, ".opencode", "plan")].join(","),
      "idle_timeout" => "1800",
      "public_base_url" => "https://cloche.example.com",
      "lan_base_url" => "https://cloche.example.internal",
      "result_retention" => "86400",
      "opencode_url" => "http://192.168.1.20:4096",
      "callback_pool_size" => "2",
      "callback_queue_size" => "100",
      "callback_mode" => "instruction",
      "callback_entry_key" => "cloche",
      "callback_history" => "3",
      "wait_max_timeout" => "300",
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
      "instance_name" => ENV.fetch("HOSTNAME") { Socket.gethostname }
    }
  end

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

  def self.seed_defaults!
    defaults.each { |key, value| dataset.insert_conflict(:ignore).insert(key: key, value: value) }
  end

  def self.cast(value, default)
    case default
    when Integer then Integer(value, 10)
    when Float then Float(value)
    when true, false then value == "true"
    when Array then value.split(",").map(&:strip).reject(&:empty?)
    else value
    end
  rescue ArgumentError, TypeError
    $log.warn "[settings] invalid value #{value.inspect}, using default #{default.inspect}"
    default
  end
end
