# frozen_string_literal: true

require "cgi"
require "erb"
require "json"
require "net/http"
require "uri"

module Callback
  module_function

  def deliver(share)
    WorkerPool.pool.post { push(share) }
  end

  def push(share)
    return $log.debug("[callback] #{share.id}: no session, skipped") if share.session_id.to_s.empty?
    return warn_no_password if password.to_s.empty?

    dir = share.session_directory.to_s
    dir = session_directory(share.session_id) if dir.empty?
    path = "/api/session/#{ERB::Util.url_encode(share.session_id)}/prompt"
    response = post(path, dir, message(ShareManager.result(share)))
    level = response.is_a?(Net::HTTPSuccess) ? :info : :warn
    $log.public_send(level, "[callback] POST #{path} -> #{response.code}")
  rescue StandardError => e
    $log.error "[callback] POST #{path} failed: #{e.class}: #{e.message}\n#{Array(e.backtrace).join("\n")}"
  end

  def session_directory(session_id)
    path = "/api/session/#{ERB::Util.url_encode(session_id)}"
    response = http_call(Net::HTTP::Get.new(opencode_uri(path)))
    $log.info "[callback] GET #{path} -> #{response.code}"
    return "" unless response.is_a?(Net::HTTPSuccess)

    JSON.parse(response.body).dig("data", "location", "directory").to_s
  end

  def post(path, dir, text)
    uri = opencode_uri(path)
    uri.query = "directory=#{CGI.escape(dir)}" unless dir.empty?
    request = Net::HTTP::Post.new(uri)
    request["content-type"] = "application/json"
    request["x-opencode-directory"] = dir unless dir.empty?
    request.body = JSON.generate(text: text, delivery: "queue")
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

  def message(result)
    files = field(result, :files) || {}
    downloads = files.map { |name, n| n > 1 ? "#{name} ×#{n}" : name }
    [
      %([cloche] Share "#{field(result, :title)}" ended: #{field(result, :reason)} after #{field(result, :duration)}.),
      "Downloads: #{downloads.empty? ? 'none' : downloads.join(', ')}",
      "Paths: #{Array(field(result, :paths)).join(', ')}"
    ].join("\n")
  end

  def field(result, key) = result.key?(key) ? result[key] : result[key.to_s]

  def password = ENV["OPENCODE_SERVER_PASSWORD"]

  def warn_no_password
    return if @warned_no_password

    @warned_no_password = true
    $log.warn "[callback] OPENCODE_SERVER_PASSWORD unset, session callbacks disabled"
  end
end
