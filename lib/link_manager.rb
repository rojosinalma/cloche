# frozen_string_literal: true

require "securerandom"

# External links: revocable, expiring keys to a file or raw share under
# /x/<token>/, for people who cannot pass the access gate in front of /s/<id>/.
module LinkManager
  # status is the HTTP status the routes answer with.
  class Error < StandardError
    attr_reader :status

    def initialize(message, status = 422)
      super(message)
      @status = status
    end
  end

  TOKEN_BYTES = 32
  TOKEN_FORMAT = /\A[A-Za-z0-9_-]{20,64}\z/
  # Picker presets for the share page; the API takes any number of seconds.
  PRESETS = [3600, 86_400, 604_800, 2_592_000, 0].freeze
  NAMED_TTLS = { "1h" => 3600, "24h" => 86_400, "1d" => 86_400, "7d" => 604_800, "30d" => 2_592_000,
                 "never" => 0, "revoked" => 0 }.freeze

  module_function

  def enabled? = Setting.get("external_links_enabled")

  def create(share, ttl: nil)
    allowed!(share)
    seconds = validated_ttl(ttl)
    cap = Setting.get("external_link_max_live")
    if Link.live.where(share_id: share.id).count >= cap
      raise Error.new("This share already has #{cap} live link(s) (external_link_max_live); revoke one first", 409)
    end

    now = Time.now
    link = Link.create(token: SecureRandom.urlsafe_base64(TOKEN_BYTES), share_id: share.id, created_at: now,
                       expires_at: seconds.zero? ? nil : now + seconds)
    $log.info "[link] #{share.id} link #{link.id} created (#{ttl_label(seconds)})"
    link
  end

  def revoke(share, link_id)
    link = find_for(share, link_id)
    return [link, false] if link.revoked?

    Link.where(id: link.id, revoked_at: nil).update(revoked_at: Time.now)
    link.refresh
    $log.info "[link] #{share.id} link #{link.id} revoked"
    [link, true]
  end

  def find_for(share, link_id)
    id = Integer(link_id.to_s, 10)
    Link.first(id: id, share_id: share.id) or raise Error.new("No link #{link_id} on this share", 404)
  rescue ArgumentError
    raise Error.new("link id must be an integer", 404)
  end

  # The link behind a /x token, or nil when the token is unknown, links are
  # switched off, or the share cannot carry one (form shares never can).
  def find(token)
    return unless enabled? && token.to_s.match?(TOKEN_FORMAT)

    link = Link.first(token: token) or return
    link if link.share && !link.share.form?
  end

  def allowed!(share)
    raise Error.new("External links are switched off (external_links_enabled = false)", 403) unless enabled?
    raise Error.new("Form shares cannot have external links: answers go back to the agent session", 422) if share.form?
    raise Error.new("Share has already ended (#{share.end_reason})", 409) if share.ended?
  end

  # nil/blank = the default; integers are seconds, 0 = until revoked; the
  # cap (external_link_max_ttl, 0 = none) rejects longer and endless links.
  def validated_ttl(value)
    max = Setting.get("external_link_max_ttl")
    if value.nil? || value.to_s.strip.empty?
      default = Setting.get("external_link_default_ttl")
      return max.positive? && (default.zero? || default > max) ? max : default
    end

    seconds = parse_ttl(value)
    if max.positive? && (seconds.zero? || seconds > max)
      raise Error, "ttl #{ttl_label(seconds)} is over the #{ttl_label(max)} cap (external_link_max_ttl)"
    end

    seconds
  end

  def parse_ttl(value)
    named = NAMED_TTLS[value.to_s.strip.downcase]
    return named if named

    seconds = value.is_a?(Integer) ? value : Integer(value.to_s.strip, 10)
    raise ArgumentError if seconds.negative?

    seconds
  rescue ArgumentError, TypeError
    raise Error, "ttl must be seconds (0 = until revoked) or one of #{NAMED_TTLS.keys.join(', ')}"
  end

  # The share page offers the presets the cap allows, plus the default when it is not one.
  def presets
    max = Setting.get("external_link_max_ttl")
    list = PRESETS.select { |s| max.zero? || (s.positive? && s <= max) }
    default = validated_ttl(nil)
    list = (list + [default]).uniq.sort_by { |s| s.zero? ? Float::INFINITY : s } unless list.include?(default)
    { options: list.map { |s| { ttl: s, label: ttl_label(s) } }, default: default }
  end

  def holds?(share) = !Link.live.where(share_id: share.id).empty?

  def live_docs(share) = Link.live.where(share_id: share.id).order(:id).all.map { |l| doc(l, share) }

  def all_docs(share) = Link.where(share_id: share.id).order(:id).all.map { |l| doc(l, share) }

  def doc(link, share = link.share)
    ttl = link.expires_at ? (link.expires_at - link.created_at).round : 0
    {
      id: link.id, url: url(link), state: link.state(share_live: share.live?),
      created_at: iso(link.created_at), expires_at: iso(link.expires_at),
      ttl: ttl, ttl_label: ttl_label(ttl), revoked_at: iso(link.revoked_at),
      downloads: Download.where(link_id: link.id).count
    }
  end

  # The footer status of an external page; never names the share.
  def status(link)
    return { live: false, reason: "link not found" } unless link

    share = link.share
    return { live: false, reason: share.ended? ? "share ended" : "link #{link.state}" } unless link.live? && share.live?

    data = { live: true, permanent: link.expires_at.nil?, in_flight: IdleSweeper.in_flight?(share.id) }
    return data unless link.expires_at

    data.merge(expires_at: iso(link.expires_at), seconds_left: [(link.expires_at - Time.now).to_i, 0].max)
  end

  def base(link) = "/x/#{link.token}"

  def url(link) = "#{Setting.get('public_base_url').chomp('/')}#{base(link)}/"

  def ttl_label(seconds)
    return "until revoked" if seconds.zero?
    return "#{seconds / 86_400} day#{'s' unless seconds == 86_400}" if seconds >= 172_800 && (seconds % 86_400).zero?
    return "#{seconds / 3600} hour#{'s' unless seconds == 3600}" if (seconds % 3600).zero?

    Listing.human_duration(seconds)
  end

  def iso(time) = time&.getutc&.iso8601
end
