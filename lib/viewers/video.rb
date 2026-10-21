# frozen_string_literal: true

module Viewers
  # Video in the browser's player, from the uncounted ?preview=1 URL.
  module Video
    extend Preview::Viewer

    def self.icon = "file-earmark-play"

    def self.priority = 50

    def self.exts = %w[mp4 webm ogv m4v mov]

    def self.binary? = true

    def self.src(link) = "#{link}?preview=1"
  end
end
