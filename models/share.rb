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

  def form? = !form.to_s.empty?

  def form_spec
    @form_spec ||= Form::Spec.new(JSON.parse(form)) if form?
  end

  def draft_hash = json_hash(draft)

  def answers_hash = json_hash(answers)

  def submitted? = submissions.to_i.positive?

  def live? = ended_at.nil?

  def ended? = !live?

  # nil column = follow the global setting (form shares have their own, longer
  # default since the user may come back to them later); 0 = never times out.
  def effective_idle_timeout
    return idle_timeout unless idle_timeout.nil?

    form? ? Setting.get("form_idle_timeout") : Setting.get("idle_timeout")
  end

  def permanent? = effective_idle_timeout.zero?

  def touch!
    now = Time.now
    return if last_activity_at && now - last_activity_at < TOUCH_THROTTLE

    self.last_activity_at = now
    save_changes
  end

  def refresh
    @entries = nil
    @form_spec = nil
    super
  end

  private

  def json_hash(text)
    return {} if text.to_s.empty?

    data = JSON.parse(text)
    data.is_a?(Hash) ? data : {}
  rescue JSON::ParserError
    {}
  end
end
