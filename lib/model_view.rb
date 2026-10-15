# frozen_string_literal: true

# The 3D model preview (STL/3MF/OBJ) is parsed in the browser (Three.js) from
# the file's ?model=1 URL; the server only owns the size cap and the labels.
module ModelView
  LABELS = { "stl" => "STL", "3mf" => "3MF", "obj" => "OBJ" }.freeze

  module_function

  def max_bytes = Setting.get("model_view_max_bytes")

  def label(format) = LABELS.fetch(format.to_s.downcase, format.to_s.upcase)
end
