# frozen_string_literal: true

require "json"
require "mcp"
require "rack/mock"
require "uri"

# MCP tools are thin in-process clients of the /api routes, so validation and
# side effects are identical to the REST path.
module McpServer
  TOOLS = []
  SESSION_SCHEMA = {
    type: "object",
    description: "The calling opencode session; when given, a message lands in it when the share ends",
    properties: {
      id: { type: "string", description: "Session id ($OPENCODE_SESSION_ID / the busy session in your cwd)" },
      directory: { type: "string", description: "The session's working directory (absolute)" }
    },
    required: %w[id directory]
  }.freeze

  module_function

  def api(method, path, body = nil)
    env = { "HTTP_AUTHORIZATION" => "Bearer #{ENV['CLOCHE_MCP_TOKEN']}", "CONTENT_TYPE" => "application/json" }
    env[:input] = JSON.generate(body) if body
    res = Rack::MockRequest.new(App).request(method.to_s.upcase, path, env)
    $log.info "[mcp] #{method.to_s.upcase} #{path} -> #{res.status}"
    res
  end

  def api_text(method, path, body = nil)
    res = api(method, path, body)
    data = JSON.parse(res.body)
    raise "API returned #{res.status}: #{data['message'] || res.body[0, 200]}" if res.status >= 400

    text(data)
  rescue JSON::ParserError
    raise "API returned #{res.status} with a non-JSON body"
  end

  def text(data)
    MCP::Tool::Response.new([{ type: "text", text: data.is_a?(String) ? data : JSON.pretty_generate(data) }])
  end

  def share_path(id, suffix = "") = "/api/shares/#{URI.encode_www_form_component(id.to_s.strip)}#{suffix}"

  def register(name, desc, schema, &handler)
    klass = Class.new(MCP::Tool) do
      tool_name name
      description desc
      input_schema(**schema)
      define_singleton_method(:call) do |server_context: nil, **args|
        McpServer.run_tool(name, args, handler)
      end
    end
    TOOLS << klass
  end

  def run_tool(name, args, handler)
    $log.info "[mcp] tool=#{name} args=#{args.to_json}"
    handler.call(args)
  rescue StandardError => e
    $log.error "[mcp] tool=#{name} failed: #{e.message}"
    text("Error: #{e.message}")
  end

  def build
    MCP::Server.new(
      name: "cloche",
      title: "cloche",
      version: "1.0.0",
      instructions: "Shares files and folders from this host with the user's browser as a gallery page " \
                    "(previews, downloads, zip). Paths are absolute host paths under ~/projects, ~/data or " \
                    "~/.opencode/plan. Hand the user the returned `url` (not lan_url). Pass " \
                    "session {id: $OPENCODE_SESSION_ID, directory: <your cwd>} to create_share and a message " \
                    "saying how the share ended and what was downloaded lands in your session; otherwise " \
                    "use wait_share. Stop shares you no longer need with stop_share.",
      tools: TOOLS
    )
  end

  register "create_share",
           "Share files and/or folders with the user. Returns the share url to hand him. raw=true serves " \
           "exactly one folder as a plain static site (HTML renders, relative links work).",
           { properties: {
               paths: { type: "array", items: { type: "string" }, description: "Absolute host paths" },
               title: { type: "string", description: "Page heading (defaults to the basename or \"N items\")" },
               raw: { type: "boolean", description: "Serve one folder as a static site instead of a gallery" },
               session: SESSION_SCHEMA
             }, required: %w[paths] } do |args|
    api_text(:post, "/api/shares", args.slice(:paths, :title, :raw, :session))
  end

  register "list_shares",
           "List live shares and shares that ended within the retention window.",
           { properties: {}, required: [] } do
    api_text(:get, "/api/shares")
  end

  register "get_share",
           "One share with its download log and, if it has ended, its result.",
           { properties: { id: { type: "string", description: "Share id" } }, required: %w[id] } do |args|
    api_text(:get, share_path(args[:id]))
  end

  register "stop_share",
           "End a share now (reason \"stopped via api\"). Its links stop working.",
           { properties: { id: { type: "string", description: "Share id" } }, required: %w[id] } do |args|
    api_text(:delete, share_path(args[:id]))
  end

  register "wait_share",
           "Block until the share ends or the timeout passes. Returns {ended: true, result} or " \
           "{ended: false} — call again to keep waiting.",
           { properties: {
               id: { type: "string", description: "Share id" },
               timeout: { type: "integer", description: "Seconds to wait (capped at the server's wait_max_timeout, default 300)" }
             }, required: %w[id] } do |args|
    query = args[:timeout] ? "?timeout=#{Integer(args[:timeout])}" : ""
    api_text(:post, share_path(args[:id], "/wait#{query}"))
  end

  TOOLS.freeze
end
