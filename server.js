const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');
const { initDatabase, queryAll, queryOne, run, exec } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'exam-system-secret-key-2024';
const JWT_EXPIRES = '24h';

// Multer config for file uploads
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = ['.xlsx', '.xls', '.csv'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('仅支持 .xlsx, .xls, .csv 格式文件'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// Middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));

// Auth Middleware
function authRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '请先登录' });
  }
  try {
    const token = header.split(' ')[1];
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

function adminRequired(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  next();
}

// ============================================================
// Health Check (for cloud deployment)
// ============================================================
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() });
});

// ============================================================
// Auth Routes
// ============================================================
app.post('/api/auth/register', (req, res) => {
  const { username, password, work_zone } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }
  if (password.length < 3) {
    return res.status(400).json({ error: '密码至少3位' });
  }
  if (!work_zone || work_zone.trim() === '') {
    return res.status(400).json({ error: '养护工区不能为空' });
  }

  const existing = queryOne("SELECT id FROM users WHERE username = ?", [username]);
  if (existing) {
    return res.status(409).json({ error: '用户名已存在' });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const result = run(
    "INSERT INTO users (username, work_zone, password_hash, role) VALUES (?, ?, ?, 'student')",
    [username, work_zone.trim(), passwordHash]
  );

  const token = jwt.sign(
    { id: result, username, role: 'student' },
    JWT_SECRET, { expiresIn: JWT_EXPIRES }
  );

  res.json({ token, user: { id: result, username, work_zone: work_zone.trim(), role: 'student' } });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }

  const user = queryOne("SELECT * FROM users WHERE username = ?", [username]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET, { expiresIn: JWT_EXPIRES }
  );

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      work_zone: user.work_zone || '',
      role: user.role
    }
  });
});

app.get('/api/auth/me', authRequired, (req, res) => {
  res.json({ user: req.user });
});

// ============================================================
// Student Exam Routes
// ============================================================
app.get('/api/exams', authRequired, (req, res) => {
  const exams = queryAll(`
    SELECT e.*,
      (SELECT COUNT(*) FROM questions WHERE exam_id = e.id) as question_count,
      (SELECT COUNT(*) FROM submissions WHERE exam_id = e.id AND user_id = ?) as my_submissions
    FROM exams e
    WHERE e.status = 'published'
    ORDER BY e.created_at DESC
  `, [req.user.id]);
  res.json({ exams });
});

app.get('/api/exams/:id', authRequired, (req, res) => {
  const exam = queryOne("SELECT * FROM exams WHERE id = ?", [req.params.id]);
  if (!exam) return res.status(404).json({ error: '考试不存在' });

  const existingSub = queryOne(
    "SELECT id, status FROM submissions WHERE exam_id = ? AND user_id = ? AND status = 'submitted'",
    [exam.id, req.user.id]
  );

  if (existingSub) {
    return res.json({ exam, alreadySubmitted: true, submissionId: existingSub.id });
  }

  const questions = queryAll(
    "SELECT id, type, question_text, options, score, sort_order FROM questions WHERE exam_id = ? ORDER BY sort_order, id",
    [exam.id]
  );

  res.json({ exam, questions, alreadySubmitted: false });
});

app.post('/api/exams/:id/start', authRequired, (req, res) => {
  const exam = queryOne("SELECT * FROM exams WHERE id = ? AND status = 'published'", [req.params.id]);
  if (!exam) return res.status(404).json({ error: '考试不存在或不可用' });

  let submission = queryOne(
    "SELECT * FROM submissions WHERE exam_id = ? AND user_id = ? AND status = 'in_progress'",
    [exam.id, req.user.id]
  );

  if (submission) {
    return res.json({ submission });
  }

  const existingSub = queryOne(
    "SELECT id FROM submissions WHERE exam_id = ? AND user_id = ? AND status IN ('submitted', 'graded')",
    [exam.id, req.user.id]
  );

  if (existingSub) {
    return res.status(400).json({ error: '你已经提交过该考试' });
  }

  // --- Random question selection from banks ---
  let questionConfig = null;
  try {
    if (exam.question_config) {
      questionConfig = JSON.parse(exam.question_config);
    }
  } catch (e) { /* ignore */ }

  if (questionConfig && questionConfig.use_bank) {
    // Check if questions already populated
    const existingCount = queryOne("SELECT COUNT(*) as count FROM questions WHERE exam_id = ?", [exam.id]);
    if (!existingCount || existingCount.count === 0) {
      // Select random questions from banks
      const types = ['single_choice', 'multiple_choice', 'true_false', 'short_answer'];
      let sortOrder = 0;
      const selectedIds = [];

      for (const type of types) {
        const cfg = questionConfig[type];
        if (!cfg || !cfg.bank_id || !cfg.count || cfg.count <= 0) continue;

        // Get all matching questions from bank
        const bankQuestions = queryAll(
          "SELECT * FROM bank_questions WHERE bank_id = ? AND type = ? ORDER BY RANDOM() LIMIT ?",
          [cfg.bank_id, type, cfg.count]
        );

        const scorePer = cfg.score_per || 5;
        for (const bq of bankQuestions) {
          run(
            "INSERT INTO questions (exam_id, type, question_text, options, correct_answer, score, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [exam.id, bq.type, bq.question_text, bq.options, bq.correct_answer, scorePer, ++sortOrder]
          );
          const newId = queryOne("SELECT last_insert_rowid() as id");
          if (newId) selectedIds.push(newId.id);
        }
      }

      console.log(`[Exam Start] Selected ${selectedIds.length} questions from banks for exam ${exam.id}`);
    }
  }

  const result = run(
    "INSERT INTO submissions (user_id, exam_id, status) VALUES (?, ?, 'in_progress')",
    [req.user.id, exam.id]
  );

  submission = { id: result, user_id: req.user.id, exam_id: exam.id, started_at: new Date().toISOString(), status: 'in_progress' };
  res.json({ submission });
});

