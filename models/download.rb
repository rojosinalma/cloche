# frozen_string_literal: true

class Download < Sequel::Model(:downloads)
  many_to_one :share, key: :share_id

  def before_create
    self.created_at ||= Time.now
    super
  end
end
