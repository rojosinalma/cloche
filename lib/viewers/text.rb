# frozen_string_literal: true

module Viewers
  # Any text file: Raw (line-numbered, highlighted source) for all of them,
  # plus Pretty for Markdown, JSON, JSON Lines and CSV/TSV. The rendering is
  # TextView's; this module only plugs it into the preview modal.
  module Text
    extend Preview::Viewer

    PRETTY = Preview::View.new(id: "pretty", label: "Pretty", tip: "Rendered view")
    SOURCE = Preview::View.new(id: "source", label: "Raw", tip: "Exact file content")

    def self.icon = "file-earmark-text"

    def self.priority = 10

    def self.settings
      { "text_view_max_bytes" => 2 * 1024 * 1024, "text_view_max_rows" => 500, "text_view_sniff_bytes" => 8192 }
    end

    def self.max_bytes_key = "text_view_max_bytes"

    def self.match?(target) = target.text?

    # Pretty is offered by extension; the fetched card drops it again when
    # the content does not parse (the client hides the tab then).
    def self.views(target) = TextView::FORMATS.key?(".#{target.ext}") ? [PRETTY, SOURCE] : [SOURCE]

    # The rendered card is the one download of the file; switching tabs and
    # Copy are client-side and add nothing.
    def self.data(ctx)
      view = TextView.build(ctx.real, name: File.basename(ctx.real), share: ctx.share, index: ctx.index, rel: ctx.rel)
      ctx.html(ctx.render("text_card", view: view, download_href: ctx.download_href), count: !view.too_large?)
    end
  end
end