app.post('/api/submissions/:id/submit', authRequired, (req, res) => {
  const submission = queryOne("SELECT * FROM submissions WHERE id = ? AND user_id = ?", [
    req.params.id, req.user.id
  ]);
  if (!submission) return res.status(404).json({ error: '提交记录不存在' });
  if (submission.status !== 'in_progress') return res.status(400).json({ error: '已提交过，不能重复提交' });

  const { answers } = req.body;
  if (!answers || typeof answers !== 'object') {
    return res.status(400).json({ error: '请提供答案' });
  }

  const questions = queryAll("SELECT * FROM questions WHERE exam_id = ?", [submission.exam_id]);
  let totalScore = 0;
  let gradedCount = 0;

  try {
    for (const q of questions) {
      const userAnswer = answers[q.id] || '';
      let isCorrect = 0;
      let scoreAwarded = 0;

      if (q.type === 'single_choice' || q.type === 'true_false') {
        isCorrect = userAnswer.trim().toUpperCase() === q.correct_answer.trim().toUpperCase() ? 1 : 0;
        scoreAwarded = isCorrect ? q.score : 0;
      } else if (q.type === 'multiple_choice') {
        const userSorted = userAnswer.split(',').map(s => s.trim().toUpperCase()).sort().join(',');
        const correctSorted = q.correct_answer.split(',').map(s => s.trim().toUpperCase()).sort().join(',');
        isCorrect = userSorted === correctSorted ? 1 : 0;
        scoreAwarded = isCorrect ? q.score : 0;
      } else if (q.type === 'short_answer') {
        const ua = userAnswer.trim().toLowerCase();
        const ca = q.correct_answer.trim().toLowerCase();
        isCorrect = ua === ca || ua.includes(ca) || ca.includes(ua) ? 1 : 0;
        scoreAwarded = isCorrect ? q.score : 0;
      }

      run(
        "INSERT INTO answers (submission_id, question_id, user_answer, is_correct, score_awarded) VALUES (?, ?, ?, ?, ?)",
        [submission.id, q.id, String(userAnswer), isCorrect, scoreAwarded]
      );
      totalScore += scoreAwarded;
      gradedCount++;
    }

    run(
      "UPDATE submissions SET submitted_at = CURRENT_TIMESTAMP, total_score = ?, status = 'graded', answers_data = ? WHERE id = ?",
      [totalScore, JSON.stringify(answers), submission.id]
    );
    res.json({
      submissionId: submission.id,
      totalScore,
      totalQuestions: gradedCount,
      message: '提交成功，成绩已生成'
    });
  } catch (err) {
    res.status(500).json({ error: '评分失败: ' + err.message });
  }
});

app.get('/api/submissions/:id/result', authRequired, (req, res) => {
  const submission = queryOne(`
    SELECT s.*, e.title as exam_title, e.total_score as exam_total_score
    FROM submissions s
    JOIN exams e ON s.exam_id = e.id
    WHERE s.id = ? AND s.user_id = ?
  `, [req.params.id, req.user.id]);

  if (!submission) return res.status(404).json({ error: '记录不存在' });

  const answers = queryAll(`
    SELECT a.*, q.question_text, q.type, q.options, q.correct_answer, q.score as question_score
    FROM answers a
    JOIN questions q ON a.question_id = q.id
    WHERE a.submission_id = ?
    ORDER BY q.sort_order, q.id
  `, [submission.id]);

  res.json({ submission, answers });
});

app.get('/api/my-results', authRequired, (req, res) => {
  const results = queryAll(`
    SELECT s.*, e.title as exam_title, e.total_score as exam_total_score, e.passing_score
    FROM submissions s
    JOIN exams e ON s.exam_id = e.id
    WHERE s.user_id = ? AND s.status IN ('submitted', 'graded')
    ORDER BY s.submitted_at DESC
  `, [req.user.id]);

  res.json({ results });
});

// ============================================================
// Admin Routes - Question Banks
// ============================================================
app.get('/api/admin/banks', authRequired, adminRequired, (req, res) => {
  const banks = queryAll(`
    SELECT b.*,
      (SELECT COUNT(*) FROM bank_questions WHERE bank_id = b.id) as question_count
    FROM question_banks b
    ORDER BY b.created_at DESC
  `);
  res.json({ banks });
});

app.post('/api/admin/banks', authRequired, adminRequired, (req, res) => {
  const { title, description } = req.body;
  if (!title) return res.status(400).json({ error: '题库名称不能为空' });
  const result = run(
    "INSERT INTO question_banks (title, description) VALUES (?, ?)",
    [title, description || '']
  );
  res.json({ id: result, message: '题库创建成功' });
});

app.put('/api/admin/banks/:id', authRequired, adminRequired, (req, res) => {
  const { title, description } = req.body;
  const bank = queryOne("SELECT * FROM question_banks WHERE id = ?", [req.params.id]);
  if (!bank) return res.status(404).json({ error: '题库不存在' });
  run("UPDATE question_banks SET title=?, description=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
    [title || bank.title, description !== undefined ? description : bank.description, bank.id]);
  res.json({ message: '更新成功' });
});

app.delete('/api/admin/banks/:id', authRequired, adminRequired, (req, res) => {
  run("DELETE FROM question_banks WHERE id = ?", [req.params.id]);
  res.json({ message: '删除成功' });
});

// Bank Questions
app.get('/api/admin/banks/:bankId/questions', authRequired, adminRequired, (req, res) => {
  const questions = queryAll(
    "SELECT * FROM bank_questions WHERE bank_id = ? ORDER BY sort_order, id",
    [req.params.bankId]
  );
  res.json({ questions });
});

app.post('/api/admin/banks/:bankId/questions', authRequired, adminRequired, (req, res) => {
  const { type, question_text, options, correct_answer, score } = req.body;
  if (!type || !question_text || correct_answer === undefined) {
    return res.status(400).json({ error: '题目类型、内容和正确答案不能为空' });
  }
  const bank = queryOne("SELECT id FROM question_banks WHERE id = ?", [req.params.bankId]);
  if (!bank) return res.status(404).json({ error: '题库不存在' });

  const maxOrder = queryOne(
    "SELECT MAX(sort_order) as max_order FROM bank_questions WHERE bank_id = ?",
    [req.params.bankId]
  );

  const result = run(
    "INSERT INTO bank_questions (bank_id, type, question_text, options, correct_answer, score, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      req.params.bankId, type, question_text,
      options ? JSON.stringify(options) : null,
      String(correct_answer), score || 1, (maxOrder?.max_order || 0) + 1
    ]
  );
  res.json({ id: result, message: '添加成功' });
});

