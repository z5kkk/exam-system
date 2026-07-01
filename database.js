const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'exam.db');

let db = null;
let SQL = null;

async function initDatabase() {
  SQL = await initSqlJs();

  // Try to load existing database
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // Enable foreign keys
  db.run("PRAGMA foreign_keys = ON");

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT,
      work_zone TEXT DEFAULT '' NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'student' CHECK(role IN ('student', 'admin')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS exams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      duration_minutes INTEGER NOT NULL DEFAULT 60,
      total_score INTEGER NOT NULL DEFAULT 100,
      passing_score INTEGER NOT NULL DEFAULT 60,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft', 'published', 'closed')),
      question_config TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Schema migration: add question_config if missing
  try {
    const cols = queryAll("PRAGMA table_info(exams)");
    const hasQC = cols.some(c => c.name === 'question_config');
    if (!hasQC) {
      db.run("ALTER TABLE exams ADD COLUMN question_config TEXT DEFAULT NULL");
      console.log('[DB] Added question_config column to exams');
    }
  } catch (e) { /* ignore */ }

  db.run(`
    CREATE TABLE IF NOT EXISTS question_banks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS bank_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_id INTEGER NOT NULL REFERENCES question_banks(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('single_choice', 'multiple_choice', 'true_false', 'short_answer')),
      question_text TEXT NOT NULL,
      options TEXT,
      correct_answer TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 1,
      sort_order INTEGER DEFAULT 0
    )
  `);

  db.run("CREATE INDEX IF NOT EXISTS idx_bank_questions_bank ON bank_questions(bank_id)");

  db.run(`
    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('single_choice', 'multiple_choice', 'true_false', 'short_answer')),
      question_text TEXT NOT NULL,
      options TEXT,
      correct_answer TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 1,
      sort_order INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      exam_id INTEGER NOT NULL REFERENCES exams(id),
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      submitted_at DATETIME,
      total_score REAL,
      status TEXT DEFAULT 'in_progress' CHECK(status IN ('in_progress', 'submitted', 'graded')),
      answers_data TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
      question_id INTEGER NOT NULL REFERENCES questions(id),
      user_answer TEXT,
      is_correct INTEGER DEFAULT 0,
      score_awarded REAL DEFAULT 0
    )
  `);

  // Create indexes
  db.run("CREATE INDEX IF NOT EXISTS idx_questions_exam ON questions(exam_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_submissions_user ON submissions(user_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_submissions_exam ON submissions(exam_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_answers_submission ON answers(submission_id)");

  saveDb();
  seedDefaultAdmin();
  console.log('[DB] Database initialized successfully');
}

function saveDb() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  }
}

// sql.js helper: run a query and return all rows as objects
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

// sql.js helper: run a query and return first row
function queryOne(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  let row = null;
  if (stmt.step()) {
    row = stmt.getAsObject();
  }
  stmt.free();
  return row;
}

// sql.js helper: run a mutation and return lastInsertRowid
function run(sql, params = []) {
  db.run(sql, params);
  const lastId = queryOne("SELECT last_insert_rowid() as id");
  saveDb(); // Auto-save after mutations
  return lastId ? lastId.id : null;
}

// Execute raw SQL (for multi-statement)
function exec(sql) {
  db.run(sql);
  saveDb();
}

function seedDefaultAdmin() {
  const existing = queryOne("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (!existing) {
    const passwordHash = bcrypt.hashSync('admin123', 10);
    run("INSERT INTO users (username, email, work_zone, password_hash, role) VALUES (?, ?, ?, ?, ?)",
      ['admin', '', '系统管理', passwordHash, 'admin']);
    console.log('[DB] Default admin created: admin / admin123');
  }
}

function getDb() {
  return db;
}

// Cleanup on exit
process.on('exit', () => saveDb());
process.on('SIGINT', () => { saveDb(); process.exit(); });
process.on('SIGTERM', () => { saveDb(); process.exit(); });

module.exports = { initDatabase, getDb, queryAll, queryOne, run, exec, saveDb };
