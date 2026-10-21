# frozen_string_literal: true

module Viewers
  # Mermaid (.mmd, .mermaid) and Graphviz (.dot, .gv) sources, drawn in the
  # browser: Mermaid with securityLevel "strict", Graphviz with the viz.js
  # WebAssembly build, both loaded from jsDelivr at pinned versions. The
  # text viewer adds the source as Raw. The same module draws ```mermaid and
  # ```dot blocks in rendered Markdown (TextView marks them data-enhance).
  module Diagram
    extend Preview::Viewer

    DIAGRAM = Preview::View.new(id: "diagram", label: "Diagram", tip: "The drawn diagram")

    def self.icon = "diagram-3"

    def self.priority = 20

    def self.exts = %w[mmd mermaid dot gv]

    def self.views(_target) = [DIAGRAM]

    def self.settings = { "diagram_view_max_bytes" => 1024 * 1024 }

    def self.max_bytes_key = "diagram_view_max_bytes"

    # The source as plain text; the module draws it. Counts once.
    def self.data(ctx)
      return ctx.html("This file is above the viewer limit.", status: 413) if ctx.too_large?

      ctx.send_file(csp: "sandbox", type: "text/plain; charset=utf-8")
    end
  end
end
