# frozen_string_literal: true

require "erb"

module Listing
  ICONS = { dir: "folder-fill", file: "file-earmark" }.freeze
  MEDIA_KINDS = %i[image video audio].freeze
  SIZE_UNITS = %w[B KB MB GB TB].freeze

  # viewers: per matching viewer its id, data URL and views (the preview
  # modal's data-viewers), empty when nothing can show the file.
  Item = Struct.new(:name, :kind, :size, :mtime, :href, :view_href, :zip_href, :icon, :preview_src, :format, :viewers,
                    keyword_init: true) do
    def previewable? = Listing.previewable?(kind)
  end

  module_function

  # The kind of the file's primary viewer (:text, :image, :model, …), :file
  # when no viewer matches. Only media kinds are served inline; everything
  # else stays an attachment outside the viewers' own data routes.
  def kind_of(path)
    return :dir if File.directory?(path)

    Preview.matching(path).first&.kind || :file
  end

  def media?(item) = MEDIA_KINDS.include?(item.kind)

  def media_kind?(kind) = MEDIA_KINDS.include?(kind)

  # Every file a viewer matches opens in the preview modal on the gallery
  # page; nothing in a share has a page of its own.
  def previewable?(kind) = !%i[dir file].include?(kind)

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

  # /s/<id>, or /x/<token> when the request came through an external link.
  def base(share) = share.base_path

  def encode(rel) = rel.to_s.split("/").reject(&:empty?).map { |s| ERB::Util.url_encode(s) }.join("/")

  def href(share, index, rel, dir: false)
    path = encode(rel)
    "#{base(share)}/p/#{index}/#{path}#{'/' if dir && !path.empty?}"
  end

  def item(share, index, rel, real, name)
    stat = File.stat(real)
    if File.directory?(real)
      link = href(share, index, rel, dir: true)
      return Item.new(name: name, kind: :dir, mtime: stat.mtime, href: link, view_href: link,
                      zip_href: "#{link}?zip=1", icon: icon_for(:dir), viewers: [])
    end

    link = href(share, index, rel)
    target = Preview::Target.new(real)
    viewers = Preview.matching(real, target: target)
    kind = viewers.first&.kind || :file
    Item.new(name: name, kind: kind, size: stat.size, mtime: stat.mtime, href: "#{link}?dl=1",
             view_href: viewers.empty? ? link : "#{link}?view=1", preview_src: preview_src(link, kind),
             format: File.extname(real).delete(".").downcase, icon: viewers.first&.icon || icon_for(:file),
             viewers: viewers.map { |v| v.to_item(target, link) })
  end

  # Gallery thumbnails and inline players load media from ?preview=1, which
  # does not count; each viewer's own fetch is in Item#viewers.
  def preview_src(link, kind) = media_kind?(kind) ? "#{link}?preview=1" : nil

  # The gallery page that lists the item at rel; a ?view=1 deep link to a
  # previewable file lands there with the modal open.
  def container_href(share, index, rel)
    return href(share, index, File.dirname(rel), dir: true) if rel.include?("/")

    entry = share.entries[index]
    return "#{base(share)}/" if !entry.dir || share.single_dir?

    href(share, index, "", dir: true)
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
