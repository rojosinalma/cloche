# frozen_string_literal: true

module Viewers
  # Audio in the browser's player, from the uncounted ?preview=1 URL.
  module Audio
    extend Preview::Viewer

    def self.icon = "file-earmark-music"

    def self.priority = 50

    def self.exts = %w[mp3 ogg oga wav flac m4a opus aac]

    def self.binary? = true

    def self.src(link) = "#{link}?preview=1"
  end
end
