# frozen_string_literal: true

module Viewers
  # Unified diffs and patches (git diff, git format-patch, diff -u): Unified
  # and Side by side tabs, parsed in the browser from the file's text at
  # ?data=diff (the one download). The text viewer adds Raw next to them.
  module Diff
    extend Preview::Viewer

    UNIFIED = Preview::View.new(id: "unified", label: "Unified", tip: "Changes in one column")
    SPLIT = Preview::View.new(id: "split", label: "Side by side", tip: "Old and new next to each other")

    def self.icon = "file-earmark-diff"

    # Above text (10), so Unified is the first tab.
    def self.priority = 20

    def self.exts = %w[diff patch]

    def self.views(_target) = [UNIFIED, SPLIT]

    def self.settings = { "diff_view_max_bytes" => 2 * 1024 * 1024 }

    def self.max_bytes_key = "diff_view_max_bytes"

    def self.data(ctx) = ctx.send_file(type: "text/plain; charset=utf-8")
  end
end
