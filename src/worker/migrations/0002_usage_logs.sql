CREATE TABLE usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  input_units REAL DEFAULT 0,
  output_units REAL DEFAULT 0,
  cost_usd REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_usage_date ON usage_logs(created_at);
CREATE INDEX idx_usage_category ON usage_logs(category, created_at);
