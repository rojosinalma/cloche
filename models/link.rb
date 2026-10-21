# frozen_string_literal: true

# An external link: a second, revocable and expiring key to a share's gallery
# under /x/<token>/. The token never reveals the share id.
class Link < Sequel::Model(:links)
  many_to_one :share, key: :share_id

  def self.live(now = Time.now)
    where(revoked_at: nil).where(Sequel.|({ expires_at: nil }, Sequel[:expires_at] > now))
  end

  def revoked? = !revoked_at.nil?

  def expired?(now = Time.now) = !expires_at.nil? && expires_at <= now

  def live?(now = Time.now) = !revoked? && !expired?(now)

  def state(share_live: true)
    if revoked? then "revoked"
    elsif expired? then "expired"
    elsif !share_live then "share ended"
    else "live"
    end
  end
end
