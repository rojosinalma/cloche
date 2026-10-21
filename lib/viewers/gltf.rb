# frozen_string_literal: true

module Viewers
  # glTF 2.0 scenes (.glb, and .gltf with its buffers and textures) in the 3D
  # view, parsed in the browser by three.js. ?data=gltf is the file itself
  # (the one download); ?data=gltf&part=<uri> is a resource the .gltf names,
  # resolved next to the file through PathGuard, so only files of the same
  # share are ever served and none of them counts.
  module Gltf
    extend Preview::Viewer

    def self.label = "glTF"

    def self.icon = "box"

    def self.priority = 50

    def self.exts = %w[glb gltf]

    def self.binary? = true

    def self.views(_target) = [Preview::View.new(id: "model", label: "3D")]

    def self.settings = { "gltf_view_max_bytes" => 100 * 1024 * 1024 }

    def self.max_bytes_key = "gltf_view_max_bytes"

    def self.data(ctx)
      return ctx.send_file if ctx.part.nil?

      real = resource(ctx) or ctx.not_found!
      ctx.send_file(path: real, count: false)
    end

    # The part is a relative URI from the .gltf; it resolves against the
    # folder of the file inside the share entry, never outside it.
    def self.resource(ctx)
      part = ctx.part
      return if part.start_with?("/") || part.include?("\0") || part.match?(/\A[a-z][a-z0-9+.-]*:/i)

      entry = ctx.share.entries[ctx.index] or return
      dir = File.dirname(ctx.rel.to_s)
      rel = dir == "." || ctx.rel.to_s.empty? ? part : File.join(dir, part)
      real = PathGuard.resolve(entry, rel)
      real if real && File.file?(real)
    end
  end
end
