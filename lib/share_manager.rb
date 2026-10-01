# frozen_string_literal: true

require "json"
require "securerandom"

module ShareManager
  class ValidationError < StandardError; end

  SESSION_ID_FORMAT = /\A[\w-]+\z/
  TITLE_MAX = 200

  module_function

  def create(paths:, title: nil, raw: false, session: nil)
    reals = validated_paths(paths)
    raw = truthy?(raw)
    raise ValidationError, "raw takes exactly one folder" if raw && !(reals.size == 1 && File.directory?(reals.first))

    session_id, session_dir = validated_session(session)
    now = Time.now
    share = Share.create(
      id: SecureRandom.urlsafe_base64(24), title: title_for(title, reals), raw: raw,
      paths: JSON.generate(reals), session_id: session_id, session_directory: session_dir,
      started_at: now, last_activity_at: now
    )
    $log.info "[share] created #{share.id} \"#{share.title}\" (#{reals.size} path(s)#{', raw' if raw}" \
              "#{", session #{session_id}" if session_id})"
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
      downloads: files.size, files: files.tally, session: session_of(share)
    }
  end

  def summary(share)
    data = {
      id: share.id, title: share.title, url: url(share), lan_url: lan_url(share), raw: share.raw,
      paths: share.paths_list, live: share.live?, started_at: iso(share.started_at),
      last_activity_at: iso(share.last_activity_at), idle_timeout: idle_timeout,
      downloads: share.downloads_dataset.count
    }
    data.merge!(ended_at: iso(share.ended_at), reason: share.end_reason) if share.ended?
    data
  end

  def detail(share)
    downloads = share.downloads_dataset.order(:id).map { |d| { name: d.name, ip: d.ip, at: iso(d.created_at) } }
    data = { share: summary(share), downloads: downloads }
    data[:result] = result(share) if share.ended?
    data
  end

  def list
    (live.all + recent.all).sort_by(&:started_at).reverse.map { |share| summary(share) }
  end

  def url(share) = "#{base_url('public_base_url')}/s/#{share.id}/"

  def lan_url(share) = "#{base_url('lan_base_url')}/s/#{share.id}/"

  def live = Share.where(ended_at: nil)

  def recent = Share.exclude(ended_at: nil).where(Sequel[:ended_at] > retention_cutoff)

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

  def wait(share, timeout:)
    limit = wait_limit(timeout)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + limit
    loop do
      share.refresh
      return result(share) if share.ended?
      return nil if Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline

      sleep 1
    end
  rescue Sequel::NoExistingObject
    nil
  end

  def idle_timeout = Setting.fetch("idle_timeout", 1800)

  def idle_label = Listing.human_duration(idle_timeout)

  def expires_at(share) = share.last_activity_at + idle_timeout

  def status(share)
    return { live: false, reason: share.end_reason } if share.ended?

    { live: true, expires_at: iso(expires_at(share)), seconds_left: [(expires_at(share) - Time.now).to_i, 0].max,
      in_flight: IdleSweeper.in_flight?(share.id) }
  end

  def validated_paths(paths)
    list = Array(paths).map(&:to_s).map(&:strip).reject(&:empty?)
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

  def title_for(title, reals)
    given = title.to_s.strip
    return given[0, TITLE_MAX] unless given.empty?

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
