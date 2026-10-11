# frozen_string_literal: true

require "json"
require "securerandom"

module ShareManager
  class ValidationError < StandardError; end
  class AlreadyEnded < StandardError; end

  SESSION_ID_FORMAT = /\A[\w-]+\z/
  TITLE_MAX = 200

  module_function

  def create(paths: nil, title: nil, raw: false, session: nil, idle_timeout: nil, form: nil)
    spec = validated_form(form)
    reals = validated_paths(paths, optional: !spec.nil?)
    raw = truthy?(raw)
    raise ValidationError, "raw and form are mutually exclusive" if raw && spec
    raise ValidationError, "raw takes exactly one folder" if raw && !(reals.size == 1 && File.directory?(reals.first))

    session_id, session_dir = validated_session(session)
    limit = validated_idle_timeout(idle_timeout)
    now = Time.now
    share = Share.create(
      id: SecureRandom.urlsafe_base64(24), title: title_for(title, reals, form: spec), raw: raw,
      paths: JSON.generate(reals), session_id: session_id, session_directory: session_dir,
      idle_timeout: limit, started_at: now, last_activity_at: now,
      form: spec&.to_json, draft: spec && JSON.generate(spec.defaults), submissions: 0
    )
    $log.info "[share] created #{share.id} \"#{share.title}\" (#{reals.size} path(s)#{', raw' if raw}" \
              "#{", form with #{spec.fields.size} field(s)" if spec}" \
              "#{", session #{session_id}" if session_id}#{", idle #{idle_label(share)}" if limit})"
    share
  end

  def save_draft(share, raw)
    raise AlreadyEnded, "Share has already ended (#{share.end_reason})" if share.ended?

    draft = Form::Answers.draft(share.form_spec, raw)
    now = Time.now
    changed = Share.where(id: share.id, ended_at: nil)
                   .update(draft: JSON.generate(draft), draft_saved_at: now, last_activity_at: now)
    share.refresh
    raise AlreadyEnded, "Share has already ended (#{share.end_reason})" if changed.zero?

    now
  end

  def submit(share, raw)
    raise AlreadyEnded, "Share has already ended (#{share.end_reason})" if share.ended?

    answers, errors = Form::Answers.submit(share.form_spec, raw)
    raise Form::Invalid.new("Some answers are invalid", errors) unless errors.empty?

    now = Time.now
    json = JSON.generate(answers)
    changed = Share.where(id: share.id, ended_at: nil)
                   .update(answers: json, draft: json, submitted_at: now, draft_saved_at: now, last_activity_at: now,
                           submissions: Sequel[:submissions] + 1)
    share.refresh
    raise AlreadyEnded, "Share has already ended (#{share.end_reason})" if changed.zero?

    $log.info "[share] #{share.id} answers submitted (##{share.submissions})"
    Callback.deliver(share, event: :submitted) if share.session_id
    share
  end

  def update(share, idle_timeout:)
    raise ValidationError, "idle_timeout is required" if idle_timeout.nil? || idle_timeout.to_s.strip.empty?

    limit = validated_idle_timeout(idle_timeout)
    now = Time.now
    changed = Share.where(id: share.id, ended_at: nil).update(idle_timeout: limit, last_activity_at: now)
    share.refresh
    raise AlreadyEnded, "Share has already ended (#{share.end_reason})" if changed.zero?

    $log.info "[share] #{share.id} idle timeout set to #{idle_label(share)}"
    share
  end

  def stop(share, reason)
    now = Time.now
    ended = Share.where(id: share.id, ended_at: nil).update(ended_at: now, end_reason: reason)
    share.refresh
    return share if ended.zero?

    $log.info "[share] #{share.id} ended: #{reason}"
    Callback.deliver(share) if share.session_id
    share
  end

  def result(share)
    files = share.downloads_dataset.order(:id).select_map(:name)
    seconds = ((share.ended_at || Time.now) - share.started_at).to_i
    {
      id: share.id, title: share.title, paths: share.paths_list, raw: share.raw,
      url: url(share), lan_url: lan_url(share), reason: share.end_reason,
      started_at: iso(share.started_at), ended_at: iso(share.ended_at),
      duration: Listing.human_duration(seconds), duration_seconds: seconds,
      idle_timeout: share.effective_idle_timeout, instance: instance_name,
      downloads: files.size, files: files.tally, session: session_of(share)
    }.merge(form_result(share))
  end

  # Answers are what was submitted; the draft is only reported when it differs,
  # so a pick the user never submitted before the share ended is not lost.
  def form_result(share)
    return {} unless share.form?

    data = { form: { fields: share.form_spec.fields.map { |f| form_field_summary(f) } },
             answers: share.submitted? ? share.answers_hash : nil,
             submissions: share.submissions.to_i, submitted_at: iso(share.submitted_at) }
    data[:draft] = share.draft_hash if share.draft_hash != share.answers_hash
    data
  end

  def form_field_summary(field)
    data = { id: field.id, type: field.type, label: field.label }
    options = Array(field.options)
    data[:options] = options.map { |o| { value: o.value, label: o.label } } unless options.empty?
    data
  end

  def summary(share)
    data = {
      id: share.id, title: share.title, url: url(share), lan_url: lan_url(share), raw: share.raw,
      paths: share.paths_list, live: share.live?, started_at: iso(share.started_at),
      last_activity_at: iso(share.last_activity_at), idle_timeout: share.effective_idle_timeout,
      permanent: share.permanent?, expires_at: share.live? ? iso(expires_at(share)) : nil,
      downloads: share.downloads_dataset.count, instance: instance_name,
      form: share.form?, submissions: share.submissions.to_i, submitted_at: iso(share.submitted_at)
    }
    data.merge!(ended_at: iso(share.ended_at), reason: share.end_reason) if share.ended?
    data
  end

  def detail(share)
    downloads = share.downloads_dataset.order(:id).map { |d| { name: d.name, ip: d.ip, at: iso(d.created_at) } }
    data = { share: summary(share), downloads: downloads }
    if share.form?
      data.merge!(form: share.form_spec.to_h, draft: share.draft_hash,
                  answers: share.submitted? ? share.answers_hash : nil)
    end
    data[:result] = result(share) if share.ended?
    data
  end

  def instance_name = Setting.fetch("instance_name", Setting.defaults["instance_name"])

  def list
    (live.all + recent.all).sort_by(&:started_at).reverse.map { |share| summary(share) }
  end

  def url(share) = "#{base_url('public_base_url')}/s/#{share.id}/"

  def lan_url(share) = "#{base_url('lan_base_url')}/s/#{share.id}/"

  def live = Share.where(ended_at: nil)

  def recent = Share.exclude(ended_at: nil).where(Sequel[:ended_at] > retention_cutoff)

  # What a session's callback entry lists: its recently ended shares plus its
  # live form shares that have been submitted at least once, newest activity first.
  def session_history(session_id, limit:)
    ended = recent.where(session_id: session_id).all
    submitted = live.where(session_id: session_id).where { submissions > 0 }.all
    (ended + submitted).sort_by { |s| s.ended_at || s.submitted_at || s.started_at }.reverse.first(limit)
                       .map { |s| history_item(s) }
  end

  def history_item(share)
    keys = %i[id title paths url live reason ended_at duration files instance submissions submitted_at answers draft]
    result(share).merge(live: share.live?).slice(*keys).compact
  end

  def purge_expired!
    ids = Share.exclude(ended_at: nil).where(Sequel[:ended_at] < retention_cutoff).select_map(:id)
    return 0 if ids.empty?

    DB.transaction do
      Download.where(share_id: ids).delete
      Share.where(id: ids).delete
    end
    $log.info "[share] purged #{ids.size} expired share(s)"
    ids.size
  end

  # Blocks until the share ends, a submission newer than `since` (a submission
  # count the caller has already seen) lands, or the timeout passes.
  def wait(share, timeout:, since: 0)
    limit = wait_limit(timeout)
    seen = wait_since(since)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + limit
    loop do
      share.refresh
      return { ended: true, result: result(share) } if share.ended?
      if share.submissions.to_i > seen
        return { ended: false, submitted: true, submissions: share.submissions, submitted_at: iso(share.submitted_at),
                 answers: share.answers_hash }
      end
      return { ended: false, submitted: false } if Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline

      sleep 1
    end
  rescue Sequel::NoExistingObject
    { ended: true, result: nil }
  end

  def wait_since(value)
    return 0 if value.nil? || value.to_s.strip.empty?

    Integer(value.to_s.strip, 10).tap { |n| raise ArgumentError if n.negative? }
  rescue ArgumentError
    raise ValidationError, "since must be a non-negative integer (the submission count already seen)"
  end

  def idle_label(share)
    share.permanent? ? "never" : Listing.human_duration(share.effective_idle_timeout)
  end

  def expires_at(share)
    share.last_activity_at + share.effective_idle_timeout unless share.permanent?
  end

  def status(share)
    return { live: false, reason: share.end_reason } if share.ended?

    data = { live: true, permanent: share.permanent?, in_flight: IdleSweeper.in_flight?(share.id) }
    if share.form?
      data.merge!(submissions: share.submissions.to_i, submitted_at: iso(share.submitted_at),
                  draft_saved_at: iso(share.draft_saved_at))
    end
    return data if share.permanent?

    data.merge(expires_at: iso(expires_at(share)), seconds_left: [(expires_at(share) - Time.now).to_i, 0].max)
  end

  def validated_idle_timeout(value)
    return nil if value.nil? || value.to_s.strip.empty?
    return 0 if %w[never none keep].include?(value.to_s.strip.downcase)

    seconds = value.is_a?(Integer) ? value : Integer(value.to_s.strip, 10)
    raise ValidationError, "idle_timeout must be a non-negative integer of seconds (0 = never)" if seconds.negative?

    seconds
  rescue ArgumentError, TypeError
    raise ValidationError, "idle_timeout must be a non-negative integer of seconds (0 = never)"
  end

  def validated_form(form)
    return nil if form.nil? || form == ""

    Form::Spec.parse(form)
  rescue Form::Invalid => e
    raise ValidationError, "form: #{e.message}"
  end

  def validated_paths(paths, optional: false)
    list = Array(paths).map(&:to_s).map(&:strip).reject(&:empty?)
    return [] if list.empty? && optional
    raise ValidationError, "paths must be a non-empty array of absolute paths" if list.empty?

    PathGuard.validate_paths(list).uniq
  rescue PathGuard::Denied => e
    raise ValidationError, e.message
  end

  def validated_session(session)
    return [nil, nil] if session.nil? || session == ""
    raise ValidationError, "session must be an object {id, directory?}" unless session.is_a?(Hash)

    id = (session["id"] || session[:id]).to_s.strip
    dir = (session["directory"] || session[:directory]).to_s.strip
    raise ValidationError, "session.id is missing or malformed" unless id.match?(SESSION_ID_FORMAT)
    raise ValidationError, "session.directory must be an absolute path" unless dir.empty? || dir.start_with?("/")

    [id, dir.empty? ? nil : dir]
  end

  def title_for(title, reals, form: nil)
    given = title.to_s.strip
    return given[0, TITLE_MAX] unless given.empty?
    return "Questions" if form && reals.empty?

    reals.size == 1 ? File.basename(reals.first) : "#{reals.size} items"
  end

  def truthy?(value) = value == true || %w[true 1 yes on].include?(value.to_s.downcase)

  def session_of(share)
    { id: share.session_id, directory: share.session_directory } if share.session_id
  end

  def wait_limit(timeout)
    max = Setting.fetch("wait_max_timeout", 300)
    return max if timeout.nil? || timeout.to_s.strip.empty?

    Integer(timeout.to_s, 10).clamp(0, max)
  rescue ArgumentError
    max
  end

  def retention_cutoff = Time.now - Setting.fetch("result_retention", 86_400)

  def base_url(key) = Setting.fetch(key, Setting.defaults[key]).chomp("/")

  def iso(time) = time&.getutc&.iso8601
end
