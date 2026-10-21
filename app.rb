# frozen_string_literal: true

require "json"
require "roda"
require "rack/utils"

require_relative "lib/version"
require_relative "lib/logger"
require_relative "models/database"
require_relative "lib/worker_pool"
require_relative "lib/idle_sweeper"

# Stateful modules above load once; everything below reloads in development.
%w[
  models/setting models/share models/download models/link
  lib/path_guard lib/listing lib/text_view lib/form lib/model_view lib/share_manager lib/link_manager lib/zipper lib/file_server lib/callback lib/mcp_server
].each do |file|
  defined?(Unreloader) ? Unreloader.require(File.expand_path("#{file}.rb", __dir__)) : require_relative(file)
end

class App < Roda
  opts[:root] = __dir__

  plugin :render, engine: "erb", views: "views", layout: "layout", escape: true
  plugin :json
  plugin :json_parser, content_type_regexp: %r{\Aapplication/json\b}i, error_handler: lambda { |r|
    r.halt [400, { "content-type" => "application/json" }, [JSON.generate(ok: false, message: "Request body is not valid JSON")]]
  }
  plugin :public, headers: { "cache-control" => "public, max-age=31536000, immutable" }
  plugin :halt
  plugin :head
  plugin :all_verbs
  plugin :request_headers

  plugin :not_found do
    if api_path?
      response["content-type"] = "application/json"
      JSON.generate(ok: false, message: "No route for #{request.request_method} #{request.path}")
    else
      page("not_found", title: "Not found")
    end
  end

  plugin :error_handler do |e|
    $log.error "[app] #{request.request_method} #{request.path}: #{e.class}: #{e.message}\n#{Array(e.backtrace).join("\n")}"
    response.status = 500
    if api_path?
      response["content-type"] = "application/json"
      JSON.generate(ok: false, message: "Internal error: #{e.class}: #{e.message}")
    else
      response["content-type"] = "text/plain; charset=utf-8"
      "Internal error: #{e.class}: #{e.message}"
    end
  end

  def json_ok(message, **data) = { ok: true, message: message, **data }

  def json_err(message, **data) = { ok: false, message: message, **data }

  def api_path? = request.path.start_with?("/api/", "/mcp")

  def halt_json(status, message)
    request.halt [status, { "content-type" => "application/json" }, [JSON.generate(json_err(message))]]
  end

  def api_authorized!
    token = ENV["CLOCHE_MCP_TOKEN"].to_s
    halt_json(404, "Not found") if token.empty?

    auth = request.headers["Authorization"].to_s
    return if auth.start_with?("Bearer ") && Rack::Utils.secure_compare(auth.delete_prefix("Bearer "), token)

    $log.warn "[auth] unauthorized #{request.request_method} #{request.path} from #{request.ip}"
    halt_json(401, "Unauthorized: missing or invalid bearer token")
  end

  def asset(path)
    file = File.join(opts[:root] || Dir.pwd, "public", path)
    "/#{path}?v=#{File.exist?(file) ? File.mtime(file).to_i : 0}"
  end

  # One icon from the tailor sprite (public/tailor/icons.svg, declared via `tailor apply --icons`).
  # Decorative by default; pass label: when the icon is the only content of its control.
  def icon(name, label: nil, css: nil, id: nil)
    name = name.to_s.delete_prefix("bi-")
    classes = ["t-icon", css].compact.join(" ")
    attrs = [%(class="#{classes}"), id && %(id="#{id}"), label ? 'role="img"' : 'aria-hidden="true"'].compact.join(" ")
    title = label ? "<title>#{Rack::Utils.escape_html(label)}</title>" : ""
    %(<svg #{attrs}>#{title}<use href="/tailor/icons.svg#bi-#{name}"/></svg>)
  end

  # data-* attributes that make an element open the preview modal on an item.
  def preview_attrs(item)
    return "" unless item.previewable?

    attrs = { preview: "", kind: item.kind, src: item.preview_src, name: item.name, download: item.href,
              href: item.view_href.delete_suffix("?view=1"), format: item.format, size: item.size }
    attrs.map { |k, v| %(data-#{k}="#{Rack::Utils.escape_html(v.to_s)}") }.join(" ")
  end

  def page(template, title:, idle_label: nil, **locals)
    view(template, locals: locals.merge(idle_label: idle_label),
                   layout_opts: { locals: { title: title, idle_label: idle_label, permanent: locals[:permanent],
                                            expires_at: locals[:expires_at], external: locals[:external],
                                            status_url: locals[:base] && "#{locals[:base]}/status" } })
  end

  def not_found_page!
    response.status = 404
    response.write(page("not_found", title: "Not found"))
    request.halt
  end

  # An external link that no longer opens: same page for revoked, expired and
  # ended, and nothing on it points back at the share.
  def link_gone_page!(link)
    response.status = 410
    reason = link.share.ended? ? "The share behind it has ended." : "It was #{link.state}."
    response.write(page("not_found", title: "Link ended", heading: "This link no longer works",
                                     message: "#{reason} Ask the person who sent it for a new one."))
    request.halt
  end

  def decode_path(path) = Rack::Utils.unescape_path(path.to_s).dup.force_encoding(Encoding::UTF_8)

  # Through an external link the footer counts down the link, not the share's idle clock.
  def share_page(template, share, **locals)
    if (link = share.via_link)
      return page(template, title: share.title, expires_at: link.expires_at&.to_i, permanent: link.expires_at.nil?,
                            external: true, links: nil, share: share, base: Listing.base(share), **locals)
    end

    page(template, title: share.title, idle_label: ShareManager.idle_label(share),
                   expires_at: ShareManager.expires_at(share)&.to_i, permanent: share.permanent?, external: false,
                   share: share, base: Listing.base(share), links: link_dialog(share), **locals)
  end

  # What the share page's link dialog needs; nil hides the button.
  def link_dialog(share)
    return unless LinkManager.enabled? && !share.form? && share.live?

    LinkManager.presets
  end

  def link_error(error)
    response.status = error.status
    json_err(error.message)
  end

  # GET/POST /links and DELETE /links/<link_id>, under /api/shares/<id> (every
  # link, any state) and under the share page /s/<id> (live links only; the
  # id there is already the key to the share).
  def share_links(share, all: false)
    r = request
    r.is do
      r.get do
        links = all ? LinkManager.all_docs(share) : LinkManager.live_docs(share)
        json_ok("#{links.size} link(s)", links: links)
      end

      r.post do
        link = LinkManager.create(share, ttl: r.POST["ttl"])
        response.status = 201
        json_ok("Link created, #{LinkManager.ttl_label(link.expires_at ? (link.expires_at - link.created_at).round : 0)}",
                **LinkManager.doc(link, share))
      end
    end

    r.is String do |link_id|
      r.delete do
        link, changed = LinkManager.revoke(share, link_id)
        json_ok(changed ? "Link revoked" : "Already revoked", **LinkManager.doc(link, share))
      end
    end
  rescue LinkManager::Error => e
    link_error(e)
  end

  # The gallery routes shared by /s/<id>/ and /x/<token>/.
  def share_content(share)
    r = request
    r.get do
      next raw_served(share, decode_path(r.remaining_path)) if share.raw

      r.root do
        next form_page(share) if share.form?
        next gallery_served(share, 0, "") if share.single_dir?

        gallery(share, Listing.top_items(share), crumbs: [], zip_href: "#{Listing.base(share)}/all.zip")
      end

      r.is "all.zip" do
        r.halt FileServer.zip(request: r, share: share, items: Listing.all_zip_items(share),
                              filename: "#{share.title}.zip")
      end

      r.on("p", Integer) { |index| gallery_served(share, index, decode_path(r.remaining_path)) }
    end
  end

  def gallery(share, items, crumbs:, zip_href:)
    media = items.select { |i| Listing.media?(i) }
    share_page("gallery", share, crumbs: crumbs, media: media, files: items - media,
                                 total_size: items.sum { |i| i.size.to_i }, zip_href: zip_href)
  end

  # The text fragment the preview modal fetches (?text=1) is the one download
  # of the file; Pretty/Raw and Copy are client-side and add nothing.
  def text_card(share, index, rel, real)
    name = rel.empty? ? File.basename(real) : rel
    view = TextView.build(real, name: File.basename(real), share: share, index: index, rel: rel)
    FileServer.count(request: request, share: share, name: name) unless view.too_large? || FileServer.skip_count?(request)
    response["content-type"] = "text/html; charset=utf-8"
    response["cache-control"] = FileServer::PAGE_CACHE
    render("text_card", locals: { view: view, download_href: "#{Listing.href(share, index, rel)}?dl=1" })
  end

  # Previewable files (text, image, video, audio, 3D model) have no page of
  # their own: a ?view=1 deep link lands on the gallery that lists the file,
  # with the preview modal opened on it (#v=<href>). The modal's data fetch
  # for a model is ?model=1 and for text ?text=1; each counts once.
  def preview_redirect(share, index, rel)
    request.redirect("#{Listing.container_href(share, index, rel)}#v=#{Listing.href(share, index, rel)}", 302)
  end

  def gallery_folder(share, index, rel, real)
    entry = share.entries[index]
    name = rel.empty? ? entry.name : File.basename(rel)
    if request.params.key?("zip")
      items = Listing.dir_zip_items(real, scope: entry.path, name: name)
      request.halt FileServer.zip(request: request, share: share, items: items, filename: "#{name}.zip")
    end
    gallery(share, Listing.dir_items(share, index, real), crumbs: Listing.crumbs(share, index, rel),
                                                          zip_href: "#{Listing.href(share, index, rel, dir: true)}?zip=1")
  end

  def gallery_served(share, index, rel)
    entry = share.entries[index] or not_found_page!
    rel = rel.delete_prefix("/").delete_suffix("/")
    real = PathGuard.resolve(entry, rel) or not_found_page!
    return gallery_folder(share, index, rel, real) if File.directory?(real)
    kind = Listing.kind_of(real)
    preview_redirect(share, index, rel) if request.params.key?("view") && Listing.previewable?(kind)
    return text_card(share, index, rel, real) if request.params.key?("text") && kind == :text

    name = rel.empty? ? File.basename(real) : rel
    if request.params.key?("model") && kind == :model
      request.halt FileServer.serve(request: request, share: share, real_path: real, name: name, sandbox: false)
    end

    request.halt FileServer.serve(request: request, share: share, real_path: real, name: name,
                                  download: request.params.key?("dl"), preview: request.params.key?("preview"))
  end

  def raw_served(share, path)
    real = PathGuard.resolve(share.entries.first, path.delete_prefix("/")) or not_found_page!
    if File.directory?(real)
      request.redirect("#{request.path}/", 301) unless request.path.end_with?("/")
      request.halt FileServer.raw_directory(request: request, share: share, real_dir: real, url_path: path)
    end
    request.halt FileServer.serve(request: request, share: share, real_path: real,
                                  name: path.delete_prefix("/"), sandbox: false, preview: true)
  end

  def stop_by_user(share)
    ShareManager.stop(share, "stopped by user")
    json_ok("Stopped serving")
  end

  # Locals here are the contract with views/form.erb.
  def form_page(share)
    has_paths = !share.entries.empty?
    share_page("form", share, spec: share.form_spec, draft: share.draft_hash,
                              submissions: share.submissions.to_i, submitted_at: share.submitted_at,
                              items: has_paths ? Listing.top_items(share) : [],
                              zip_href: has_paths ? "#{Listing.base(share)}/all.zip" : nil,
                              bulk_threshold: Setting.get("form_bulk_threshold"),
                              text_max_chars: Setting.get("form_text_max_chars"))
  end

  def body_within_cap!
    cap = Setting.get("form_max_bytes")
    return if request.content_length.to_i <= cap

    request.halt [413, { "content-type" => "application/json" },
                  [JSON.generate(json_err("Request body is over the #{cap} byte cap"))]]
  end

  def form_share!(share)
    halt_json(400, "Not a form share") unless share.form?
    body_within_cap!
  end

  def ended_json(share)
    response.status = 410
    json_err("Share has ended", reason: share.end_reason)
  end

  def save_draft(share)
    saved_at = ShareManager.save_draft(share, request.POST["answers"])
    json_ok("Draft saved", saved_at: saved_at.getutc.iso8601)
  rescue Form::Invalid => e
    response.status = 422
    json_err(e.message)
  rescue ShareManager::AlreadyEnded
    ended_json(share)
  end

  def submit_answers(share)
    ShareManager.submit(share, request.POST["answers"])
    json_ok("Answers submitted", submissions: share.submissions, submitted_at: share.submitted_at.getutc.iso8601,
                                 answers: share.answers_hash)
  rescue Form::Invalid => e
    response.status = 422
    json_err(e.message, errors: e.errors || {})
  rescue ShareManager::AlreadyEnded
    ended_json(share)
  end

  route do |r|
    r.public

    r.root { page("landing", title: "cloche") }

    r.get("health") { { status: "ok", version: Cloche::VERSION, live_shares: ShareManager.live.count } }

    r.on "api" do
      api_authorized!

      r.on "settings" do
        r.is do
          r.get { json_ok("#{Setting.defaults.size} setting(s)", settings: Setting.listing) }
        end

        r.is String do |key|
          r.put do
            value = Setting.update!(key, r.POST["value"])
            json_ok("Setting #{key} updated", key: key, value: value)
          end

          r.delete do
            value = Setting.reset!(key)
            json_ok("Setting #{key} reset to default", key: key, value: value)
          end
        rescue Setting::UnknownKey => e
          response.status = 404
          json_err(e.message)
        rescue Setting::Invalid => e
          response.status = 422
          json_err(e.message)
        end
      end

      r.on "shares" do
        r.is do
          r.get do
            shares = ShareManager.list
            json_ok("#{shares.size} share(s)", shares: shares)
          end

          r.post do
            body_within_cap!
            body = r.POST
            share = ShareManager.create(paths: body["paths"], title: body["title"], raw: body["raw"], form: body["form"],
                                        session: body["session"], idle_timeout: body["idle_timeout"])
            response.status = 201
            json_ok("Share created", **ShareManager.summary(share))
          rescue ShareManager::ValidationError => e
            response.status = 422
            json_err(e.message)
          end
        end

        r.on String do |id|
          share = Share[id] or halt_json(404, "No share with id #{id}")

          r.is do
            r.get { json_ok("Share #{share.live? ? 'live' : 'ended'}", **ShareManager.detail(share)) }

            r.patch do
              ShareManager.update(share, idle_timeout: r.POST["idle_timeout"])
              json_ok("Idle timeout set to #{ShareManager.idle_label(share)}", **ShareManager.summary(share))
            rescue ShareManager::ValidationError => e
              response.status = 422
              json_err(e.message)
            rescue ShareManager::AlreadyEnded => e
              response.status = 409
              json_err(e.message, result: ShareManager.result(share))
            end

            r.delete do
              was_live = share.live?
              ShareManager.stop(share, "stopped via api")
              json_ok(was_live ? "Share stopped" : "Already stopped", result: ShareManager.result(share))
            end
          end

          r.on("links") { share_links(share, all: true) }

          r.post "wait" do
            outcome = ShareManager.wait(share, timeout: r.params["timeout"], since: r.params["since"])
            message = if outcome[:ended] then "Share ended"
                      elsif outcome[:submitted] then "Answers submitted (##{outcome[:submissions]})"
                      else "Share still live"
                      end
            json_ok(message, **outcome)
          rescue ShareManager::ValidationError => e
            response.status = 422
            json_err(e.message)
          end
        end
      end
    end

    r.on "mcp" do
      api_authorized!

      r.post do
        McpServer.log_request(r) if Setting.get("mcp_debug")
        transport = MCP::Server::Transports::StreamableHTTPTransport.new(
          McpServer.build, stateless: true, dns_rebinding_protection: false
        )
        r.halt transport.handle_request(r)
      end

      r.is { halt_json(405, "Stateless endpoint: POST JSON-RPC messages to /mcp") }
    end

    r.on "s", String do |id|
      share = Share[id] or not_found_page!

      r.is { r.redirect("/s/#{id}/", 301) }

      r.get("status") { ShareManager.status(share) }
      r.on("links") { share_links(share) }

      if share.ended?
        r.post("stop") { json_ok("Already stopped") }
        r.put("draft") { ended_json(share) }
        r.post("submit") { ended_json(share) }
        response.status = 410
        next page("ended", title: share.title, share: share, result: ShareManager.result(share))
      end

      share.touch!
      r.post("stop") { stop_by_user(share) }

      r.put "draft" do
        form_share!(share)
        save_draft(share)
      end

      r.post "submit" do
        form_share!(share)
        submit_answers(share)
      end

      share_content(share)
    end

    # External links: read-only, no stop/draft/submit, never the share id.
    r.on "x", String do |token|
      link = LinkManager.find(token)
      r.get("status") { LinkManager.status(link) }
      not_found_page! unless link

      r.is { r.redirect("/x/#{token}/", 301) }
      share = link.share
      link_gone_page!(link) unless link.live? && share.live?

      share.via_link = link
      share.touch!
      share_content(share)
    end
  end
end
