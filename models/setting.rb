# frozen_string_literal: true

class Setting < Sequel::Model(:settings)
  unrestrict_primary_key

  def self.defaults
    home = ENV.fetch("HOST_HOME", Dir.home)
    {
      "allowed_roots" => [File.join(home, "dev"), File.join(home, "tiny"), File.join(home, ".opencode", "plan")].join(","),
      "idle_timeout" => "1800",
      "public_base_url" => "https://cloche.rojo.dev",
      "lan_base_url" => "https://cloche.silver.local",
      "result_retention" => "86400",
      "opencode_url" => "http://10.10.10.20:4096",
      "callback_pool_size" => "2",
      "callback_queue_size" => "100",
      "wait_max_timeout" => "300"
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
