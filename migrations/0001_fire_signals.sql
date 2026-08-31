CREATE TABLE IF NOT EXISTS fire_signals (id TEXT PRIMARY KEY, payload TEXT NOT NULL, score INTEGER NOT NULL, acquired_at TEXT NOT NULL, notified_at TEXT);
CREATE INDEX IF NOT EXISTS idx_fire_signals_acquired ON fire_signals(acquired_at DESC);
