# frozen_string_literal: true

require "base64"
require "zlib"

module Viewers
  # Sliced G-code. Toolpath: the moves as lines in three.js, parsed in a Web
  # Worker from ?data=gcode, the one download of the file. Info: the slicer's
  # header comments (slicer, printer, time, filament, temperatures), read here
  # from a bounded head and tail of the file. Source: its first
  # gcode_view_source_bytes. A .gcode.3mf (Bambu Studio, Orca Slicer) is a zip
  # with Metadata/plate_<n>.gcode inside: the browser unzips it for the
  # toolpath, Info and Source read the plate entry here. A file over
  # gcode_view_max_bytes keeps Info and Source and loses only the Toolpath.
  module Gcode
    extend Preview::Viewer

    TOOLPATH = Preview::View.new(id: "toolpath", label: "Toolpath", tip: "Extrusion moves, layer by layer")
    INFO = Preview::View.new(id: "info", label: "Info", tip: "Slicer, printer, time, filament, temperatures")
    SOURCE = Preview::View.new(id: "source", label: "Source", tip: "The G-code as text")

    BUNDLE = ".gcode.3mf"
    PLATE = %r{\AMetadata/plate_(\d+)\.gcode\z}
    SLICERS = /\b(?:BambuStudio|OrcaSlicer|PrusaSlicer|SuperSlicer|Slic3r|Cura_SteamEngine|Simplify3D|ideaMaker|KISSlicer|
                  Creality[\s_]?Print|ElegooSlicer|QIDISlicer|AnycubicSlicer|SnapmakerOrca)\b[^;\s]*(?:\s+v?\d[\w.+-]*)?/ix
    # Bambu Studio and Orca store one bed temperature per plate type.
    BED_TYPES = [[/supertack/, "supertack_plate_temp"], [/textured cool/, "textured_cool_plate_temp"],
                 [/cool/, "cool_plate_temp"], [/engineering/, "eng_plate_temp"], [/textured/, "textured_plate_temp"],
                 [/./, "hot_plate_temp"]].freeze

    def self.label = "G-code"

    def self.icon = "printer"

    # Above the 3D model viewer, so a .gcode.3mf opens on the toolpath.
    def self.priority = 60

    def self.exts = %w[gcode gco]

    # Keeps the text viewer's Raw tab off: Source here reads any size.
    def self.binary? = true

    def self.match?(target) = exts.include?(target.ext) || bundle?(target.basename)

    def self.bundle?(name) = name.downcase.end_with?(BUNDLE)

    def self.views(target) = too_large?(target.size) ? [INFO, SOURCE] : [TOOLPATH, INFO, SOURCE]

    def self.settings
      { "gcode_view_max_bytes" => 100 * 1024 * 1024, "gcode_view_max_moves" => 2_000_000,
        "gcode_view_source_bytes" => 512 * 1024, "gcode_view_info_bytes" => 256 * 1024 }
    end

    def self.too_large?(size) = size > Setting.get("gcode_view_max_bytes")

    # nil: the file (counts once); info / source: JSON from bounded reads.
    def self.data(ctx)
      case ctx.part
      when nil
        return ctx.json({ ok: false, message: "This file is above the toolpath limit." }, count: false) if too_large?(ctx.size)

        ctx.send_file
      when "info" then ctx.json(info(ctx))
      when "source" then ctx.json(source(ctx))
      else ctx.not_found!
      end
    rescue Zip::Error => e
      ctx.json({ ok: false, message: "This 3MF cannot be read: #{e.message}" })
    end

    def self.info(ctx)
      limit = Setting.get("gcode_view_info_bytes")
      max = Setting.get("gcode_view_max_bytes")
      base = { ok: true, size: ctx.size, too_large: ctx.size > max, max_label: Listing.human_size(max),
               max_moves: Setting.get("gcode_view_max_moves") }
      if bundle?(ctx.real)
        entries = Zip.entries(ctx.real)
        plates = plates(entries)
        return no_plate if plates.empty?

        number, entry = pick(plates, ctx.params["plate"])
        text = Zip.read(ctx.real, entry, limit)
        thumb = entries.find { |e| e.name == "Metadata/plate_#{number}.png" && e.size <= limit }
        thumbnail = thumb && data_uri("image/png", Zip.read(ctx.real, thumb, limit))
        base.merge(plates: plates.map(&:first), plate: number, entry: entry.name, gcode_size: entry.size)
            .merge(Header.read(text, limit)).tap { |h| h[:thumbnail] = thumbnail if thumbnail }
      else
        base.merge(plates: [], plate: nil).merge(Header.read(head_tail(ctx.real, limit), limit))
      end
    end

    def self.source(ctx)
      limit = Setting.get("gcode_view_source_bytes")
      if bundle?(ctx.real)
        plates = plates(Zip.entries(ctx.real))
        return no_plate if plates.empty?

        _, entry = pick(plates, ctx.params["plate"])
        total = entry.size
        bytes = Zip.read(ctx.real, entry, limit)
      else
        total = ctx.size
        bytes = File.binread(ctx.real, limit) || +""
      end
      truncated = total > bytes.bytesize
      bytes = bytes.byteslice(0, (bytes.rindex("\n") || bytes.bytesize) + 1) if truncated
      { ok: true, text: utf8(bytes), truncated: truncated, shown_label: Listing.human_size(bytes.bytesize),
        total_label: Listing.human_size(total) }
    end

    def self.no_plate = { ok: false, message: "This 3MF holds no sliced plate (no Metadata/plate_<n>.gcode inside)." }

    def self.plates(entries)
      entries.filter_map { |e| (m = e.name.match(PLATE)) && [m[1].to_i, e] }.sort_by(&:first)
    end

    def self.pick(plates, wanted) = plates.find { |n, _| n.to_s == wanted.to_s } || plates.first

    # The first and the last limit bytes: Cura and Bambu write their header
    # first, PrusaSlicer its settings last.
    def self.head_tail(path, limit)
      File.open(path, "rb") do |f|
        head = f.read(limit) || +""
        next head if f.size <= limit

        f.seek([f.size - limit, limit].max)
        "#{head}\n#{f.read}"
      end
    end

    def self.utf8(bytes) = bytes.dup.force_encoding(Encoding::UTF_8).scrub("")

    def self.data_uri(type, bytes) = "data:#{type};base64,#{Base64.strict_encode64(bytes)}"

    # Slicer header comments → the Info fields, the bed outline and an
    # embedded thumbnail.
    module Header
      module_function

      def read(bytes, limit)
        kv, temps, slicer, thumbs = scan(Gcode.utf8(bytes))
        thumb = thumbs.select { |t| %w[PNG JPG].include?(t[:type]) }.max_by { |t| t[:w] * t[:h] }
        data = thumb && Base64.decode64(thumb[:data])
        { fields: fields(kv, temps, slicer), bed: bed(kv), bed_height: number(first(kv, "printable_height", "max_print_height")),
          thumbnail: data && data.bytesize <= limit ? Gcode.data_uri(thumb[:type] == "PNG" ? "image/png" : "image/jpeg", data) : nil }
      end

      def scan(text)
        kv = {}
        temps = {}
        slicer = nil
        thumbs = []
        thumb = nil
        text.each_line do |raw|
          line = raw.strip
          next if line.empty?

          unless line.start_with?(";")
            temperature(line, temps)
            next
          end
          body = line.sub(/\A;+\s*/, "")
          if thumb && body.match?(/\Athumbnail(_\w+)? end/)
            thumbs << thumb
            thumb = nil
            next
          elsif thumb
            thumb[:data] << body
            next
          end
          if (m = body.match(/\Athumbnail(?:_(\w+))? begin (\d+)x(\d+)/))
            thumb = { type: (m[1] || "PNG").upcase, w: m[2].to_i, h: m[3].to_i, data: +"" }
            next
          end
          slicer ||= body[SLICERS]
          pairs(body).each { |k, v| kv[k] ||= v }
        end
        [kv, temps, slicer, thumbs]
      end

      # "key = value" (Prusa, Bambu config) or "key: value; key: value" (Bambu header, Cura).
      def pairs(body)
        if (m = body.match(/\A([a-z][^=:;]{0,60}?)\s*=\s*(.*)\z/i))
          [[m[1].downcase, unquote(m[2])]]
        else
          body.split(/;\s*/).filter_map do |part|
            (m = part.match(/\A([a-z][^:]{0,60}?)\s*:\s*(.+)\z/i)) && [m[1].downcase, unquote(m[2])]
          end
        end
      end

      def unquote(value) = value.strip.delete_prefix('"').delete_suffix('"')

      def temperature(line, temps)
        m = line.match(/\AM(104|109|140|190)\b[^;]*?\bS(\d+(?:\.\d+)?)/) or return
        temps[%w[104 109].include?(m[1]) ? :nozzle : :bed] ||= m[2] if m[2].to_f.positive?
      end

      def first(kv, *keys) = keys.lazy.map { |k| kv[k] }.find { |v| v && !v.empty? }

      def number(value) = value && value[/-?\d+(?:\.\d+)?/]&.to_f

      def list(value) = value.to_s.split(/[,;]/).map(&:strip).reject(&:empty?).uniq

      def fmt(n) = format("%.2f", n).sub(/\.?0+\z/, "")

      def fields(kv, temps, slicer)
        rows = [
          ["Slicer", slicer], ["Printer", first(kv, "printer_model", "printer_settings_id", "machine_name", "target_machine.name")],
          ["Print profile", first(kv, "print_settings_id")],
          ["Filament", [first(kv, "filament_type"), first(kv, "filament_settings_id")].compact.map { |v| list(v).join(", ") }.uniq.join(" · ")],
          ["Estimated time", time(kv)], ["Filament length", length(kv)], ["Filament weight", weight(kv)],
          ["Layer height", with_first(mm(first(kv, "layer_height", "layer height")),
                                      mm(first(kv, "initial_layer_print_height", "first_layer_height")))],
          ["Layers", first(kv, "total layer number", "layer_count")], ["Height", mm(first(kv, "max_z_height", "maxz"))],
          ["Nozzle", mm(first(kv, "nozzle_diameter"))],
          ["Nozzle temperature", with_first(celsius(first(kv, "nozzle_temperature", "temperature") || temps[:nozzle]),
                                            celsius(first(kv, "nozzle_temperature_initial_layer", "first_layer_temperature")))],
          ["Bed", first(kv, "curr_bed_type")],
          ["Bed temperature", with_first(celsius(bed_temperature(kv, "") || temps[:bed]), celsius(bed_temperature(kv, "_initial_layer")))],
          ["G-code flavour", first(kv, "gcode_flavor", "flavor")]
        ]
        rows.filter_map { |label, value| { label: label, value: value } unless value.to_s.strip.empty? }
      end

      def with_first(value, initial) = value && initial && initial != value ? "#{value} (first layer #{initial})" : value

      def mm(value) = (v = list(value)).empty? ? nil : "#{v.join(', ')} mm"

      def celsius(value) = (v = list(value).reject { |t| t.to_f.zero? }).empty? ? nil : "#{v.join(', ')} °C"

      def bed_temperature(kv, suffix)
        prusa = suffix.empty? ? "bed_temperature" : "first_layer_bed_temperature"
        return kv[prusa] if kv[prusa]

        type = kv["curr_bed_type"].to_s.downcase
        return if type.empty?

        kv["#{BED_TYPES.find { |re, _| type.match?(re) }.last}#{suffix}"]
      end

      def time(kv)
        text = first(kv, "total estimated time", "estimated printing time (normal mode)", "estimated printing time")
        return text if text
        return unless (seconds = number(kv["time"]))

        s = seconds.to_i
        [[s / 86_400, "d"], [s % 86_400 / 3600, "h"], [s % 3600 / 60, "m"], [s % 60, "s"]]
          .drop_while { |n, _| n.zero? }.map { |n, u| "#{n}#{u}" }.join(" ")
      end

      def length(kv)
        if (mm = first(kv, "total filament length [mm]", "filament used [mm]"))
          metres = list(mm).sum(&:to_f) / 1000
        elsif (m = kv["filament used"])
          metres = list(m).sum(&:to_f)
        end
        metres&.positive? ? "#{fmt(metres)} m" : nil
      end

      def weight(kv)
        grams = list(first(kv, "total filament weight [g]", "total filament used [g]", "filament used [g]")).sum(&:to_f)
        grams.positive? ? "#{fmt(grams)} g" : nil
      end

      # "0x0,256x0,256x256,0x256" → [[0, 0], [256, 0], …], nil when absent.
      def bed(kv)
        points = list(first(kv, "printable_area", "bed_shape")).map { |p| p.split("x").map(&:to_f) }
        points.size >= 3 && points.all? { |p| p.size == 2 } ? points : nil
      end
    end

    # The two reads a .gcode.3mf needs: the central directory and the head of
    # one entry (stored or deflated). No ZIP64: slicer bundles stay far below 4 GB.
    module Zip
      class Error < StandardError; end

      Entry = Struct.new(:name, :method, :csize, :size, :offset)
      END_RECORD = 0x06054b50
      CENTRAL = 0x02014b50
      LOCAL = 0x04034b50
      MAX_ENTRIES = 10_000 # far above any slicer bundle; bounds a hostile directory
      CHUNK = 16 * 1024

      module_function

      def entries(path)
        File.open(path, "rb") do |f|
          raise Error, "not a zip archive" if f.size < 22

          back = [f.size, 22 + 65_535].min
          f.seek(f.size - back)
          tail = f.read(back)
          at = tail.rindex([END_RECORD].pack("V")) or raise Error, "not a zip archive"
          count, dir_size, dir_offset = tail.byteslice(at, 22).unpack("@10vVV")
          raise Error, "ZIP64 archives are not supported" if dir_offset == 0xFFFFFFFF || count == 0xFFFF
          raise Error, "more than #{MAX_ENTRIES} entries" if count > MAX_ENTRIES

          f.seek(dir_offset)
          directory(f.read(dir_size) || "", count)
        end
      rescue SystemCallError => e
        raise Error, e.message
      end

      def directory(dir, count)
        pos = 0
        Array.new(count) do
          head = dir.byteslice(pos, 46)
          raise Error, "broken central directory" unless head && head.bytesize == 46 && head.unpack1("V") == CENTRAL

          method, csize, size, name_len, extra_len, comment_len, offset = head.unpack("@10v@20VVvvv@42V")
          name = dir.byteslice(pos + 46, name_len).force_encoding(Encoding::UTF_8)
          pos += 46 + name_len + extra_len + comment_len
          Entry.new(name, method, csize, size, offset)
        end
      end

      # Up to limit bytes of the entry's content.
      def read(path, entry, limit)
        File.open(path, "rb") do |f|
          f.seek(entry.offset)
          signature, name_len, extra_len = (f.read(30) || "").unpack("V@26vv")
          raise Error, "broken entry #{entry.name}" unless signature == LOCAL

          f.seek(entry.offset + 30 + name_len + extra_len)
          case entry.method
          when 0 then f.read([limit, entry.csize].min) || +""
          when 8 then inflate(f, entry.csize, limit)
          else raise Error, "#{entry.name} uses compression method #{entry.method}"
          end
        end
      rescue SystemCallError => e
        raise Error, e.message
      end

      def inflate(io, remaining, limit)
        zstream = Zlib::Inflate.new(-Zlib::MAX_WBITS)
        out = String.new(encoding: Encoding::BINARY)
        while remaining.positive? && out.bytesize < limit
          chunk = io.read([CHUNK, remaining].min) or break
          remaining -= chunk.bytesize
          out << zstream.inflate(chunk)
        end
        out.byteslice(0, limit)
      rescue Zlib::Error => e
        raise Error, "#{e.class.name.split('::').last}: #{e.message}"
      ensure
        zstream&.close
      end
    end
  end
end