// Excel import for bank questions
app.post('/api/admin/banks/:bankId/questions/import-excel', authRequired, adminRequired, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请上传Excel文件' });
    const bank = queryOne("SELECT id FROM question_banks WHERE id = ?", [req.params.bankId]);
    if (!bank) { fs.unlinkSync(req.file.path); return res.status(404).json({ error: '题库不存在' }); }

    const workbook = XLSX.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (!data.length) { fs.unlinkSync(req.file.path); return res.status(400).json({ error: '文件中没有数据' }); }

    const columnMap = {
      题型: 'type', 题目类型: 'type', type: 'type',
      题目: 'question_text', 题干: 'question_text', question: 'question_text',
      选项A: 'optionA', '选项 A': 'optionA', A: 'optionA',
      选项B: 'optionB', '选项 B': 'optionB', B: 'optionB',
      选项C: 'optionC', '选项 C': 'optionC', C: 'optionC',
      选项D: 'optionD', '选项 D': 'optionD', D: 'optionD',
      选项E: 'optionE', '选项 E': 'optionE', E: 'optionE',
      选项F: 'optionF', '选项 F': 'optionF', F: 'optionF',
      正确答案: 'correct_answer', 答案: 'correct_answer', answer: 'correct_answer',
      分值: 'score', 分数: 'score', score: 'score'
    };

    const firstRow = data[0], headers = Object.keys(firstRow), mappedHeaders = {};
    for (const h of headers) { const m = columnMap[h.trim()]; if (m) mappedHeaders[m] = h; }
    if (!mappedHeaders.question_text) mappedHeaders.question_text = headers[0];

    const typeAliases = {
      '单选': 'single_choice', '单选题': 'single_choice', 'single': 'single_choice', 'single_choice': 'single_choice',
      '多选': 'multiple_choice', '多选题': 'multiple_choice', 'multiple': 'multiple_choice', 'multiple_choice': 'multiple_choice',
      '判断': 'true_false', '判断题': 'true_false', 'true_false': 'true_false',
      '简答': 'short_answer', '简答题': 'short_answer', 'short_answer': 'short_answer'
    };

    const maxOrder = queryOne("SELECT MAX(sort_order) as max_order FROM bank_questions WHERE bank_id = ?", [req.params.bankId]);
    let currentOrder = (maxOrder?.max_order || 0) + 1;
    let imported = 0; const errors = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      try {
        let type = 'single_choice';
        if (mappedHeaders.type) {
          const rawType = String(row[mappedHeaders.type] || '').trim();
          type = typeAliases[rawType] || 'single_choice';
          if (!['single_choice','multiple_choice','true_false','short_answer'].includes(type)) type = 'single_choice';
        }
        const qText = String(row[mappedHeaders.question_text] || '').trim();
        if (!qText) { errors.push(`第${i+1}行: 题目为空`); continue; }

        let options = null;
        if (['single_choice','multiple_choice'].includes(type)) {
          const opts = [];
          for (const ok of ['optionA','optionB','optionC','optionD','optionE','optionF']) {
            if (mappedHeaders[ok]) { const v = String(row[mappedHeaders[ok]] || '').trim(); if (v) opts.push(v); }
          }
          if (opts.length >= 2) options = JSON.stringify(opts);
        } else if (type === 'true_false') options = JSON.stringify(['正确','错误']);

        let correctAnswer = '';
        if (mappedHeaders.correct_answer) {
          const raw = String(row[mappedHeaders.correct_answer] || '').trim();
          if (type === 'single_choice' && options) {
            correctAnswer = /^[A-Fa-f]$/.test(raw) ? raw.toUpperCase() : raw;
          } else if (type === 'true_false') {
            correctAnswer = ['正确','对','true','t','yes','是','1'].includes(raw.toLowerCase()) ? 'TRUE' : 'FALSE';
          } else correctAnswer = raw;
        }
        if (!correctAnswer) { errors.push(`第${i+1}行: 正确答案为空`); continue; }

        const score = parseFloat(row[mappedHeaders.score]) || 5;
        run("INSERT INTO bank_questions (bank_id, type, question_text, options, correct_answer, score, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [req.params.bankId, type, qText, options, correctAnswer, score, currentOrder++]);
        imported++;
      } catch (re) { errors.push(`第${i+1}行: ${re.message}`); }
    }
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    res.json({ imported, errors: errors.length > 0 ? errors : undefined, message: `成功导入 ${imported} 题` });
  } catch (err) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch (e) {}
    res.status(500).json({ error: '导入失败: ' + err.message });
  }
});

app.delete('/api/admin/bank-questions/:id', authRequired, adminRequired, (req, res) => {
  run("DELETE FROM bank_questions WHERE id = ?", [req.params.id]);
  res.json({ message: '删除成功' });
});

// ============================================================
// Admin Routes - Exams (Updated with question_config)
// ============================================================
app.get('/api/admin/exams', authRequired, adminRequired, (req, res) => {
  const exams = queryAll(`
    SELECT e.*,
      (SELECT COUNT(*) FROM questions WHERE exam_id = e.id) as question_count,
      (SELECT COUNT(*) FROM submissions WHERE exam_id = e.id AND status IN ('submitted', 'graded')) as submission_count,
      (SELECT ROUND(AVG(total_score), 1) FROM submissions WHERE exam_id = e.id AND status IN ('submitted', 'graded')) as avg_score
    FROM exams e
    ORDER BY e.created_at DESC
  `);
  res.json({ exams });
});

app.post('/api/admin/exams', authRequired, adminRequired, (req, res) => {
  const { title, description, duration_minutes, passing_score, status, question_config } = req.body;
  let { total_score } = req.body;
  if (!title) return res.status(400).json({ error: '考试标题不能为空' });

  let qcJson = null;
  if (question_config) {
    qcJson = JSON.stringify(question_config);
    // Auto-calculate total_score if using bank config
    if (question_config.use_bank) {
      let calcScore = 0;
      const types = ['single_choice', 'multiple_choice', 'true_false', 'short_answer'];
      for (const t of types) {
        if (question_config[t] && question_config[t].bank_id) {
          calcScore += (question_config[t].count || 0) * (question_config[t].score_per || 5);
        }
      }
      total_score = calcScore || total_score || 100;
    }
  }

  const result = run(
    "INSERT INTO exams (title, description, duration_minutes, total_score, passing_score, status, question_config) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [title, description || '', duration_minutes || 60, total_score || 100, passing_score || 60, status || 'draft', qcJson]
  );

  res.json({ id: result, message: '创建成功' });
});

