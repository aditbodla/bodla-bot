const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "bodla-bot.db"));

// ─── Initialize tables ────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE NOT NULL,
    name TEXT,
    escalated INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    last_seen TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ─── Client functions ─────────────────────────────────────────────────────────
function getClient(phone) {
  return db.prepare("SELECT * FROM clients WHERE phone = ?").get(phone) || null;
}

function createClient(phone, name) {
  db.prepare("INSERT OR IGNORE INTO clients (phone, name) VALUES (?, ?)").run(phone, name || null);
  db.prepare("UPDATE clients SET last_seen = datetime('now') WHERE phone = ?").run(phone);
  return getClient(phone);
}

function updateClientName(phone, name) {
  db.prepare("UPDATE clients SET name = ? WHERE phone = ?").run(name, phone);
}

function markEscalated(phone) {
  db.prepare("UPDATE clients SET escalated = 1 WHERE phone = ?").run(phone);
}

function getAllClients() {
  return db.prepare("SELECT * FROM clients ORDER BY last_seen DESC").all();
}

// ─── Message functions ────────────────────────────────────────────────────────
function saveMessage(phone, role, content) {
  db.prepare(
    "INSERT INTO messages (phone, role, content) VALUES (?, ?, ?)"
  ).run(phone, role, content);

  db.prepare("UPDATE clients SET last_seen = datetime('now') WHERE phone = ?").run(phone);
}

function getChatHistory(phone) {
  return db
    .prepare("SELECT role, content, created_at FROM messages WHERE phone = ? ORDER BY created_at ASC")
    .all(phone);
}

module.exports = {
  getClient,
  createClient,
  updateClientName,
  markEscalated,
  getAllClients,
  saveMessage,
  getChatHistory,
};
