# frozen_string_literal: true

require "json"

# The viewer registry behind the preview modal. A viewer is a module under
# Viewers:: (one file per viewer in lib/viewers/, picked up without a
# registration line) that extends Preview::Viewer and overrides what it needs:
# which files it matches, the tabs (views) it offers, its settings and cap,
# and optionally a data endpoint the browser fetches (?data=<id>[&part=<p>]).
# Every viewer that matches a file contributes its views; the tab bar is the
# union, ordered by priority. See docs/viewers.md for the contract.
module Preview
  View = Struct.new(:id, :label, :tip, keyword_init: true) do
    def to_h = { id: id, label: label, tip: tip }.compact
  end

  # The file a viewer is asked about. Lazy: nothing reads the file unless a
  # viewer's match? does.
  class Target
    attr_reader :path

    def initialize(path)
      @path = path
    end

    def name = @name ||= File.basename(path)

    def basename = @basename ||= name.downcase

    # Extension without the dot, lower case ("" when there is none).
    def ext = @ext ||= File.extname(path).delete_prefix(".").downcase

    def size = @size ||= File.size(path)

    def text? = @text.nil? ? (@text = TextView.text?(path)) : @text
  end

  # Defaults every viewer inherits through `extend Preview::Viewer`.
  module Viewer
    # Viewers::Text → "text", Viewers::GeoJson → "geo_json".
    def id = name.split("::").last.gsub(/(?<!\A)([A-Z])/, '_\1').downcase

    # Gallery kind of a file this viewer is primary for (icon, media grid).
    def kind = id.to_sym

    def label = id.capitalize

    def icon = "file-earmark"

    # Higher first: the primary viewer of a file, and the order of its tabs.
    def priority = 0

    def exts = []

    # Binary viewers keep their extensions away from the text sniffer.
    def binary? = false

    def match?(target) = exts.include?(target.ext)

    def views(_target) = [View.new(id: id, label: label)]

    # { "setting_key" => typed default (Integer, true/false, Array, String) }.
    def settings = {}

    # The setting holding this viewer's size cap; nil = no cap.
    def max_bytes_key = nil

    def max_bytes = max_bytes_key && Setting.get(max_bytes_key)

    # Where the browser loads the file for this viewer; nil = no fetch.
    def src(link) = data? ? "#{link}?data=#{id}" : nil

    def data? = respond_to?(:data)

    def to_item(target, link) = { id: id, src: src(link), views: views(target).map(&:to_h) }.compact
  end

  # One ?data=<viewer> request. Helpers count the download once (unless the
  # request is a HEAD or a resumed range), send bytes with a CSP, or answer
  # an HTML/JSON fragment.
  class Context
    attr_reader :app, :share, :index, :rel, :real, :name, :part, :viewer

    def initialize(app:, share:, index:, rel:, real:, viewer:)
      @app = app
      @share = share
      @index = index
      @rel = rel
      @real = real
      @viewer = viewer
      @name = rel.empty? ? File.basename(real) : rel
      part = app.request.params["part"].to_s
      @part = part.empty? ? nil : part
      @counted = false
    end

    def request = app.request

    def params = request.params

    def size = File.size(real)

    def too_large? = !viewer.max_bytes.nil? && size > viewer.max_bytes

    def download_href = "#{Listing.href(share, index, rel)}?dl=1"

    # Counts the file as downloaded, at most once per request.
    def count!
      return if @counted || FileServer.skip_count?(request)

      @counted = true
      FileServer.count(request: request, share: share, name: name)
    end

    # The file's bytes, inline, range-capable. csp is the policy for the
    # response ("sandbox" by default: harmless for fetch(), and an opened URL
    # runs nothing on this origin). count: false for secondary parts.
    def send_file(csp: "sandbox", type: nil, count: part.nil?, path: real)
      status, headers, body = FileServer.serve(request: request, share: share, real_path: path, name: name,
                                               sandbox: false, preview: true)
      if FileServer.success?(status)
        headers["content-security-policy"] = csp if csp
        headers["x-content-type-options"] = "nosniff"
        headers["content-type"] = type if type && !headers["content-type"].to_s.start_with?("multipart/")
        count! if count
      end
      [status, headers, body]
    end

    def html(body, count: part.nil?, status: 200)
      count! if count && status == 200
      [status, fragment_headers("text/html; charset=utf-8"), [body]]
    end

    def json(data, count: part.nil?, status: 200)
      count! if count && status == 200
      [status, fragment_headers("application/json"), [JSON.generate(data)]]
    end

    def render(template, **locals) = app.render(template, locals: locals)

    def not_found! = app.not_found_page!

    private

    def fragment_headers(type)
      { "content-type" => type, "cache-control" => FileServer::PAGE_CACHE, "content-security-policy" => "sandbox",
        "x-content-type-options" => "nosniff" }
    end
  end

  module_function

  # Every module under Viewers::, primary first. Recomputed per call so a
  # viewer file added or reloaded in development counts at once.
  def viewers
    return [] unless defined?(::Viewers)

    ::Viewers.constants.sort.map { |c| ::Viewers.const_get(c) }
             .select { |m| m.is_a?(Module) && m.respond_to?(:match?) }
             .sort_by { |v| [-v.priority, v.id] }
  end

  def find(id) = viewers.find { |v| v.id == id.to_s }

  # The viewers that can show the file at path, primary first.
  def matching(path, target: Target.new(path)) = viewers.select { |v| v.match?(target) }

  def binary_ext?(ext) = viewers.any? { |v| v.binary? && v.exts.include?(ext) }

  # { key => typed default } across viewers; a key two viewers declare is a bug.
  def settings
    viewers.each_with_object({}) do |v, all|
      v.settings.each do |key, default|
        raise ArgumentError, "Setting #{key} declared by two viewers" if all.key?(key)

        all[key] = default
      end
    end
  end

  # ?data=<viewer>; ?text=1 and ?model=1 are the older spellings.
  def requested(params)
    id = params["data"].to_s
    return id unless id.empty?
    return "text" if params.key?("text")

    "model" if params.key?("model")
  end

  # Runs the data endpoint of viewer id for the file, or 404 when that
  # viewer does not match the file or has no endpoint.
  def data(app, share:, index:, rel:, real:, id:)
    viewer = find(id)
    app.not_found_page! unless viewer&.data? && viewer.match?(Target.new(real))
    viewer.data(Context.new(app: app, share: share, index: index, rel: rel, real: real, viewer: viewer))
  end

  # The modal's data-preview config: per viewer its module, template and cap.
  def client_config(app)
    root = app.opts[:root]
    modules = Dir[File.join(root, "public/js/viewers/*.js")].to_h do |f|
      [File.basename(f, ".js"), app.asset("js/viewers/#{File.basename(f)}")]
    end
    cap = ->(v) { (m = v.max_bytes) ? { max: m, max_label: Listing.human_size(m) } : {} }
    { viewers: viewers.to_h { |v| [v.id, { label: v.label, **cap.(v)}] }, modules: modules }
  end

  # Viewers that ship modal markup in views/viewers/<id>.erb.
  def templates(app)
    viewers.map(&:id).select { |id| File.file?(File.join(app.opts[:root], "views/viewers/#{id}.erb")) }
  end
end
