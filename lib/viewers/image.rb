# frozen_string_literal: true

module Viewers
  # Images, shown as they are. The browser loads them from ?preview=1, which
  # does not count (the gallery thumbnails use the same URL).
  module Image
    extend Preview::Viewer

    def self.icon = "file-earmark-image"

    def self.priority = 50

    def self.exts = %w[png jpg jpeg gif webp svg avif bmp ico]

    def self.binary? = true

    def self.src(link) = "#{link}?preview=1"
  end
end
