const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

// Initialize DB schema
db.serialize(() => {
  // Files table
  db.run(`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      folder TEXT NOT NULL,
      size INTEGER,
      mime TEXT,
      extension TEXT,
      modified INTEGER,
      created INTEGER,
      thumbnail TEXT,
      isDirectory INTEGER,
      isFavorite INTEGER DEFAULT 0,
      isPinned INTEGER DEFAULT 0,
      isDeleted INTEGER DEFAULT 0
    )
  `);

  // Activity logs table
  db.run(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER,
      action TEXT,
      details TEXT
    )
  `);

  // Device Info table
  db.run(`
    CREATE TABLE IF NOT EXISTS device_info (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // Create indexes for efficient queries (for over 100,000 files)
  db.run(`CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_files_name ON files(name)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_files_extension ON files(extension)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_files_mime ON files(mime)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_files_is_deleted ON files(isDeleted)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_files_is_favorite ON files(isFavorite)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_files_is_pinned ON files(isPinned)`);
});

// Wrap DB methods in Promises for async/await support
const query = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const get = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const run = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
};

const logActivity = (action, details) => {
  const timestamp = Date.now();
  return run(
    `INSERT INTO activity_logs (timestamp, action, details) VALUES (?, ?, ?)`,
    [timestamp, action, details]
  ).catch(console.error);
};

module.exports = {
  db,
  query,
  get,
  run,
  logActivity
};