app.put('/api/admin/exams/:id', authRequired, adminRequired, (req, res) => {
  const { title, description, duration_minutes, total_score, passing_score, status, question_config } = req.body;
  const exam = queryOne("SELECT * FROM exams WHERE id = ?", [req.params.id]);
  if (!exam) return res.status(404).json({ error: '考试不存在' });

  let qcJson = question_config !== undefined ? (question_config ? JSON.stringify(question_config) : null) : exam.question_config;

  run(`
    UPDATE exams SET title=?, description=?, duration_minutes=?, total_score=?, passing_score=?, status=?, question_config=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `, [
    title || exam.title,
    description !== undefined ? description : exam.description,
    duration_minutes || exam.duration_minutes,
    total_score || exam.total_score,
    passing_score !== undefined ? passing_score : exam.passing_score,
    status || exam.status,
    qcJson,
    exam.id
  ]);

  res.json({ message: '更新成功' });
});

app.delete('/api/admin/exams/:id', authRequired, adminRequired, (req, res) => {
  run("DELETE FROM exams WHERE id = ?", [req.params.id]);
  res.json({ message: '删除成功' });
});

// ============================================================
// Admin Routes - Questions
// ============================================================
app.get('/api/admin/questions/:examId', authRequired, adminRequired, (req, res) => {
  const questions = queryAll(
    "SELECT * FROM questions WHERE exam_id = ? ORDER BY sort_order, id",
    [req.params.examId]
  );
  res.json({ questions });
});

app.post('/api/admin/exams/:examId/questions', authRequired, adminRequired, (req, res) => {
  const { type, question_text, options, correct_answer, score } = req.body;
  if (!type || !question_text || correct_answer === undefined) {
    return res.status(400).json({ error: '题目类型、内容和正确答案不能为空' });
  }

  const exam = queryOne("SELECT id FROM exams WHERE id = ?", [req.params.examId]);
  if (!exam) return res.status(404).json({ error: '考试不存在' });

  const maxOrder = queryOne(
    "SELECT MAX(sort_order) as max_order FROM questions WHERE exam_id = ?",
    [req.params.examId]
  );

  const result = run(
    "INSERT INTO questions (exam_id, type, question_text, options, correct_answer, score, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      req.params.examId,
      type,
      question_text,
      options ? JSON.stringify(options) : null,
      String(correct_answer),
      score || 1,
      (maxOrder?.max_order || 0) + 1
    ]
  );

  res.json({ id: result, message: '添加成功' });
});

// JSON Batch Import
app.post('/api/admin/exams/:examId/questions/import', authRequired, adminRequired, (req, res) => {
  const { questions } = req.body;
  if (!questions || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: '请提供题目数据（JSON数组格式）' });
  }

  const exam = queryOne("SELECT id FROM exams WHERE id = ?", [req.params.examId]);
  if (!exam) return res.status(404).json({ error: '考试不存在' });

  const maxOrder = queryOne(
    "SELECT MAX(sort_order) as max_order FROM questions WHERE exam_id = ?",
    [req.params.examId]
  );

  let currentOrder = (maxOrder?.max_order || 0) + 1;
  let imported = 0;
  const errors = [];

  try {
    for (const q of questions) {
      if (!q.type || !q.question_text || q.correct_answer === undefined) continue;
      const validTypes = ['single_choice', 'multiple_choice', 'true_false', 'short_answer'];
      if (!validTypes.includes(q.type)) continue;

      try {
        run(
          "INSERT INTO questions (exam_id, type, question_text, options, correct_answer, score, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [
            req.params.examId,
            q.type,
            q.question_text,
            q.options ? JSON.stringify(q.options) : null,
            String(q.correct_answer),
            q.score || 1,
            currentOrder++
          ]
        );
        imported++;
      } catch (qe) {
        errors.push(`第${imported + 1}题: ${qe.message}`);
      }
    }
    res.json({ imported, errors: errors.length > 0 ? errors : undefined, message: `成功导入 ${imported} 道题目` + (errors.length > 0 ? `，${errors.length} 题失败` : '') });
  } catch (err) {
    res.status(500).json({ error: '导入失败: ' + err.message });
  }
});

