const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'campus-hub.db');
const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    institute     TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    mobile        TEXT NOT NULL,
    hostel_block  TEXT NOT NULL,
    room_number   TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS machines (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL
  );

  -- Times are stored as epoch milliseconds (UTC). A booking occupies [start_ms, end_ms).
  CREATE TABLE IF NOT EXISTS laundry_bookings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    machine_id INTEGER NOT NULL REFERENCES machines(id),
    start_ms   INTEGER NOT NULL,
    end_ms     INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (end_ms > start_ms)
  );
  CREATE INDEX IF NOT EXISTS idx_bookings_machine_time ON laundry_bookings(machine_id, start_ms, end_ms);
  -- Backstop: two bookings can never start at the exact same instant on one machine,
  -- even if application-level overlap checking were bypassed.
  CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_machine_start ON laundry_bookings(machine_id, start_ms);

  CREATE TABLE IF NOT EXISTS mess_feedback (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    meal_date  TEXT NOT NULL,
    preference TEXT NOT NULL CHECK (preference IN ('full','half','skip')),
    feedback   TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, meal_date)
  );

  CREATE TABLE IF NOT EXISTS lost_found (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('lost','found')),
    description TEXT NOT NULL,
    location    TEXT,
    image_path  TEXT,
    status      TEXT NOT NULL DEFAULT 'open',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notices (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS issues (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type        TEXT NOT NULL CHECK (type IN ('cleaning','technician')),
    description TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Seed reference data once.
if (db.prepare('SELECT COUNT(*) AS c FROM machines').get().c === 0) {
  const m = db.prepare('INSERT INTO machines (id, name) VALUES (?, ?)');
  m.run(1, 'Machine 1');
  m.run(2, 'Machine 2');
}
if (db.prepare('SELECT COUNT(*) AS c FROM notices').get().c === 0) {
  const n = db.prepare('INSERT INTO notices (title) VALUES (?)');
  n.run('Maintenance work - Block A (May 15-17)');
  n.run('WiFi upgrade - May 20, 2-4am');
  n.run('Mess will be closed May 21');
}

module.exports = db;
