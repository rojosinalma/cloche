# frozen_string_literal: true

require "json"

class Share < Sequel::Model(:shares)
  Entry = Struct.new(:path, :name, :dir)
  TOUCH_THROTTLE = 1

  unrestrict_primary_key
  one_to_many :downloads, key: :share_id

  def paths_list
    JSON.parse(paths.to_s)
  rescue JSON::ParserError
    []
  end

  def entries
    @entries ||= paths_list.map { |p| Entry.new(p, File.basename(p), File.directory?(p)) }
  end

  def single_dir? = entries.size == 1 && entries.first.dir

  def live? = ended_at.nil?

  def ended? = !live?

  # nil column = follow the global setting; 0 = never times out.
  def effective_idle_timeout = idle_timeout.nil? ? Setting.fetch("idle_timeout", 1800) : idle_timeout

  def permanent? = effective_idle_timeout.zero?

  def touch!
    now = Time.now
    return if last_activity_at && now - last_activity_at < TOUCH_THROTTLE

    self.last_activity_at = now
    save_changes
  end

  def refresh
    @entries = nil
    super
  end
end
