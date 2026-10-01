# frozen_string_literal: true

module WorkerPool
  MUTEX = Mutex.new

  class Pool
    def initialize(size:, queue_size:)
      @queue = SizedQueue.new(queue_size)
      @workers = Array.new(size) { |i| WorkerPool.safe_thread("pool-#{i}") { work } }
    end

    def post(&job)
      @queue.push(job, true)
      true
    rescue ThreadError
      $log.warn "[pool] queue full (#{@queue.max}), job dropped"
      false
    end

    private

    def work
      loop do
        job = @queue.pop
        begin
          job.call
        rescue Exception => e
          WorkerPool.log_error("pool job", e)
        end
      end
    end
  end

  module_function

  def safe_thread(name, &block)
    Thread.new do
      block.call
    rescue Exception => e
      log_error(name, e)
    end.tap { |t| t.name = name }
  end

  def pool
    MUTEX.synchronize do
      @pool ||= Pool.new(size: Integer(Setting.fetch("callback_pool_size", 2)),
                         queue_size: Integer(Setting.fetch("callback_queue_size", 100)))
    end
  end

  def log_error(name, error)
    $log.error "[thread] #{name}: #{error.class}: #{error.message}\n#{Array(error.backtrace).join("\n")}"
  end
end
