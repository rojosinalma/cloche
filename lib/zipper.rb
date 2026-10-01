# frozen_string_literal: true

require "fileutils"
require "open3"
require "set"
require "tmpdir"

# Builds a zip of validated files by mirroring them as symlinks in a scratch
# dir, so links inside a served folder that escape it are never followed.
class Zipper
  CHUNK_SIZE = 64 * 1024

  def initialize(items)
    @items = items
  end

  def each
    @tmp = Dir.mktmpdir("cloche-zip-")
    @items.each { |arc, path, scope| mirror(path, File.join(@tmp, arc), scope, Set.new) }
    spawn_zip
    loop { yield @stdout.readpartial(CHUNK_SIZE) }
  rescue EOFError
    report_exit
  end

  def close
    kill_child
    @err_reader&.join(2)
    [@stdout, @stderr].each { |io| io.close if io && !io.closed? }
    FileUtils.rm_rf(@tmp) if @tmp
  end

  private

  def spawn_zip
    stdin, @stdout, @stderr, @wait = Open3.popen3("zip", "-q", "-r", "-", ".", chdir: @tmp)
    stdin.close
    err = @stderr
    @err_reader = WorkerPool.safe_thread("zip-stderr") { err.each_line { |l| $log.warn "[zipper] #{l.chomp}" } }
  end

  def report_exit
    status = @wait.value
    $log.warn "[zipper] zip exited #{status.exitstatus}" unless status.success?
  end

  def kill_child
    return unless @wait&.alive?

    Process.kill("TERM", @wait.pid)
    @wait.join(2)
  rescue Errno::ESRCH
    nil
  end

  def mirror(path, dst, scope, seen)
    real = File.realpath(path)
    return unless PathGuard.within?(real, scope) && PathGuard.allowed?(real) && seen.add?(real)

    if File.directory?(real)
      Dir.mkdir(dst)
      Dir.each_child(real) { |c| mirror(File.join(real, c), File.join(dst, c), scope, seen) }
    elsif File.file?(real)
      File.symlink(real, dst)
    end
  rescue SystemCallError => e
    $log.debug "[zipper] skipped #{path}: #{e.message}"
  end
end
