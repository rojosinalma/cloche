# frozen_string_literal: true

require "zlib"

module Viewers
  # PDFs in the browser's own PDF viewer (Chromium's, Firefox's pdf.js),
  # from ?data=pdf: an <iframe> without a sandbox attribute (a sandboxed
  # frame blocks the built-in viewer) over a response with
  # "Content-Security-Policy: sandbox", type application/pdf and nosniff, so
  # the bytes never run as a page on this origin. Info reads the document
  # details server-side (?data=pdf&part=info), also above the size cap.
  module Pdf
    extend Preview::Viewer

    DOCUMENT = Preview::View.new(id: "document", label: "Document", tip: "The PDF in the browser's viewer")
    INFO = Preview::View.new(id: "info", label: "Info", tip: "Pages, title, author and producer")

    def self.label = "PDF"

    def self.icon = "file-earmark-pdf"

    def self.priority = 20

    def self.exts = %w[pdf]

    def self.binary? = true

    def self.views(_target) = [DOCUMENT, INFO]

    def self.settings = { "pdf_view_max_bytes" => 100 * 1024 * 1024, "pdf_view_info_max_bytes" => 16 * 1024 * 1024 }

    # No modal-level cap: Info stays available above it. The Document tab
    # reads the cap from the Info answer and shows the notice itself.
    def self.doc_max_bytes = Setting.get("pdf_view_max_bytes")

    def self.data(ctx)
      return ctx.json(info(ctx)) if ctx.part == "info"
      ctx.not_found! if ctx.part
      if ctx.size > doc_max_bytes
        return ctx.html("This file is #{Listing.human_size(ctx.size)}, above the " \
                        "#{Listing.human_size(doc_max_bytes)} viewer limit.", status: 413)
      end

      ctx.send_file(csp: "sandbox", type: "application/pdf")
    end

    def self.info(ctx)
      max = doc_max_bytes
      base = { size: ctx.size, size_label: Listing.human_size(ctx.size), max: max, max_label: Listing.human_size(max),
               too_large: ctx.size > max }
      base.merge(Info.read(ctx.real, limit: Setting.get("pdf_view_info_max_bytes")))
    end

    # Document details from the file itself, with the standard library only:
    # the header, the trailer's /Info and /Root, and object streams inflated
    # with Zlib (PDF 1.5+ keeps the page tree and the Info dictionary there).
    # Reads at most `limit` bytes and inflates at most as much again.
    module Info
      FIELDS = { "Title" => :title, "Author" => :author, "Subject" => :subject, "Keywords" => :keywords,
                 "Creator" => :creator, "Producer" => :producer, "CreationDate" => :created, "ModDate" => :modified }.freeze
      OBJ = /(\d+)\s+\d+\s+obj\b/
      STREAM = /stream\r?\n/
      CHUNK = 64 * 1024

      module_function

      def read(path, limit:)
        head = File.binread(path, 1024) || "".b
        version = head[/%PDF-(\d\.\d)/, 1]
        return { notice: "This is not a PDF file: it has no PDF header." } unless version
        return { version: version, notice: "Details are read for files up to #{Listing.human_size(limit)} only." } if File.size(path) > limit

        Parser.new(File.binread(path), limit).details.merge(version: version)
      rescue SystemCallError => e
        { notice: "The file could not be read (#{e.message})." }
      end

      # Indexes objects by number (later definitions win, like incremental
      # updates), then follows /Root → /Pages → /Count and /Info.
      class Parser
        def initialize(data, limit)
          @data = data
          @budget = limit
          @objects = {}
        end

        def details
          index(@data)
          encrypted = trailer_ref("Encrypt") || @data.match?(%r{/Encrypt\s*<<})
          out = { pages: pages, encrypted: encrypted ? true : nil }.compact
          info = trailer_ref("Info").then { |n| n && @objects[n] }
          FIELDS.each { |key, field| (v = field_value(info, key)) && out[field] = v } if info && !encrypted
          out[:notice] = "No page tree found: the file may be damaged." unless out[:pages]
          out
        end

        private

        def index(data)
          pos = 0
          while (m = OBJ.match(data, pos))
            num = m[1].to_i
            body_start = m.end(0)
            stop = data.index("endobj", stream_end(data, body_start)) or break
            body = data.byteslice(body_start, stop - body_start)
            @objects[num] = body
            object_stream(body) if body.include?("/ObjStm")
            pos = stop + 6
          end
        end

        # Where to look for this object's "endobj": past its stream data when
        # the dictionary gives a direct /Length (binary data may contain the
        # word), else right after the object header.
        def stream_end(data, start)
          stop = data.index("endobj", start) or return start
          s = STREAM.match(data, start)
          return start unless s && s.begin(0) < stop

          length = data.byteslice(start, s.begin(0) - start)[%r{/Length\s+(\d+)\b(?!\s+\d+\s+R)}, 1]
          length ? [s.end(0) + length.to_i, data.bytesize].min : start
        end

        def object_stream(body)
          dict, stream = split_stream(body)
          return unless stream && dict.include?("/FlateDecode")

          content = inflate(stream) or return
          n = dict[%r{/N\s+(\d+)}, 1].to_i
          first = dict[%r{/First\s+(\d+)}, 1].to_i
          pairs = content.byteslice(0, first).to_s.scan(/\d+/).map(&:to_i).each_slice(2).first(n)
          pairs.each_with_index do |(num, off), i|
            stop = pairs[i + 1] ? pairs[i + 1][1] : content.bytesize - first
            @objects[num] ||= content.byteslice(first + off, stop - off)
          end
        end

        def split_stream(body)
          m = STREAM.match(body) or return [body, nil]
          length = body[%r{/Length\s+(\d+)\b(?!\s+\d+\s+R)}, 1]&.to_i
          stop = length || body.index("endstream", m.end(0)).to_i - m.begin(0)
          [body.byteslice(0, m.begin(0)), body.byteslice(m.end(0), [stop, 0].max)]
        end

        # Inflates within what is left of the budget; nil on a broken stream.
        def inflate(stream)
          zi = Zlib::Inflate.new
          out = +"".b
          (0...stream.bytesize).step(CHUNK) do |i|
            out << zi.inflate(stream.byteslice(i, CHUNK))
            return nil if out.bytesize > @budget
          end
          @budget -= out.bytesize
          out
        rescue Zlib::Error
          nil
        ensure
          zi&.close
        end

        # The last /Key n 0 R in the file: the newest trailer or xref stream.
        def trailer_ref(key)
          @data.scan(%r{/#{key}\s+(\d+)\s+\d+\s+R}).last&.first&.to_i
        end

        def pages
          root = trailer_ref("Root").then { |n| n && @objects[n] } or return nil
          node = ref(root, "Pages") or return nil
          count = node[%r{/Count\s+(\d+)}, 1]
          count&.to_i
        end

        def ref(body, key)
          num = body[%r{/#{key}\s+(\d+)\s+\d+\s+R}, 1] or return nil
          @objects[num.to_i]
        end

        def field_value(info, key)
          m = %r{/#{key}\b\s*}.match(info) or return nil
          rest = info.byteslice(m.end(0), info.bytesize)
          if (indirect = rest[/\A(\d+)\s+\d+\s+R/, 1])
            rest = @objects[indirect.to_i].to_s.strip
          end
          text = pdf_string(rest) or return nil
          text = text.strip
          return nil if text.empty?

          key.end_with?("Date") ? pdf_date(text) : text
        end

        def pdf_string(src)
          case src[0]
          when "(" then decode(literal(src))
          when "<" then src[1] == "<" ? nil : decode([src[/\A<([0-9A-Fa-f\s]*)>/, 1].to_s.delete(" \n\r\t")].pack("H*"))
          end
        end

        ESCAPES = { "n" => "\n", "r" => "\r", "t" => "\t", "b" => "\b", "f" => "\f" }.freeze

        def literal(src)
          out = +"".b
          depth = 0
          i = 1
          while i < src.bytesize
            c = src.getbyte(i).chr
            if c == "\\"
              i += 1
              nxt = src.getbyte(i)&.chr
              if nxt&.match?(/[0-7]/)
                oct = src.byteslice(i, 3)[/\A[0-7]{1,3}/]
                out << oct.to_i(8).chr
                i += oct.size - 1
              elsif nxt
                out << ESCAPES.fetch(nxt, nxt) unless "\r\n".include?(nxt)
              end
            elsif c == "("
              depth += 1
              out << c
            elsif c == ")"
              break if depth.zero?

              depth -= 1
              out << c
            else
              out << c
            end
            i += 1
          end
          out
        end

        # UTF-16BE with a BOM, UTF-8 with a BOM, else PDFDocEncoding (read as Latin-1).
        def decode(bytes)
          bytes = bytes.b
          text = if bytes.start_with?("\xFE\xFF".b)
                   bytes.byteslice(2..).force_encoding(Encoding::UTF_16BE).encode(Encoding::UTF_8, invalid: :replace, undef: :replace)
                 elsif bytes.start_with?("\xEF\xBB\xBF".b)
                   bytes.byteslice(3..).force_encoding(Encoding::UTF_8).scrub("\uFFFD")
                 else
                   bytes.force_encoding(Encoding::ISO_8859_1).encode(Encoding::UTF_8)
                 end
          text.delete("\u0000")
        end

        # D:YYYYMMDDHHmmSS+HH'mm' → "2026-10-21 12:00 UTC" (or +02:00).
        def pdf_date(text)
          m = text.match(/\AD?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz]|[+-]\d{2}'?\d{2}'?)?/) or return text
          date = [m[1], m[2] || "01", m[3] || "01"].join("-")
          time = m[4] ? " #{m[4]}:#{m[5] || '00'}" : ""
          zone = m[7].to_s.delete("'")
          zone = zone.empty? ? "" : (zone.casecmp?("z") ? " UTC" : " #{zone[0, 3]}:#{zone[3, 2]}")
          "#{date}#{time}#{zone}"
        end
      end
    end
  end
end
