# frozen_string_literal: true

# Decides what the 3D model viewer card shows for an STL/3MF/OBJ file. The
# geometry itself is parsed in the browser (Three.js) from the file's
# ?preview=1 URL; the server only checks the size cap and labels the card.
module ModelView
  LABELS = { ".stl" => "STL", ".3mf" => "3MF", ".obj" => "OBJ" }.freeze
  DEFAULT_MAX_BYTES = 100 * 1024 * 1024

  View = Struct.new(:name, :size, :format, :label, :too_large, :max_bytes, keyword_init: true) do
    def too_large? = too_large
  end

  module_function

  def max_bytes = Setting.fetch("model_view_max_bytes", DEFAULT_MAX_BYTES)

  def build(real, name:)
    ext = File.extname(real).downcase
    format = ext.delete_prefix(".")
    size = File.size(real)
    limit = max_bytes
    View.new(name: name, size: size, format: format, label: LABELS.fetch(ext, format.upcase),
             too_large: size > limit, max_bytes: limit)
  end
end
