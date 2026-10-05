Sequel.migration do
  change do
    add_column :shares, :idle_timeout, Integer
  end
end
