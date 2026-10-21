# frozen_string_literal: true

require "strscan"

module Viewers
  # Maps: GeoJSON, GPX and KML drawn with Leaflet over map tiles. The browser
  # fetches the file's bytes from ?data=geo (the one download) and converts
  # GPX/KML itself, so no XML is parsed on the server. A .json file is a map
  # only when its top-level "type" is a GeoJSON type, read from a bounded
  # prefix. The text viewer adds Raw (and Pretty for .json) to the same file.
  module Geo
    extend Preview::Viewer

    MAP = Preview::View.new(id: "map", label: "Map", tip: "The shapes on a map")
    TYPES = %w[FeatureCollection Feature GeometryCollection Point MultiPoint LineString MultiLineString
               Polygon MultiPolygon].freeze
    OSM_TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
    OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    STRING = /"(?>[^"\\]+|\\.)*"/m

    def self.label = "Map"

    def self.icon = "map"

    def self.priority = 30

    def self.exts = %w[geojson gpx kml]

    def self.views(_target) = [MAP]

    def self.settings
      { "geo_view_max_bytes" => 20 * 1024 * 1024, "geo_view_max_features" => 10_000, "geo_view_max_points" => 200_000,
        "geo_view_sniff_bytes" => 8192, "geo_view_tile_url" => OSM_TILES, "geo_view_tile_attribution" => OSM_ATTRIBUTION,
        "geo_view_tile_max_zoom" => 19 }
    end

    def self.max_bytes_key = "geo_view_max_bytes"

    def self.match?(target) = exts.include?(target.ext) || (target.ext == "json" && geojson?(target.path))

    def self.data(ctx) = ctx.send_file

    def self.geojson?(path)
      chunk = File.binread(path, Setting.get("geo_view_sniff_bytes")) || "".b
      TYPES.include?(top_level_type(chunk.delete_prefix(TextView::UTF8_BOM)))
    rescue SystemCallError
      false
    end

    # The string value of the root object's "type" key, nil when the chunk
    # is not an object or the key does not come within it. Walks the tokens
    # only far enough to tell keys of the root object from nested ones.
    def self.top_level_type(chunk)
      s = StringScanner.new(chunk)
      s.skip(/\s*/)
      return nil unless s.skip(/\{/)

      depth = 1
      key_next = true
      until s.eos?
        if s.skip(/\s+/) then next
        elsif (str = s.scan(STRING))
          if depth == 1 && key_next && str == '"type"'
            s.skip(/\s*:\s*/)
            value = s.scan(STRING) or return nil
            return value[1...-1]
          end
          key_next = false
        elsif s.skip(/[{\[]/) then depth += 1
        elsif s.skip(/[}\]]/)
          depth -= 1
          return nil if depth.zero?
        elsif s.skip(/,/) then key_next = true
        elsif s.skip(/"/) then return nil # a string cut off by the end of the chunk
        else
          s.skip(/[^\s"{}\[\],]+/)
          key_next = false
        end
      end
      nil
    end
  end
end
