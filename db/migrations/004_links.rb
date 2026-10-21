Sequel.migration do
  change do
    create_table(:links) do
      primary_key :id
      String :token, null: false, unique: true
      foreign_key :share_id, :shares, type: String, null: false, on_delete: :cascade
      Time :created_at, null: false
      Time :expires_at
      Time :revoked_at
      index :share_id
    end

    alter_table(:downloads) do
      add_column :link_id, Integer
    end
  end
end
