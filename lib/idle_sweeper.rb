# frozen_string_literal: true

module IdleSweeper
  MUTEX = Mutex.new
  THREAD_NAME = "idle-sweeper"
  FALLBACK_INTERVAL = 60
  @in_flight = Hash.new(0)

  module_function

  def begin_transfer(id)
    MUTEX.synchronize { @in_flight[id] += 1 }
  end

  def end_transfer(id)
    MUTEX.synchronize do
      @in_flight[id] -= 1
      @in_flight.delete(id) unless @in_flight[id].positive?
    end
  end

  def in_flight?(id)
    MUTEX.synchronize { @in_flight.key?(id) }
  end

  # Looked up by thread name and via ::IdleSweeper so a code reload neither
  # starts a second sweeper nor leaves the running one on stale code.
  def start
    MUTEX.synchronize do
      return if Thread.list.any? { |t| t.name == THREAD_NAME && t.alive? }

      WorkerPool.safe_thread(THREAD_NAME) { ::IdleSweeper.run }
    end
  end

  def run
    loop do
      sleep ::IdleSweeper.interval
      ::IdleSweeper.sweep
    rescue StandardError => e
      WorkerPool.log_error(THREAD_NAME, e)
    end
  end

  def interval
    (idle_timeout / 5.0).clamp(1, 60)
  rescue StandardError
    FALLBACK_INTERVAL
  end

  def idle_timeout = Integer(Setting.fetch("idle_timeout", 1800))

  def sweep
    limit = idle_timeout
    cutoff = Time.now - limit
    ShareManager.live.to_a.each { |share| check(share, cutoff, limit) }
    ShareManager.purge_expired!
  end

  def check(share, cutoff, limit)
    if in_flight?(share.id)
      share.touch!
    elsif share.last_activity_at < cutoff
      require_relative "listing" unless defined?(::Listing)
      ShareManager.stop(share, "idle timeout (#{::Listing.human_duration(limit)})")
      $log.info "[idle] #{share.id} stopped after #{limit}s idle"
    end
  rescue StandardError => e
    WorkerPool.log_error("#{THREAD_NAME} #{share.id}", e)
  end
end