// Excel File Import
app.post('/api/admin/exams/:examId/questions/import-excel', authRequired, adminRequired, upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请上传Excel文件（.xlsx/.xls）' });
    }

    const exam = queryOne("SELECT id FROM exams WHERE id = ?", [req.params.examId]);
    if (!exam) {
      // cleanup uploaded file
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: '考试不存在' });
    }

    // Parse Excel
    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (!data || data.length === 0) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Excel文件中没有数据' });
    }

    // Column mapping: support both Chinese and English headers
    const columnMap = {
      题型: 'type', 题目类型: 'type', type: 'type', Type: 'type',
      题目: 'question_text', 题干: 'question_text', 问题: 'question_text', question: 'question_text', Question: 'question_text', 'question_text': 'question_text',
      选项A: 'optionA', '选项 A': 'optionA', A: 'optionA', a: 'optionA',
      选项B: 'optionB', '选项 B': 'optionB', B: 'optionB', b: 'optionB',
      选项C: 'optionC', '选项 C': 'optionC', C: 'optionC', c: 'optionC',
      选项D: 'optionD', '选项 D': 'optionD', D: 'optionD', d: 'optionD',
      选项E: 'optionE', '选项 E': 'optionE', E: 'optionE', e: 'optionE',
      选项F: 'optionF', '选项 F': 'optionF', F: 'optionF', f: 'optionF',
      正确答案: 'correct_answer', 答案: 'correct_answer', answer: 'correct_answer', Answer: 'correct_answer', 'correct_answer': 'correct_answer',
      分值: 'score', 分数: 'score', score: 'score', Score: 'score',
      解析: 'analysis', 题目解析: 'analysis', 解析: 'analysis'
    };

    // Detect column headers
    const firstRow = data[0];
    const headers = Object.keys(firstRow);
    const mappedHeaders = {};
    for (const h of headers) {
      const hTrimmed = h.trim();
      const mapped = columnMap[hTrimmed];
      if (mapped) mappedHeaders[mapped] = h;
    }

    // Fallback: if no type column found, try to guess from data
    if (!mappedHeaders.question_text) {
      // Use first column as question_text
      const firstCol = headers[0];
      mappedHeaders.question_text = firstCol;
    }

    const validTypes = ['single_choice', 'multiple_choice', 'true_false', 'short_answer'];
    const typeAliases = {
      '单选': 'single_choice', '单选题': 'single_choice', 'single': 'single_choice', 'choice': 'single_choice', 'single_choice': 'single_choice',
      '多选': 'multiple_choice', '多选题': 'multiple_choice', 'multiple': 'multiple_choice', 'multiple_choice': 'multiple_choice',
      '判断': 'true_false', '判断题': 'true_false', 'tf': 'true_false', 'true_false': 'true_false',
      '简答': 'short_answer', '简答题': 'short_answer', 'short': 'short_answer', 'short_answer': 'short_answer'
    };

    const maxOrder = queryOne(
      "SELECT MAX(sort_order) as max_order FROM questions WHERE exam_id = ?",
      [req.params.examId]
    );
    let currentOrder = (maxOrder?.max_order || 0) + 1;
    let imported = 0;
    const errors = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      try {
        // Determine question type
        let type = 'single_choice';
        if (mappedHeaders.type) {
          const rawType = String(row[mappedHeaders.type] || '').trim();
          type = typeAliases[rawType] || validTypes.includes(rawType) ? rawType : 'single_choice';
          if (!validTypes.includes(type)) type = 'single_choice';
        }

        // Get question text
        const questionText = String(row[mappedHeaders.question_text] || '').trim();
        if (!questionText) {
          errors.push(`第${i + 1}行: 题目内容为空`);
          continue;
        }

        // Build options array
        let options = null;
        if (['single_choice', 'multiple_choice'].includes(type)) {
          const opts = [];
          const optionKeys = ['optionA', 'optionB', 'optionC', 'optionD', 'optionE', 'optionF'];
          for (const ok of optionKeys) {
            if (mappedHeaders[ok]) {
              const val = String(row[mappedHeaders[ok]] || '').trim();
              if (val) opts.push(val);
            }
          }
          if (opts.length >= 2) {
            options = JSON.stringify(opts);
          }
        } else if (type === 'true_false') {
          options = JSON.stringify(['正确', '错误']);
        }

        // Get correct answer
        let correctAnswer = '';
        if (mappedHeaders.correct_answer) {
          const rawAnswer = String(row[mappedHeaders.correct_answer] || '').trim();

          if (type === 'single_choice' && options) {
            // Support A/B/C/D or option text itself
            const opts = JSON.parse(options);
            if (/^[A-Fa-f]$/.test(rawAnswer)) {
              const idx = rawAnswer.toUpperCase().charCodeAt(0) - 65;
              correctAnswer = rawAnswer.toUpperCase();
            } else {
              // Try matching option text
              const idx = opts.findIndex(o => o.trim() === rawAnswer);
              correctAnswer = idx >= 0 ? String.fromCharCode(65 + idx) : rawAnswer;
            }
          } else if (type === 'multiple_choice') {
            correctAnswer = rawAnswer;
          } else if (type === 'true_false') {
            const t = rawAnswer.toLowerCase();
            if (['正确', '对', 'true', 't', 'yes', '是', '1', 'true'].includes(t)) {
              correctAnswer = 'TRUE';
            } else {
              correctAnswer = 'FALSE';
            }
          } else {
            correctAnswer = rawAnswer;
          }
        }

        if (!correctAnswer) {
          errors.push(`第${i + 1}行: 正确答案为空`);
          continue;
        }

        // Get score
        const score = parseFloat(row[mappedHeaders.score]) || 5;

        run(
          "INSERT INTO questions (exam_id, type, question_text, options, correct_answer, score, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [req.params.examId, type, questionText, options, correctAnswer, score, currentOrder++]
        );
        imported++;
      } catch (re) {
        errors.push(`第${i + 1}行: ${re.message}`);
      }
    }

    // Cleanup temp file
    try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }

    res.json({
      imported,
      errors: errors.length > 0 ? errors : undefined,
      message: `成功从Excel导入 ${imported} 道题目` + (errors.length > 0 ? `，${errors.length} 行失败` : '')
    });

  } catch (err) {
    // Cleanup on error
    if (req.file) {
      try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }
    }
    res.status(500).json({ error: 'Excel导入失败: ' + err.message });
  }
});

// Get Excel import template
app.get('/api/admin/template/excel', authRequired, adminRequired, (req, res) => {
  try {
    const wb = XLSX.utils.book_new();
    const sampleData = [
      {
        '题型': '单选',
        '题目': 'HTML的全称是什么？',
        '选项A': 'Hyper Text Markup Language',
        '选项B': 'High Tech Modern Language',
        '选项C': 'Home Tool Markup Language',
        '选项D': 'Hyperlinks Text Markup',
        '正确答案': 'A',
        '分值': 10
      },
      {
        '题型': '多选',
        '题目': '以下哪些是HTML5语义标签？',
        '选项A': 'header',
        '选项B': 'footer',
        '选项C': 'content',
        '选项D': 'section',
        '正确答案': 'A,B,D',
        '分值': 15
      },
      {
        '题型': '判断',
        '题目': 'JavaScript和Java是同一种编程语言',
        '正确答案': '错误',
        '分值': 5
      },
      {
        '题型': '简答',
        '题目': '请简要说明HTTP和HTTPS的区别',
        '正确答案': 'HTTPS是HTTP的安全版本，通过SSL/TLS加密传输数据',
        '分值': 10
      }
    ];

    const ws = XLSX.utils.json_to_sheet(sampleData);

    ws['!cols'] = [
      { wch: 8 },
      { wch: 45 },
      { wch: 35 },
      { wch: 35 },
      { wch: 35 },
      { wch: 35 },
      { wch: 18 },
      { wch: 8 }
    ];

    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="exam-template.xlsx"');
    res.setHeader('Content-Length', buf.length);
    res.send(buf);
  } catch (err) {
    console.error('[Template] Error:', err.message);
    res.status(500).json({ error: '生成模板失败: ' + err.message });
  }
});

app.delete('/api/admin/questions/:id', authRequired, adminRequired, (req, res) => {
  run("DELETE FROM questions WHERE id = ?", [req.params.id]);
  res.json({ message: '删除成功' });
});

