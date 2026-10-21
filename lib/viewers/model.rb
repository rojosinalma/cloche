# frozen_string_literal: true

module Viewers
  # 3D models (STL/3MF/OBJ), parsed in the browser by three.js from the bytes
  # at ?data=model; that fetch is the one download. The extension wins, so an
  # ASCII STL is a model, not text.
  module Model
    extend Preview::Viewer

    LABELS = { "stl" => "STL", "3mf" => "3MF", "obj" => "OBJ" }.freeze

    def self.label = "3D"

    def self.icon = "box"

    def self.priority = 50

    def self.exts = LABELS.keys

    def self.binary? = true

    def self.views(_target) = [Preview::View.new(id: "model", label: "3D")]

    def self.settings = { "model_view_max_bytes" => 100 * 1024 * 1024 }

    def self.max_bytes_key = "model_view_max_bytes"

    def self.data(ctx) = ctx.send_file
  end
end
