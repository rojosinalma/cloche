# frozen_string_literal: true

module PathGuard
  class Denied < StandardError; end

  module_function

  # The allowed_roots setting as configured (unresolved); roots filters to the ones that exist.
  def configured_roots = Setting.get("allowed_roots")

  def roots
    configured_roots.filter_map { |root| realpath_or_nil(root) }
  end

  def within?(real, root) = real == root || real.start_with?("#{root}/")

  def allowed?(path)
    real = File.realpath(path)
    roots.any? { |root| within?(real, root) }
  rescue SystemCallError, ArgumentError
    false
  end

  def resolve(entry, rel)
    rel = rel.to_s
    target = entry.dir ? File.join(entry.path, rel) : file_target(entry, rel)
    return unless target && File.exist?(target)

    real = File.realpath(target)
    base = File.realpath(entry.path)
    real if within?(real, base) && allowed?(real)
  rescue SystemCallError, ArgumentError
    nil
  end

  def validate_paths(paths)
    Array(paths).map { |path| validate_path(path.to_s) }
  end

  def validate_path(path)
    expanded = expand_home(path)
    raise Denied, "#{path.inspect}: must be an absolute path" unless expanded.start_with?("/")
    raise Denied, "#{path}: no such file or directory" unless File.exist?(expanded)

    real = File.realpath(expanded)
    raise Denied, "#{real} is outside the allowed roots (#{roots.join(', ')})" unless allowed?(real)

    real
  rescue SystemCallError, ArgumentError => e
    raise Denied, "#{path}: #{e.message}"
  end

  def file_target(entry, rel)
    entry.path if rel.empty? || rel == entry.name
  end

  def expand_home(path)
    return path unless path == "~" || path.start_with?("~/")

    File.join(ENV.fetch("HOST_HOME", Dir.home), path.delete_prefix("~"))
  end

  def realpath_or_nil(path)
    File.realpath(path)
  rescue SystemCallError, ArgumentError
    nil
  end
end