// ============================================================
// Admin Routes - Submissions List (with filters)
// ============================================================
app.get('/api/admin/submissions', authRequired, adminRequired, (req, res) => {
  try {
    const { month, work_zone, exam_id, page = 1, limit = 50 } = req.query;

    let sql = `
      SELECT s.*, u.username, u.work_zone, e.title as exam_title, e.total_score as exam_total_score
      FROM submissions s
      JOIN users u ON s.user_id = u.id
      JOIN exams e ON s.exam_id = e.id
      WHERE s.status IN ('submitted', 'graded')
    `;
    const params = [];

    if (month) {
      sql += ` AND strftime('%Y-%m', s.submitted_at) = ?`;
      params.push(month);
    }

    if (work_zone) {
      sql += ` AND u.work_zone LIKE ?`;
      params.push(`%${work_zone}%`);
    }

    if (exam_id) {
      sql += ` AND s.exam_id = ?`;
      params.push(exam_id);
    }

    sql += ` ORDER BY s.submitted_at DESC`;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    sql += ` LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), offset);

    const submissions = queryAll(sql, params);

    // Get total count for pagination
    let countSql = `
      SELECT COUNT(*) as total
      FROM submissions s
      JOIN users u ON s.user_id = u.id
      JOIN exams e ON s.exam_id = e.id
      WHERE s.status IN ('submitted', 'graded')
    `;
    const countParams = [];
    if (month) {
      countSql += ` AND strftime('%Y-%m', s.submitted_at) = ?`;
      countParams.push(month);
    }
    if (work_zone) {
      countSql += ` AND u.work_zone LIKE ?`;
      countParams.push(`%${work_zone}%`);
    }
    if (exam_id) {
      countSql += ` AND s.exam_id = ?`;
      countParams.push(exam_id);
    }
    const totalResult = queryOne(countSql, countParams);

    res.json({
      submissions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalResult ? totalResult.total : 0,
        totalPages: Math.ceil((totalResult ? totalResult.total : 0) / parseInt(limit))
      }
    });
  } catch (err) {
    console.error('[Submissions API Error]', err);
    res.status(500).json({ error: '获取成绩列表失败: ' + err.message });
  }
});

// Export submissions to Excel
app.get('/api/admin/submissions/export', authRequired, adminRequired, (req, res) => {
  const { month, work_zone, exam_id } = req.query;

  let sql = `
    SELECT s.id, u.username, u.work_zone, e.title as exam_title,
      s.total_score, e.total_score as exam_total_score,
      ROUND(s.total_score * 100.0 / e.total_score, 1) as score_percent,
      CASE WHEN s.total_score >= e.passing_score THEN '及格' ELSE '不及格' END as pass_status,
      datetime(s.started_at, 'localtime') as start_time,
      datetime(s.submitted_at, 'localtime') as submit_time
    FROM submissions s
    JOIN users u ON s.user_id = u.id
    JOIN exams e ON s.exam_id = e.id
    WHERE s.status IN ('submitted', 'graded')
  `;
  const params = [];

  if (month) {
    sql += ` AND strftime('%Y-%m', s.submitted_at) = ?`;
    params.push(month);
  }

  if (work_zone) {
    sql += ` AND u.work_zone LIKE ?`;
    params.push(`%${work_zone}%`);
  }

  if (exam_id) {
    sql += ` AND s.exam_id = ?`;
    params.push(exam_id);
  }

  sql += ` ORDER BY s.submitted_at DESC`;

  const submissions = queryAll(sql, params);

  // Generate Excel
  const wb = XLSX.utils.book_new();

  const exportData = submissions.map(s => ({
    '考生': s.username,
    '养护工区': s.work_zone || '',
    '考试': s.exam_title,
    '得分': s.total_score,
    '总分': s.exam_total_score,
    '得分率(%)': s.score_percent || 0,
    '状态': s.pass_status,
    '开始时间': s.start_time,
    '提交时间': s.submit_time
  }));

  const ws = XLSX.utils.json_to_sheet(exportData);

  // Set column widths
  ws['!cols'] = [
    { wch: 15 }, // 考生
    { wch: 20 }, // 养护工区
    { wch: 30 }, // 考试
    { wch: 8 },  // 得分
    { wch: 8 },  // 总分
    { wch: 12 }, // 得分率
    { wch: 8 },  // 状态
    { wch: 20 }, // 开始时间
    { wch: 20 }  // 提交时间
  ];

  XLSX.utils.book_append_sheet(wb, ws, '成绩列表');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  // Build filename
  let filename = '成绩导出';
  if (month) filename += `_${month}`;
  if (work_zone) filename += `_${work_zone}`;
  filename += '.xlsx';

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(Buffer.from(buf));
});

// ============================================================
// Admin Routes - Statistics (Enhanced with wrong answer analysis)
// ============================================================
app.get('/api/admin/stats', authRequired, adminRequired, (req, res) => {
  const totalUsers = queryOne("SELECT COUNT(*) as count FROM users WHERE role = 'student'");
  const totalExams = queryOne("SELECT COUNT(*) as count FROM exams");
  const totalSubmissions = queryOne("SELECT COUNT(*) as count FROM submissions WHERE status IN ('submitted', 'graded')");
  const avgScore = queryOne("SELECT ROUND(AVG(total_score), 1) as avg FROM submissions WHERE status IN ('submitted', 'graded')");
  const passRate = queryOne(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN s.total_score >= e.passing_score THEN 1 ELSE 0 END) as passed
    FROM submissions s
    JOIN exams e ON s.exam_id = e.id
    WHERE s.status IN ('submitted', 'graded')
  `);

  const recentSubmissions = queryAll(`
    SELECT s.*, u.username, e.title as exam_title
    FROM submissions s
    JOIN users u ON s.user_id = u.id
    JOIN exams e ON s.exam_id = e.id
    WHERE s.status IN ('submitted', 'graded')
    ORDER BY s.submitted_at DESC
    LIMIT 10
  `);

  const scoreDistribution = queryAll(`
    SELECT
      CASE
        WHEN total_score >= 90 THEN '90-100'
        WHEN total_score >= 80 THEN '80-89'
        WHEN total_score >= 70 THEN '70-79'
        WHEN total_score >= 60 THEN '60-69'
        ELSE '0-59'
      END as range,
      COUNT(*) as count
    FROM submissions WHERE status IN ('submitted', 'graded')
    GROUP BY range ORDER BY range
  `);

  // Wrong answer analysis: top 10 most-missed questions
  const wrongAnswerRanking = queryAll(`
    SELECT
      q.id, q.question_text, q.type, q.score, e.title as exam_title,
      COUNT(a.id) as total_answers,
      SUM(CASE WHEN a.is_correct = 1 THEN 1 ELSE 0 END) as correct_count,
      SUM(CASE WHEN a.is_correct = 0 THEN 1 ELSE 0 END) as wrong_count,
      ROUND(SUM(CASE WHEN a.is_correct = 0 THEN 1.0 ELSE 0 END) / COUNT(a.id) * 100, 1) as wrong_rate
    FROM questions q
    JOIN exams e ON q.exam_id = e.id
    LEFT JOIN answers a ON q.id = a.question_id
    GROUP BY q.id
    HAVING total_answers > 0
    ORDER BY wrong_rate DESC
    LIMIT 20
  `);

  // Wrong answer distribution by exam
  const examWrongStats = queryAll(`
    SELECT
      e.id, e.title,
      COUNT(a.id) as total_answers,
      SUM(CASE WHEN a.is_correct = 0 THEN 1 ELSE 0 END) as wrong_count,
      ROUND(SUM(CASE WHEN a.is_correct = 0 THEN 1.0 ELSE 0 END) / COUNT(a.id) * 100, 1) as wrong_rate
    FROM exams e
    JOIN questions q ON q.exam_id = e.id
    LEFT JOIN answers a ON q.id = a.question_id
    GROUP BY e.id
    HAVING total_answers > 0
    ORDER BY wrong_rate DESC
  `);

  res.json({
    totalUsers: totalUsers ? totalUsers.count : 0,
    totalExams: totalExams ? totalExams.count : 0,
    totalSubmissions: totalSubmissions ? totalSubmissions.count : 0,
    avgScore: avgScore ? (avgScore.avg || 0) : 0,
    passRate: passRate && passRate.total > 0 ? Math.round(passRate.passed / passRate.total * 100) : 0,
    recentSubmissions,
    scoreDistribution,
    wrongAnswerRanking,
    examWrongStats
  });
});

