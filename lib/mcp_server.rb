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
    description: "Override the session that gets the end-of-share message; normally omitted (detected from the MCP request)",
    properties: {
      id: { type: "string", description: "opencode session id ($OPENCODE_SESSION_ID in an agent shell)" },
      directory: { type: "string", description: "The session's working directory; looked up from opencode when omitted" }
    },
    required: %w[id]
  }.freeze

  IDLE_SCHEMA = {
    type: "integer",
    description: "Seconds of inactivity before the share ends. 0 = never, stays up until stopped. " \
                 "Omitted = the server default (the idle_timeout setting, 30 min unless changed). Any request or download restarts the clock."
  }.freeze

  OPTION_SCHEMA = {
    description: "Choices for checklist/radio/select: a plain string (value = label) or {value, label?, hint?}. " \
                 "Values must be unique, non-empty strings; the answer carries the value, the user sees the label.",
    oneOf: [
      { type: "string" },
      { type: "object", properties: { value: { type: "string" }, label: { type: "string" }, hint: { type: "string" } },
        required: %w[value] }
    ]
  }.freeze

  FIELD_SCHEMA = {
    type: "object",
    description: "One question. Types and their answer values: checklist → array of option values (props: options, " \
                 "min, max); radio and select → one option value (options); text → string (multiline, placeholder, " \
                 "max_chars); tasklist → array of 1-based ordinals of the task items in `markdown` or in the file at " \
                 "`path` (lines `- [ ] item`; `[x]` items are pre-ticked; other lines are shown as prose); markdown → " \
                 "static prose from `markdown` or `path`, no answer. Common: id (a-z0-9_, unique; markdown fields may " \
                 "omit it), label, help, required, default (same shape as the answer).",
    properties: {
      id: { type: "string", description: "Answer key, /^[a-z0-9_]{1,64}$/" },
      type: { type: "string", enum: %w[checklist radio select text tasklist markdown] },
      label: { type: "string", description: "The question" },
      help: { type: "string", description: "Short hint under the label" },
      required: { type: "boolean" },
      default: { description: "Pre-filled answer: array for checklist/tasklist, string otherwise" },
      options: { type: "array", items: OPTION_SCHEMA, description: "checklist/radio/select choices (≥1)" },
      min: { type: "integer", description: "checklist/tasklist: least picks allowed when answered" },
      max: { type: "integer", description: "checklist/tasklist: most picks allowed" },
      multiline: { type: "boolean", description: "text: textarea instead of one line" },
      placeholder: { type: "string", description: "text: placeholder" },
      max_chars: { type: "integer", description: "text: cap (≤ the server's form_text_max_chars, default 4000)" },
      markdown: { type: "string", description: "tasklist/markdown: inline Markdown (GFM)" },
      path: { type: "string", description: "tasklist/markdown: absolute path of a Markdown file under an allowed root, read once now" }
    },
    required: %w[type]
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
        McpServer.run_tool(name, args, handler, McpServer.caller_session(server_context))
      end
    end
    TOOLS << klass
  end

  def run_tool(name, args, handler, session_id)
    $log.info "[mcp] tool=#{name} args=#{args.to_json} session=#{session_id}"
    handler.call(args, session_id)
  rescue StandardError => e
    $log.error "[mcp] tool=#{name} failed: #{e.message}"
    text("Error: #{e.message}")
  end

  def log_request(request)
    body = request.body.read
    request.body.rewind
    $log.info "[mcp] raw #{body[0, 2000]}"
  end

  SESSION_META_KEYS = %w[ai.opencode/sessionID sessionID].freeze

  def caller_session(server_context)
    meta = server_context && (server_context[:_meta] || server_context["_meta"])
    return unless meta

    SESSION_META_KEYS.map { |k| meta[k] || meta[k.to_sym] }.compact.first
  rescue StandardError
    nil
  end

  def build
    MCP::Server.new(name: "cloche", title: "cloche", version: "1.0.0", instructions: instructions, tools: TOOLS)
  end

  # Built per request so the roots and the idle default reflect the live settings.
  def instructions
    roots = PathGuard.configured_roots
    "Shares files and folders from this host with the user's browser as a gallery page " \
      "(image/video/audio previews, a card viewer for text files — Markdown rendered, JSON/CSV " \
      "pretty, source highlighted — downloads, zip). Paths are absolute host paths under " \
      "#{roots.empty? ? 'the configured allowed_roots (none set)' : roots.join(', ')}. Hand the user the returned " \
      "`url` (not lan_url). create_share learns the calling session from the MCP request, so when the share ends " \
      "a message saying how it ended and what was downloaded lands in your session automatically; no waiting " \
      "needed. Shares end after #{Listing.human_duration(Setting.get('idle_timeout'))} idle by default; pass " \
      "idle_timeout (seconds, 0 = never) to create_share or update_share to change that. Stop shares you no " \
      "longer need with stop_share. create_form shares a questionnaire instead (checklists, radios, selects, text, " \
      "Markdown task lists): the user answers in the browser, every Submit reaches your session as a callback and " \
      "is readable via wait_share/get_share under `answers`. get_settings/set_setting read and change the server " \
      "settings (roots, URLs, timeouts); changes apply immediately."
  end

  register "create_share",
           "Share files and/or folders with the user. Returns the share url to hand the user. Text files " \
           "(logs, Markdown, JSON, CSV, code …) get a View button that opens them readable in the page, " \
           "so this also hands over things to read, not just download. raw=true serves " \
           "exactly one folder as a plain static site (HTML renders, relative links work). To ask the user " \
           "questions (picks, choices, free text) use create_form instead.",
           { properties: {
               paths: { type: "array", items: { type: "string" }, description: "Absolute host paths under an allowed root (see get_settings → allowed_roots)" },
               title: { type: "string", description: "Page heading (defaults to the basename or \"N items\")" },
               raw: { type: "boolean", description: "Serve one folder as a static site instead of a gallery" },
               idle_timeout: IDLE_SCHEMA,
               session: SESSION_SCHEMA
             }, required: %w[paths] } do |args, session_id|
    body = args.slice(:paths, :title, :raw, :idle_timeout, :session)
    body[:session] ||= { id: session_id } if session_id
    api_text(:post, "/api/shares", body)
  end

  register "create_form",
           "Ask the user questions in their browser: a form share with checklists, radio/select choices, free text, " \
           "Markdown task lists (every `- [ ]` becomes a live checkbox) and static Markdown. Hand the user the returned " \
           "`url`. They can save as they go (server-side draft) and Submit; Submit keeps the share open so they may " \
           "resubmit (each submit overwrites, `submissions` counts). Every submit lands in your session as a " \
           "callback and is readable with wait_share (pass since=<submissions seen>) or get_share under `answers` " \
           "(field id → value). Optional paths show files under the form (a gallery) so the user can look at what they are " \
           "deciding about. Form shares default to a 24 h idle timeout. Call stop_share when you have what you need.",
           { properties: {
               title: { type: "string", description: "Page heading (defaults to \"Questions\")" },
               intro: { type: "string", description: "Markdown shown above the fields" },
               fields: { type: "array", items: FIELD_SCHEMA, description: "The questions, in order (≤ 50)" },
               paths: { type: "array", items: { type: "string" }, description: "Optional absolute host paths to show under the form" },
               idle_timeout: IDLE_SCHEMA,
               session: SESSION_SCHEMA
             }, required: %w[fields] } do |args, session_id|
    body = args.slice(:paths, :title, :idle_timeout, :session)
    body[:form] = { intro: args[:intro], fields: args[:fields] }.compact
    body[:session] ||= { id: session_id } if session_id
    api_text(:post, "/api/shares", body)
  end

  register "update_share",
           "Change the idle timeout of a live share: extend it, or set 0 to keep it up until stopped. " \
           "Restarts the idle clock from now.",
           { properties: {
               id: { type: "string", description: "Share id" },
               idle_timeout: IDLE_SCHEMA
             }, required: %w[id idle_timeout] } do |args|
    api_text(:patch, share_path(args[:id]), { idle_timeout: args[:idle_timeout] })
  end

  register "list_shares",
           "List live shares and shares that ended within the retention window.",
           { properties: {}, required: [] } do
    api_text(:get, "/api/shares")
  end

  register "get_share",
           "One share with its download log and, if it has ended, its result. A form share also carries `form` " \
           "(the normalised spec), `draft` (what the user has picked so far) and `answers` (the last submit, " \
           "null until the first one).",
           { properties: { id: { type: "string", description: "Share id" } }, required: %w[id] } do |args|
    api_text(:get, share_path(args[:id]))
  end

  register "stop_share",
           "End a share now (reason \"stopped via api\"). Its links stop working.",
           { properties: { id: { type: "string", description: "Share id" } }, required: %w[id] } do |args|
    api_text(:delete, share_path(args[:id]))
  end

  register "wait_share",
           "Block until the share ends, a form submission newer than `since` lands, or the timeout passes. Three " \
           "outcomes: {ended: true, result} (result carries `answers` for a form share); {ended: false, " \
           "submitted: true, submissions, submitted_at, answers} as soon as submissions > since (returns at once " \
           "if that already happened); {ended: false, submitted: false} on timeout — call again, passing the " \
           "`submissions` you have seen as `since`.",
           { properties: {
               id: { type: "string", description: "Share id" },
               timeout: { type: "integer", description: "Seconds to wait (capped at the server's wait_max_timeout, default 300)" },
               since: { type: "integer", description: "The submission count you have already seen (default 0): return as soon as it is higher" }
             }, required: %w[id] } do |args|
    query = { timeout: args[:timeout], since: args[:since] }.compact.map { |k, v| "#{k}=#{Integer(v)}" }.join("&")
    api_text(:post, share_path(args[:id], "/wait#{query.empty? ? '' : "?#{query}"}"))
  end

  register "get_settings",
           "List every server setting: key, current value (as stored), default and source (\"db\" when set, " \
           "\"default\" otherwise). Covers allowed_roots (comma-separated absolute paths shareable), public_base_url, " \
           "lan_base_url, opencode_url, idle timeouts, viewer caps, form limits, callback mode.",
           { properties: {}, required: [] } do
    api_text(:get, "/api/settings")
  end

  register "set_setting",
           "Change one server setting; applies immediately, no restart. value is a string in the stored form " \
           "(integers as digits, booleans true/false, lists comma-separated). Omit value (or pass null) to reset " \
           "the key to its default. Unknown keys and values that do not fit the key's type are rejected.",
           { properties: {
               key: { type: "string", description: "Setting key (see get_settings)" },
               value: { type: %w[string null], description: "New value as a string; null/omitted resets to the default" }
             }, required: %w[key] } do |args|
    path = "/api/settings/#{URI.encode_www_form_component(args[:key].to_s.strip)}"
    args[:value].nil? ? api_text(:delete, path) : api_text(:put, path, { value: args[:value].to_s })
  end

  TOOLS.freeze
end
