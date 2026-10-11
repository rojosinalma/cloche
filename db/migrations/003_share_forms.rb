Sequel.migration do
  change do
    alter_table(:shares) do
      add_column :form, String, text: true
      add_column :draft, String, text: true
      add_column :answers, String, text: true
      add_column :submitted_at, Time
      add_column :submissions, Integer, default: 0
      add_column :draft_saved_at, Time
    end
  end
end