app.get('/api/admin/stats/exam/:id', authRequired, adminRequired, (req, res) => {
  const exam = queryOne(`
    SELECT e.*,
      (SELECT COUNT(*) FROM questions WHERE exam_id = e.id) as question_count
    FROM exams e WHERE e.id = ?
  `, [req.params.id]);

  if (!exam) return res.status(404).json({ error: '考试不存在' });

  const submissions = queryAll(`
    SELECT s.*, u.username
    FROM submissions s
    JOIN users u ON s.user_id = u.id
    WHERE s.exam_id = ? AND s.status IN ('submitted', 'graded')
    ORDER BY s.total_score DESC
  `, [exam.id]);

  const stats = queryOne(`
    SELECT
      COUNT(*) as total_candidates,
      ROUND(AVG(total_score), 1) as avg_score,
      MAX(total_score) as max_score,
      MIN(total_score) as min_score,
      SUM(CASE WHEN total_score >= ? THEN 1 ELSE 0 END) as passed_count
    FROM submissions WHERE exam_id = ? AND status IN ('submitted', 'graded')
  `, [exam.passing_score, exam.id]);

  // Per-question accuracy/wrong-rate analysis
  const questionStats = queryAll(`
    SELECT
      q.id, q.question_text, q.type, q.score,
      COUNT(a.id) as answer_count,
      SUM(CASE WHEN a.is_correct = 1 THEN 1 ELSE 0 END) as correct_count,
      SUM(CASE WHEN a.is_correct = 0 THEN 1 ELSE 0 END) as wrong_count,
      ROUND(AVG(a.is_correct) * 100, 1) as accuracy,
      ROUND(SUM(CASE WHEN a.is_correct = 0 THEN 1.0 ELSE 0 END) / NULLIF(COUNT(a.id), 0) * 100, 1) as wrong_rate
    FROM questions q
    LEFT JOIN answers a ON q.id = a.question_id
    WHERE q.exam_id = ?
    GROUP BY q.id
    ORDER BY wrong_rate DESC, q.sort_order, q.id
  `, [exam.id]);

  // Distribution of wrong answers per question options (for single/multiple choice)
  const optionDistributions = queryAll(`
    SELECT
      q.id as question_id,
      q.type,
      q.options,
      a.user_answer,
      COUNT(*) as count
    FROM questions q
    JOIN answers a ON q.id = a.question_id
    WHERE q.exam_id = ? AND a.is_correct = 0 AND q.type IN ('single_choice', 'multiple_choice')
    GROUP BY q.id, a.user_answer
    ORDER BY q.id, count DESC
  `, [exam.id]);

  res.json({ exam, submissions, stats, questionStats, optionDistributions });
});

// Export
app.get('/api/admin/export/:examId', authRequired, adminRequired, (req, res) => {
  const exam = queryOne("SELECT * FROM exams WHERE id = ?", [req.params.examId]);
  if (!exam) return res.status(404).json({ error: '考试不存在' });

  const submissions = queryAll(`
    SELECT s.*, u.username, u.email
    FROM submissions s
    JOIN users u ON s.user_id = u.id
    WHERE s.exam_id = ? AND s.status IN ('submitted', 'graded')
    ORDER BY s.total_score DESC
  `, [exam.id]);

  const questions = queryAll(
    "SELECT * FROM questions WHERE exam_id = ? ORDER BY sort_order, id",
    [exam.id]
  );

  // Generate Excel export
  const wb = XLSX.utils.book_new();

  // Summary sheet
  const summaryData = [
    { '指标': '考试名称', '值': exam.title },
    { '指标': '总分', '值': exam.total_score },
    { '指标': '及格线', '值': exam.passing_score },
    { '指标': '考生人数', '值': submissions.length },
    { '指标': '平均分', '值': submissions.length > 0 ? (submissions.reduce((s, r) => s + (r.total_score || 0), 0) / submissions.length).toFixed(1) : 0 },
    { '指标': '最高分', '值': submissions.length > 0 ? Math.max(...submissions.map(r => r.total_score || 0)) : 0 },
    { '指标': '最低分', '值': submissions.length > 0 ? Math.min(...submissions.map(r => r.total_score || 0)) : 0 },
    { '指标': '通过率', '值': submissions.length > 0 ? Math.round(submissions.filter(r => (r.total_score || 0) >= exam.passing_score).length / submissions.length * 100) + '%' : '0%' }
  ];

  const summaryWs = XLSX.utils.json_to_sheet(summaryData);
  XLSX.utils.book_append_sheet(wb, summaryWs, '成绩汇总');

  // Detail sheet
  const detailData = submissions.map(s => ({
    '用户名': s.username,
    '邮箱': s.email || '',
    '开始时间': s.started_at,
    '提交时间': s.submitted_at,
    '得分': s.total_score,
    '总分': exam.total_score,
    '通过': s.total_score >= exam.passing_score ? '是' : '否',
    '排名': ''
  }));
  detailData.sort((a, b) => b['得分'] - a['得分']);
  detailData.forEach((r, i) => r['排名'] = i + 1);

  const detailWs = XLSX.utils.json_to_sheet(detailData);
  XLSX.utils.book_append_sheet(wb, detailWs, '考生成绩明细');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(exam.title)}_成绩导出.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(Buffer.from(buf));
});

