# frozen_string_literal: true

module Viewers
  # Terminal output with ANSI escapes (build logs, test runs, ANSI art): a
  # Coloured tab, drawn in the browser from the file's text at ?data=ansi (the
  # one download), next to the text viewer's Raw. .ansi files always match;
  # any other text file matches when its first ansi_view_sniff_bytes hold an
  # escape sequence (ESC [), so a log without colours keeps Raw alone.
  module Ansi
    extend Preview::Viewer

    COLOURED = Preview::View.new(id: "coloured", label: "Coloured", tip: "Terminal colours and styles")
    CSI = "\e[".b.freeze

    def self.label = "ANSI"

    def self.icon = "terminal"

    # Above text (10), so Coloured is the first tab.
    def self.priority = 20

    def self.exts = %w[ansi]

    def self.match?(target) = target.ext == "ansi" || (target.text? && escapes?(target.path))

    def self.escapes?(path)
      File.open(path, "rb") { |f| f.read(Setting.get("ansi_view_sniff_bytes")).to_s.include?(CSI) }
    rescue SystemCallError
      false
    end

    def self.views(_target) = [COLOURED]

    def self.settings = { "ansi_view_max_bytes" => 2 * 1024 * 1024, "ansi_view_sniff_bytes" => 4096 }

    def self.max_bytes_key = "ansi_view_max_bytes"

    def self.data(ctx) = ctx.send_file(type: "text/plain; charset=utf-8")
  end
end
