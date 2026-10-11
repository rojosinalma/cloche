# frozen_string_literal: true

require "cgi"
require "erb"
require "json"
require "net/http"
require "uri"

module Callback
  module_function

  ANSWERS_TEXT_MAX = 4000
  EVENTS = %i[ended submitted].freeze

  # event :ended when the share ends (any reason), :submitted on every Submit
  # of a form share (the share stays live, so more may follow).
  def deliver(share, event: :ended)
    WorkerPool.pool.post { push(share, event) }
  end

  def push(share, event = :ended)
    return $log.debug("[callback] #{share.id}: no session, skipped") if share.session_id.to_s.empty?
    return warn_no_password if password.to_s.empty?

    dir = share.session_directory.to_s
    dir = session_directory(share.session_id) if dir.empty?
    mode = Setting.fetch("callback_mode", "instruction")
    method, path, body = request_for(mode, share, event)
    response = send_json(method, path, dir, body)
    level = response.is_a?(Net::HTTPSuccess) ? :info : :warn
    $log.public_send(level, "[callback] #{event} #{mode} #{method.to_s.upcase} #{path} -> #{response.code}")
  rescue StandardError => e
    $log.error "[callback] #{path} failed: #{e.class}: #{e.message}\n#{Array(e.backtrace).join("\n")}"
  end

  def request_for(mode, share, event)
    sid = ERB::Util.url_encode(share.session_id)
    case mode
    when "prompt"
      [:post, "/api/session/#{sid}/prompt", { text: message(ShareManager.result(share), event), delivery: "queue" }]
    when "synthetic"
      [:post, "/api/session/#{sid}/synthetic",
       { text: message(ShareManager.result(share), event),
         description: event == :submitted ? "cloche answers submitted" : "cloche share ended", delivery: "queue" }]
    else
      [:put, "/api/experimental/session/#{sid}/instructions/entries/#{Setting.fetch('callback_entry_key', 'cloche')}",
       { value: instruction_value(share) }]
    end
  end

  def instruction_value(share)
    {
      note: "Recent cloche shares from this session, newest activity first: ended ones (`live: false`, `reason`, " \
            "`files` = what the user downloaded, name => times) and live form shares he has submitted " \
            "(`live: true`). Form results are under `answers` (field id => value; `submissions` counts the " \
            "submits, each one overwrites the last); a live share may still be resubmitted, so re-read it before " \
            "acting on it and stop_share when done. `draft` only appears when an ended share holds picks that " \
            "were never submitted. Only relevant if you were waiting on one of them.",
      shares: ShareManager.session_history(share.session_id, limit: Setting.fetch("callback_history", 3))
    }
  end

  def session_directory(session_id)
    path = "/api/session/#{ERB::Util.url_encode(session_id)}"
    response = http_call(Net::HTTP::Get.new(opencode_uri(path)))
    $log.info "[callback] GET #{path} -> #{response.code}"
    return "" unless response.is_a?(Net::HTTPSuccess)

    JSON.parse(response.body).dig("data", "location", "directory").to_s
  end

  def send_json(method, path, dir, body)
    uri = opencode_uri(path)
    uri.query = "directory=#{CGI.escape(dir)}" unless dir.empty?
    request = Net::HTTP.const_get(method.to_s.capitalize).new(uri)
    request["content-type"] = "application/json"
    request["x-opencode-directory"] = dir unless dir.empty?
    request.body = JSON.generate(body)
    http_call(request)
  end

  def opencode_uri(path) = URI("#{Setting.fetch('opencode_url', 'http://192.168.1.20:4096').chomp('/')}#{path}")

  def http_call(request)
    request.basic_auth(ENV.fetch("OPENCODE_SERVER_USERNAME", "opencode"), password)
    uri = request.uri
    Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https",
                                        open_timeout: Integer(Setting.fetch("callback_open_timeout", 5)),
                                        read_timeout: Integer(Setting.fetch("callback_read_timeout", 15))) do |http|
      http.request(request)
    end
  end

  def message(result, event = :ended)
    return submitted_message(result) if event == :submitted

    files = field(result, :files) || {}
    downloads = files.map { |name, n| n > 1 ? "#{name} ×#{n}" : name }
    lines = [
      %([cloche] Share "#{field(result, :title)}" ended: #{field(result, :reason)} after #{field(result, :duration)}.),
      "Downloads: #{downloads.empty? ? 'none' : downloads.join(', ')}",
      "Paths: #{Array(field(result, :paths)).join(', ')}"
    ]
    lines << answers_block(result) if field(result, :answers)
    lines.join("\n")
  end

  def submitted_message(result)
    [%([cloche] Share "#{field(result, :title)}": answers submitted (##{field(result, :submissions)})),
     answers_block(result)].join("\n")
  end

  def answers_block(result)
    answers = field(result, :answers) || {}
    text = answers.map { |id, value| "#{id}: #{value.is_a?(Array) ? value.join(', ') : value}" }.join("\n")
    text = "#{text[0, ANSWERS_TEXT_MAX]}\n… (truncated)" if text.size > ANSWERS_TEXT_MAX
    "Answers:\n#{text.empty? ? '(none)' : text}"
  end

  def field(result, key) = result.key?(key) ? result[key] : result[key.to_s]

  def password = ENV["OPENCODE_SERVER_PASSWORD"]

  def warn_no_password
    return if @warned_no_password

    @warned_no_password = true
    $log.warn "[callback] OPENCODE_SERVER_PASSWORD unset, session callbacks disabled"
  end
end