// ============================================================
// Admin Routes - User Management (Full CRUD)
// ============================================================
app.get('/api/admin/users', authRequired, adminRequired, (req, res) => {
  const { work_zone } = req.query;
  let sql = `
    SELECT u.id, u.username, u.work_zone, u.role, u.created_at,
      (SELECT COUNT(*) FROM submissions WHERE user_id = u.id AND status IN ('submitted', 'graded')) as submission_count,
      (SELECT ROUND(AVG(total_score), 1) FROM submissions WHERE user_id = u.id AND status IN ('submitted', 'graded')) as avg_score
    FROM users u
    WHERE 1=1
  `;
  const params = [];

  if (work_zone) {
    sql += ` AND u.work_zone LIKE ?`;
    params.push(`%${work_zone}%`);
  }

  sql += ` ORDER BY u.created_at DESC`;

  const users = queryAll(sql, params);
  res.json({ users });
});

// Create user (admin creates student accounts)
app.post('/api/admin/users', authRequired, adminRequired, (req, res) => {
  const { username, password, work_zone, role } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }
  if (password.length < 3) {
    return res.status(400).json({ error: '密码至少3位' });
  }
  if (!work_zone || work_zone.trim() === '') {
    return res.status(400).json({ error: '养护工区不能为空' });
  }

  const existing = queryOne("SELECT id FROM users WHERE username = ?", [username]);
  if (existing) {
    return res.status(409).json({ error: '用户名已存在' });
  }

  const validRoles = ['student', 'admin'];
  const userRole = validRoles.includes(role) ? role : 'student';

  const passwordHash = bcrypt.hashSync(password, 10);
  const result = run(
    "INSERT INTO users (username, work_zone, password_hash, role) VALUES (?, ?, ?, ?)",
    [username, work_zone.trim(), passwordHash, userRole]
  );

  const newUser = queryOne(
    "SELECT id, username, work_zone, role, created_at FROM users WHERE id = ?",
    [result]
  );

  res.json({ user: newUser, message: '用户创建成功' });
});

// Delete user
app.delete('/api/admin/users/:id', authRequired, adminRequired, (req, res) => {
  const userId = parseInt(req.params.id);
  const user = queryOne("SELECT * FROM users WHERE id = ?", [userId]);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }
  if (user.role === 'admin') {
    // Prevent deleting self or last admin
    const adminCount = queryOne("SELECT COUNT(*) as count FROM users WHERE role = 'admin'");
    if (adminCount && adminCount.count <= 1 && user.id === req.user.id) {
      return res.status(400).json({ error: '不能删除唯一的管理员账号' });
    }
  }

  // Delete related data
  run("DELETE FROM answers WHERE submission_id IN (SELECT id FROM submissions WHERE user_id = ?)", [userId]);
  run("DELETE FROM submissions WHERE user_id = ?", [userId]);
  run("DELETE FROM users WHERE id = ?", [userId]);

  res.json({ message: '用户已删除' });
});

// Reset/Change user password
app.put('/api/admin/users/:id/password', authRequired, adminRequired, (req, res) => {
  const userId = parseInt(req.params.id);
  const { newPassword } = req.body;

  if (!newPassword || newPassword.length < 3) {
    return res.status(400).json({ error: '新密码至少3位' });
  }

  const user = queryOne("SELECT * FROM users WHERE id = ?", [userId]);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }

  const passwordHash = bcrypt.hashSync(newPassword, 10);
  run("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, userId]);

  res.json({ message: `用户 ${user.username} 的密码已重置` });
});

// Bulk import users from Excel
app.post('/api/admin/users/import', authRequired, adminRequired, upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请上传Excel文件' });
    }

    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (!data || data.length === 0) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: '文件中没有数据' });
    }

    let imported = 0;
    const errors = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const username = String(row['用户名'] || row['username'] || row['Username'] || '').trim();
      const password = String(row['密码'] || row['password'] || row['Password'] || '123456').trim();
      const work_zone = String(row['养护工区'] || row['work_zone'] || row['WorkZone'] || '').trim();

      if (!username) {
        errors.push(`第${i + 1}行: 用户名为空`);
        continue;
      }
      if (!work_zone) {
        errors.push(`第${i + 1}行: 养护工区为空，已跳过`);
        continue;
      }

      const existing = queryOne("SELECT id FROM users WHERE username = ?", [username]);
      if (existing) {
        errors.push(`第${i + 1}行: 用户名"${username}"已存在，已跳过`);
        continue;
      }

      const passwordHash = bcrypt.hashSync(password, 10);
      try {
        run(
          "INSERT INTO users (username, work_zone, password_hash, role) VALUES (?, ?, ?, 'student')",
          [username, work_zone, passwordHash]
        );
        imported++;
      } catch (e) {
        errors.push(`第${i + 1}行: ${e.message}`);
      }
    }

    try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }

    res.json({
      imported,
      errors: errors.length > 0 ? errors : undefined,
      message: `成功导入 ${imported} 名用户` + (errors.length > 0 ? `，${errors.length} 行失败` : '')
    });
  } catch (err) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }
    res.status(500).json({ error: '导入失败: ' + err.message });
  }
});

// ============================================================
// Static Pages
// ============================================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

app.use('/admin', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (path.extname(req.path)) return next();
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

// Error Handler
app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: '文件大小不能超过10MB' });
  }
  if (err.message && err.message.includes('仅支持')) {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: '服务器内部错误' });
});

// ============================================================
// Start Server
// ============================================================
async function start() {
  await initDatabase();

  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════╗
║     📝 在线考试系统 Premium v2.0             ║
║     ✨ iOS 26/27 Design Language             ║
║                                              ║
║  考生端:  http://localhost:${PORT}              ║
║  管理端:  http://localhost:${PORT}/admin        ║
║                                              ║
║  默认管理员: admin / admin123                 ║
╚══════════════════════════════════════════════╝
    `);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

module.exports = app;
