Sequel.migration do
  change do
    create_table(:settings) do
      String :key, primary_key: true
      String :value, text: true
    end

    create_table(:shares) do
      String :id, primary_key: true
      String :title, null: false
      TrueClass :raw, null: false, default: false
      String :paths, text: true, null: false
      String :session_id
      String :session_directory, text: true
      Time :started_at, null: false
      Time :last_activity_at, null: false
      Time :ended_at
      String :end_reason
      index :ended_at
    end

    create_table(:downloads) do
      primary_key :id
      foreign_key :share_id, :shares, type: String, null: false, on_delete: :cascade
      String :name, text: true, null: false
      String :ip
      Time :created_at, null: false
      index :share_id
    end
  end
end
