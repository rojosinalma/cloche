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
  # toolpath, Info and Source read the plate entry here. A Prusa binary
  # G-code (.bgcode) is decoded in the browser for the toolpath; Info reads its
  # metadata and thumbnail blocks here, Source decodes the first G-code blocks.
  # A file over gcode_view_max_bytes keeps Info and Source and loses only the
  # Toolpath.
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

    def self.exts = %w[gcode gco bgcode]

    # Keeps the text viewer's Source tab off: this viewer's own Source reads any size.
    def self.binary? = true

    def self.match?(target) = exts.include?(target.ext) || bundle?(target.basename)

    def self.bundle?(name) = name.downcase.end_with?(BUNDLE)

    def self.binary_gcode?(name) = name.downcase.end_with?(".bgcode")

    def self.views(target) = too_large?(target.size) ? [INFO, SOURCE] : [TOOLPATH, INFO, SOURCE]

    def self.settings
      { "gcode_view_max_bytes" => 100 * 1024 * 1024, "gcode_view_max_moves" => 2_000_000,
        "gcode_view_source_bytes" => 512 * 1024, "gcode_view_info_bytes" => 256 * 1024,
        "gcode_view_bgcode_max_bytes" => 200 * 1024 * 1024 }
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
    rescue Bgcode::Error => e
      ctx.json({ ok: false, message: "This binary G-code cannot be read: #{e.message}." })
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
      elsif binary_gcode?(ctx.real)
        base.merge(plates: [], plate: nil, binary: true, bgcode_max_bytes: Setting.get("gcode_view_bgcode_max_bytes"))
            .merge(Bgcode.info(ctx.real, limit))
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
      elsif binary_gcode?(ctx.real)
        bytes, more = Bgcode.gcode_head(ctx.real, limit, Setting.get("gcode_view_bgcode_max_bytes"))
        total = more ? bytes.bytesize + 1 : bytes.bytesize
      else
        total = ctx.size
        bytes = File.binread(ctx.real, limit) || +""
      end
      truncated = total > bytes.bytesize
      bytes = bytes.byteslice(0, (bytes.rindex("\n") || bytes.bytesize) + 1) if truncated
      # A .bgcode has no decoded size until all of it is decoded.
      total_label = binary_gcode?(ctx.real) ? "the decoded G-code" : Listing.human_size(total)
      { ok: true, text: utf8(bytes), truncated: truncated, shown_label: Listing.human_size(bytes.bytesize),
        total_label: total_label }
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
          ["Layers", first(kv, "total layer number", "layer_count")], ["Height", mm(first(kv, "max_z_height", "maxz", "max_layer_z"))],
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

    # Prusa binary G-code (libbgcode format v1): a 10-byte file header (GCDE,
    # version, checksum type), then blocks of header + parameters + data +
    # CRC32. Info reads the metadata and thumbnail blocks before the first
    # G-code block; Source decodes G-code blocks until it has enough text. The
    # browser carries its own decoder for the toolpath (gcode-binary.js).
    module Bgcode
      class Error < StandardError; end

      Block = Struct.new(:type, :method, :size, :offset, :data, :end_at, :crc)
      TYPES = ["file metadata", "G-code", "slicer metadata", "printer metadata", "print metadata", "thumbnail"].freeze
      PARAMS = [2, 2, 2, 2, 2, 6].freeze # bytes of block parameters per type
      COMPRESSION = ["no compression", "Deflate", "Heatshrink 11/4", "Heatshrink 12/4"].freeze
      ENCODING = ["no encoding", "MeatPack", "MeatPack with comments"].freeze
      GCODE = 1
      THUMBNAIL = 5
      IMAGE = { 0 => "image/png", 1 => "image/jpeg" }.freeze
      QOI = 2
      MAX_QOI_PIXELS = 1024 * 1024 # far above any slicer thumbnail; bounds a hostile header

      module_function

      # Info: the metadata as Header fields, the bed, the largest thumbnail
      # (QOI turned into PNG) and a notice for any block that fails.
      def info(path, limit)
        meta = []
        thumbs = []
        notices = []
        format = nil
        File.open(path, "rb") do |f|
          format = header(f)
          each_block(f, format[:crc]) do |b|
            if b.type == GCODE
              f.seek(b.data - PARAMS[GCODE])
              format[:gcode] = [b.method, f.read(2).unpack1("v")]
              break
            end
            next notices << "The #{TYPES[b.type]} block is above the #{Listing.human_size(limit)} info limit; it is skipped." if b.size > limit

            begin
              params, data = payload(f, b, limit)
              if b.type == THUMBNAIL
                thumbs << [*params.unpack("vvv"), data]
              elsif params.unpack1("v").zero? # INI; newer files add a JSON copy of the slicer settings
                meta.concat(ini(data))
              end
            rescue Error => e
              notices << "#{sentence(e.message)}."
            end
          end
        rescue Error => e
          raise if format.nil? # not a .bgcode at all

          notices << "#{sentence(e.message)}; Info shows what comes before it."
        end
        text = meta.map { |k, v| "; #{k} = #{v}\n" }.join
        result = Header.read(text, limit)
        result[:fields] << { label: "Binary G-code", value: describe(format) }
        result[:thumbnail] = thumbnail(thumbs, limit)
        result[:notice] = notices.join(" ") unless notices.empty?
        result
      rescue Error => e
        { ok: false, message: "This binary G-code cannot be read: #{e.message}." }
      rescue SystemCallError => e
        raise Error, e.message
      end

      # Up to limit bytes of decoded G-code, and whether there is more.
      def gcode_head(path, limit, max_block)
        out = String.new(encoding: Encoding::BINARY)
        more = false
        File.open(path, "rb") do |f|
          crc = header(f)[:crc]
          each_block(f, crc) do |b|
            next unless b.type == GCODE
            if out.bytesize >= limit
              more = true
              break
            end

            params, data = payload(f, b, max_block)
            encoding = params.unpack1("v")
            raise Error, "the G-code block at byte #{b.offset} uses unknown encoding #{encoding}" if encoding > 2

            out << (encoding.zero? ? data : meatpack(data))
          end
        end
        [out.byteslice(0, limit), more || out.bytesize > limit]
      rescue SystemCallError => e
        raise Error, e.message
      end

      def header(f)
        head = f.read(10)
        raise Error, "this is not a binary G-code file (no GCDE header)" unless head&.bytesize == 10 && head.start_with?("GCDE")

        version, checksum = head.unpack("@4Vv")
        raise Error, "binary G-code version #{version} is not supported" unless version == 1
        raise Error, "unknown checksum type #{checksum}" if checksum > 1

        { version: version, crc: checksum == 1 }
      end

      # Each block's header, in file order; the data stays on disk.
      def each_block(f, crc)
        size = f.size
        pos = 10
        while pos < size
          f.seek(pos)
          head = f.read(12) || ""
          raise Error, "the file ends inside a block header at byte #{pos}" if head.bytesize < 8

          type, method, usize, csize = head.unpack("vvVV")
          raise Error, "unknown block type #{type} at byte #{pos}" if type >= TYPES.size
          raise Error, "the #{TYPES[type]} block at byte #{pos} uses unknown compression #{method}" if method > 3
          raise Error, "the file ends inside a block header at byte #{pos}" if method.positive? && head.bytesize < 12

          data = pos + (method.zero? ? 8 : 12) + PARAMS[type]
          end_at = data + (method.zero? ? usize : csize)
          after = end_at + (crc ? 4 : 0)
          raise Error, "the #{TYPES[type]} block at byte #{pos} runs past the end of the file" if after > size

          yield Block.new(type, method, usize, pos, data, end_at, crc)
          pos = after
        end
      end

      # The block's parameters and its data, uncompressed, CRC32 checked.
      def payload(f, block, max)
        raise Error, "the #{TYPES[block.type]} block at byte #{block.offset} is above the #{Listing.human_size(max)} limit" if block.size > max

        f.seek(block.offset)
        bytes = f.read(block.end_at - block.offset)
        if block.crc && Zlib.crc32(bytes) != f.read(4).unpack1("V")
          raise Error, "the #{TYPES[block.type]} block at byte #{block.offset} fails its CRC32 check: the file is damaged"
        end

        start = block.data - block.offset
        params = bytes.byteslice(start - PARAMS[block.type], PARAMS[block.type])
        [params, uncompress(block, bytes.byteslice(start..))]
      end

      def uncompress(block, data)
        out = case block.method
              when 0 then data
              when 1 then inflate(data, block.size)
              else heatshrink(data, block.size, block.method == 2 ? 11 : 12, 4)
              end
        return out if out.bytesize == block.size

        raise Error, "the #{TYPES[block.type]} block at byte #{block.offset} gives #{out.bytesize} bytes, its header says #{block.size}"
      end

      def inflate(data, size)
        out = String.new(encoding: Encoding::BINARY)
        zstream = Zlib::Inflate.new
        take = lambda do |chunk|
          out << chunk
          raise Error, "Deflate data is larger than its block says" if out.bytesize > size
        end
        zstream.inflate(data, &take)
        zstream.finish(&take)
        out
      rescue Zlib::Error => e
        raise Error, "Deflate data is broken: #{e.message}"
      ensure
        zstream&.close
      end

      # A bit stream, MSB first: tag 1 = an 8-bit literal, tag 0 = a
      # back-reference (window bits: distance - 1, lookahead bits: length - 1).
      def heatshrink(src, size, window, lookahead)
        out = String.new(capacity: [size, 1 << 20].min, encoding: Encoding::BINARY)
        p = acc = have = 0
        n = src.bytesize
        bits = lambda do |count|
          while have < count
            return nil if p >= n

            acc = ((acc << 8) | src.getbyte(p)) & 0xFFFFFF
            p += 1
            have += 8
          end
          have -= count
          (acc >> have) & ((1 << count) - 1)
        end
        while out.bytesize < size
          tag = bits.(1) or break
          if tag == 1
            byte = bits.(8) or break
            out << byte
          else
            index = bits.(window) or break
            count = bits.(lookahead) or break
            from = out.bytesize - index - 1
            (count + 1).times do
              break if out.bytesize >= size

              out << (from >= 0 ? out.getbyte(from) : 0)
              from += 1
            end
          end
        end
        out
      end

      PACKED = "0123456789. \nGX".bytes.freeze
      PARAM = "XYZEFIJRSGPWHCA".bytes.freeze
      NL = 10
      SPACE = 32

      # MeatPack, as libbgcode's MeatPack::unbinarize (see gcode-binary.js).
      def meatpack(src)
        out = String.new(capacity: src.bytesize * 2, encoding: Encoding::BINARY)
        packing = no_spaces = command = add_space = false
        signals = full = 0
        held = nil
        put = lambda do |c|
          last = out.empty? ? nil : out.getbyte(-1)
          line_start = false
          if c == 71 && (last.nil? || last == NL) # G at a line start
            add_space = true
            line_start = true
          elsif c == NL
            add_space = false
          end
          out << SPACE if !line_start && add_space && last != SPACE && PARAM.include?(c)
          out << c unless c == NL && out.getbyte(-1) == NL
        end
        code = ->(v) { v == 0b1011 && no_spaces ? 69 : PACKED[v] } # 69 = E
        receive = lambda do |c|
          next put.(c) unless packing

          if full.positive?
            put.(c)
            put.(held) if held
            held = nil
            full -= 1
          elsif (c & 0x0F) == 0x0F
            full += 1
            if (c & 0xF0) == 0xF0
              full += 1
            else
              held = code.(c >> 4)
            end
          else
            first = code.(c & 0x0F)
            put.(first)
            next if first == NL

            if (c & 0xF0) == 0xF0
              full += 1
            else
              put.(code.(c >> 4))
            end
          end
        end
        src.each_byte do |c|
          if c == 0xFF && signals.positive?
            command = true
            signals = 0
          elsif c == 0xFF
            signals += 1
          elsif command
            case c
            when 251 then packing = true
            when 250, 249 then packing = false
            when 247 then no_spaces = true
            when 246 then no_spaces = false
            end
            command = false
          else
            if signals.positive?
              receive.(0xFF)
              signals = 0
            end
            receive.(c)
          end
        end
        out
      end

      def sentence(text) = text.sub(/\A./, &:upcase)

      # INI metadata: one key=value per line.
      def ini(data)
        Gcode.utf8(data).each_line.filter_map do |line|
          key, value = line.chomp.split("=", 2)
          [key.strip, value.to_s.strip] if value && !key.strip.empty?
        end
      end

      def describe(format)
        parts = ["version #{format[:version]}"]
        if (gcode = format[:gcode])
          parts << "G-code #{COMPRESSION[gcode[0]]}, #{ENCODING[gcode[1]] || "encoding #{gcode[1]}"}"
        end
        parts << (format[:crc] ? "CRC32" : "no checksum")
        parts.join(" · ")
      end

      # The largest PNG or JPG within limit, else the largest QOI as a PNG.
      def thumbnail(thumbs, limit)
        image = thumbs.select { |fmt, _, _, data| IMAGE.key?(fmt) && data.bytesize <= limit }.max_by { |_, w, h, _| w * h }
        return Gcode.data_uri(IMAGE[image[0]], image[3]) if image

        qoi = thumbs.select { |fmt, w, h, _| fmt == QOI && (w * h).between?(1, MAX_QOI_PIXELS) }.max_by { |_, w, h, _| w * h }
        png = qoi && Qoi.png(qoi[3])
        png && png.bytesize <= limit ? Gcode.data_uri("image/png", png) : nil
      rescue Error
        nil
      end
    end

    # QOI (the Quite OK Image format) → PNG, for a .bgcode thumbnail an <img> can show.
    module Qoi
      module_function

      def png(data)
        raise Bgcode::Error, "not a QOI image" unless data.bytesize >= 22 && data.start_with?("qoif")

        width, height = data.unpack("@4NN")
        raise Bgcode::Error, "QOI image too large" unless (width * height).between?(1, Bgcode::MAX_QOI_PIXELS)

        encode(width, height, pixels(data, width * height))
      end

      def pixels(data, count)
        index = Array.new(64, [0, 0, 0, 0])
        r = g = b = 0
        a = 255
        run = 0
        pos = 14
        out = String.new(capacity: count * 4, encoding: Encoding::BINARY)
        count.times do
          if run.positive?
            run -= 1
          elsif (op = data.getbyte(pos))
            pos += 1
            if op == 0xFE
              r, g, b = data.byteslice(pos, 3).bytes
              pos += 3
            elsif op == 0xFF
              r, g, b, a = data.byteslice(pos, 4).bytes
              pos += 4
            else
              case op >> 6
              when 0 then r, g, b, a = index[op]
              when 1
                r = (r + ((op >> 4) & 3) - 2) & 0xFF
                g = (g + ((op >> 2) & 3) - 2) & 0xFF
                b = (b + (op & 3) - 2) & 0xFF
              when 2
                low = data.getbyte(pos).to_i
                pos += 1
                dg = (op & 0x3F) - 32
                r = (r + dg - 8 + (low >> 4)) & 0xFF
                g = (g + dg) & 0xFF
                b = (b + dg - 8 + (low & 0x0F)) & 0xFF
              else run = op & 0x3F
              end
            end
            raise Bgcode::Error, "broken QOI image" unless r && g && b && a

            index[((r * 3) + (g * 5) + (b * 7) + (a * 11)) % 64] = [r, g, b, a]
          end
          out << r << g << b << a
        end
        out
      end

      def encode(width, height, rgba)
        stride = width * 4
        rows = String.new(capacity: (stride + 1) * height, encoding: Encoding::BINARY)
        height.times { |y| rows << 0 << rgba.byteslice(y * stride, stride) }
        chunk = ->(type, body) { [body.bytesize].pack("N") + type + body + [Zlib.crc32(type + body)].pack("N") }
        "\x89PNG\r\n\x1A\n".b + chunk.("IHDR", [width, height, 8, 6, 0, 0, 0].pack("NNCCCCC")) +
          chunk.("IDAT", Zlib::Deflate.deflate(rows)) + chunk.("IEND", "")
      end
    end
  end
end
