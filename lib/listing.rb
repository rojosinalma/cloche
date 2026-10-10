# frozen_string_literal: true

require "erb"

module Listing
  KINDS = {
    image: %w[png jpg jpeg gif webp svg avif bmp ico].freeze,
    video: %w[mp4 webm ogv m4v mov].freeze,
    audio: %w[mp3 ogg oga wav flac m4a opus aac].freeze,
    model: %w[stl 3mf obj].freeze
  }.freeze
  ICONS = { dir: "folder-fill", image: "file-earmark-image", video: "file-earmark-play",
            audio: "file-earmark-music", text: "file-earmark-text", model: "box", file: "file-earmark" }.freeze
  MEDIA_KINDS = %i[image video audio].freeze
  VIEWABLE_KINDS = %i[text model].freeze
  SIZE_UNITS = %w[B KB MB GB TB].freeze

  Item = Struct.new(:name, :kind, :size, :mtime, :href, :view_href, :zip_href, :icon, keyword_init: true)

  module_function

  # :text is any file the viewer can show (see TextView.text?) and :model a
  # 3D file for the model viewer; both are still served as attachments like
  # every other non-media file. Extensions win, so an ASCII STL is :model.
  def kind_of(path)
    return :dir if File.directory?(path)

    ext = File.extname(path).delete(".").downcase
    KINDS.find { |_, exts| exts.include?(ext) }&.first || (TextView.text?(path) ? :text : :file)
  end

  def media?(item) = MEDIA_KINDS.include?(item.kind)

  def media_kind?(kind) = MEDIA_KINDS.include?(kind)

  def viewable?(kind) = VIEWABLE_KINDS.include?(kind)

  def icon_for(kind) = ICONS.fetch(kind, ICONS[:file])

  def human_size(bytes)
    bytes = bytes.to_i
    i = bytes.positive? ? [(Math.log(bytes) / Math.log(1024)).floor, SIZE_UNITS.size - 1].min : 0
    i.zero? ? "#{bytes} B" : format("%.1f %s", bytes.to_f / (1024**i), SIZE_UNITS[i])
  end

  def human_duration(seconds)
    seconds = seconds.to_i
    return "#{seconds}s" if seconds < 60
    return "#{seconds / 60}m" if seconds < 3600 && (seconds % 60).zero?
    return "#{seconds / 60}m#{format('%02d', seconds % 60)}s" if seconds < 3600

    "#{seconds / 3600}h#{format('%02d', seconds % 3600 / 60)}m"
  end

  def base(share) = "/s/#{share.id}"

  def encode(rel) = rel.to_s.split("/").reject(&:empty?).map { |s| ERB::Util.url_encode(s) }.join("/")

  def href(share, index, rel, dir: false)
    path = encode(rel)
    "#{base(share)}/p/#{index}/#{path}#{'/' if dir && !path.empty?}"
  end

  def item(share, index, rel, real, name)
    kind = kind_of(real)
    stat = File.stat(real)
    if kind == :dir
      link = href(share, index, rel, dir: true)
      Item.new(name: name, kind: kind, mtime: stat.mtime, href: link, view_href: link,
               zip_href: "#{link}?zip=1", icon: icon_for(kind))
    else
      link = href(share, index, rel)
      Item.new(name: name, kind: kind, size: stat.size, mtime: stat.mtime, href: "#{link}?dl=1",
               view_href: viewable?(kind) ? "#{link}?view=1" : link, icon: icon_for(kind))
    end
  end

  def top_items(share)
    share.entries.each_with_index.filter_map do |entry, i|
      item(share, i, entry.dir ? "" : entry.name, entry.path, entry.name)
    rescue SystemCallError
      nil
    end
  end

  # Child hrefs use real_dir's canonical location inside the entry, so a
  # folder reached through an internal symlink still links back correctly.
  def dir_items(share, index, real_dir)
    entry = share.entries[index] or return []
    rel = relative_to_entry(entry, real_dir) or return []
    children(real_dir).filter_map do |child|
      child_rel = [rel, child].reject(&:empty?).join("/")
      real = PathGuard.resolve(entry, child_rel) or next
      item(share, index, child_rel, real, child)
    rescue SystemCallError
      nil
    end.sort_by { |i| [i.kind == :dir ? 0 : 1, i.name.downcase] }
  end

  def crumbs(share, index, rel)
    entry = share.entries[index] or return []
    parts = rel.to_s.split("/").reject(&:empty?)
    trail = share.single_dir? ? [] : [[entry.name, href(share, index, "", dir: true)]]
    trail + parts.each_index.map { |i| [parts[i], href(share, index, parts[0..i].join("/"), dir: true)] }
  end

  def all_zip_items(share)
    names = Hash.new(0)
    share.entries.map do |entry|
      names[entry.name] += 1
      [unique_name(entry.name, names[entry.name]), entry.path, entry.dir ? entry.path : File.dirname(entry.path)]
    end
  end

  def dir_zip_items(real_dir, scope: real_dir, name: File.basename(real_dir))
    [[name, real_dir, scope]]
  end

  def unique_name(name, count)
    return name if count == 1

    "#{File.basename(name, '.*')} (#{count})#{File.extname(name)}"
  end

  def relative_to_entry(entry, real_dir)
    root = File.realpath(entry.path)
    return "" if real_dir == root

    real_dir.delete_prefix("#{root}/") if PathGuard.within?(real_dir, root)
  rescue SystemCallError
    nil
  end

  def children(dir)
    Dir.children(dir)
  rescue SystemCallError
    []
  end
end
