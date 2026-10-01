# frozen_string_literal: true

require "json"
require "roda"
require "rack/utils"

require_relative "lib/logger"
require_relative "models/database"
require_relative "lib/worker_pool"
require_relative "lib/idle_sweeper"

# Stateful modules above load once; everything below reloads in development.
%w[
  models/setting models/share models/download
  lib/path_guard lib/listing lib/share_manager lib/zipper lib/file_server lib/callback lib/mcp_server
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
  plugin :public
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

  def page(template, title:, idle_label: nil, **locals)
    view(template, locals: locals.merge(idle_label: idle_label),
                   layout_opts: { locals: { title: title, idle_label: idle_label,
                                            expires_at: locals[:expires_at], status_url: locals[:base] && "#{locals[:base]}/status" } })
  end

  def not_found_page!
    response.status = 404
    response.write(page("not_found", title: "Not found"))
    request.halt
  end

  def decode_path(path) = Rack::Utils.unescape_path(path.to_s).dup.force_encoding(Encoding::UTF_8)

  def gallery(share, items, crumbs:, zip_href:)
    media = items.select { |i| Listing.media?(i) }
    page("gallery", title: share.title, idle_label: ShareManager.idle_label,
                    expires_at: ShareManager.expires_at(share).to_i,
                    share: share, base: Listing.base(share), crumbs: crumbs, media: media, files: items - media,
                    total_size: items.sum { |i| i.size.to_i }, zip_href: zip_href)
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

    request.halt FileServer.serve(request: request, share: share, real_path: real,
                                  name: rel.empty? ? File.basename(real) : rel,
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

  route do |r|
    r.public

    r.root { page("landing", title: "cloche") }

    r.get("health") { { status: "ok", live_shares: ShareManager.live.count } }

    r.on "api" do
      api_authorized!

      r.on "shares" do
        r.is do
          r.get do
            shares = ShareManager.list
            json_ok("#{shares.size} share(s)", shares: shares)
          end

          r.post do
            body = r.POST
            share = ShareManager.create(paths: body["paths"], title: body["title"], raw: body["raw"],
                                        session: body["session"])
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

            r.delete do
              was_live = share.live?
              ShareManager.stop(share, "stopped via api")
              json_ok(was_live ? "Share stopped" : "Already stopped", result: ShareManager.result(share))
            end
          end

          r.post "wait" do
            result = ShareManager.wait(share, timeout: r.params["timeout"])
            result ? json_ok("Share ended", ended: true, result: result) : json_ok("Share still live", ended: false)
          end
        end
      end
    end

    r.on "mcp" do
      api_authorized!

      r.post do
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

      if share.ended?
        r.post("stop") { json_ok("Already stopped") }
        response.status = 410
        next page("ended", title: share.title, share: share, result: ShareManager.result(share))
      end

      share.touch!
      r.post("stop") { stop_by_user(share) }

      r.get do
        next raw_served(share, decode_path(r.remaining_path)) if share.raw

        r.root do
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
  end
end
