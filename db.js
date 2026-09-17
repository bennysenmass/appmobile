const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('client','admin')),
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_user_id TEXT NOT NULL,
    sender_role TEXT NOT NULL CHECK(sender_role IN ('client','admin')),
    text TEXT NOT NULL DEFAULT '',
    file_url TEXT,
    file_name TEXT,
    file_mime TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    read_by_admin INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (conversation_user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_user_id);
`);

// Migración suave: si la base ya existía de antes (sin las columnas de archivo), las agrega.
const existingCols = db.prepare(`PRAGMA table_info(messages)`).all().map(c => c.name);
if (!existingCols.includes('file_url'))  db.exec(`ALTER TABLE messages ADD COLUMN file_url TEXT`);
if (!existingCols.includes('file_name')) db.exec(`ALTER TABLE messages ADD COLUMN file_name TEXT`);
if (!existingCols.includes('file_mime')) db.exec(`ALTER TABLE messages ADD COLUMN file_mime TEXT`);

module.exports = db;
