const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const BOOKING_MINUTES = 60; // every laundry slot is one hour
const BCRYPT_ROUNDS = 10;

// JWT secret: from env, else generated once and persisted next to the app.
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(__dirname, '.jwt-secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}
const JWT_SECRET = loadSecret();

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    institute: u.institute,
    email: u.email,
    mobile: u.mobile,
    hostelBlock: u.hostel_block,
    roomNumber: u.room_number,
  };
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
    if (!user) return res.status(401).json({ error: 'Account no longer exists' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired, please log in again' });
  }
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, try again later' },
});

// ---------- auth ----------
app.post('/api/register', authLimiter, async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const institute = String(b.institute || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  const mobile = String(b.mobile || '').trim();
  const hostelBlock = String(b.hostelBlock || '').trim();
  const roomNumber = String(b.roomNumber || '').trim();

  const errors = {};
  if (!name) errors.name = 'Name is required';
  if (!institute) errors.institute = 'Institute name is required';
  if (!EMAIL_RE.test(email)) errors.email = 'Please enter a valid email';
  if (password.length < 6) errors.password = 'Password must be at least 6 characters';
  if (!/^\d{10}$/.test(mobile)) errors.mobile = 'Enter a valid 10-digit mobile number';
  if (!['A', 'B', 'C', 'D'].includes(hostelBlock)) errors.hostelBlock = 'Please select hostel block';
  if (!roomNumber) errors.roomNumber = 'Room number is required';
  if (Object.keys(errors).length) return res.status(400).json({ error: 'Validation failed', fields: errors });

  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'Email already registered', fields: { email: 'Email already registered' } });
  }

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  try {
    db.prepare(
      `INSERT INTO users (name, institute, email, password_hash, mobile, hostel_block, room_number)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(name, institute, email, hash, mobile, hostelBlock, roomNumber);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Email already registered', fields: { email: 'Email already registered' } });
    }
    throw e;
  }
  res.status(201).json({ ok: true });
});

// A real hash of a throwaway string, so unknown emails cost the same time as wrong passwords.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

app.post('/api/login', authLimiter, async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const password = String((req.body || {}).password || '');
  if (!EMAIL_RE.test(email) || !password) return res.status(400).json({ error: 'Email and password are required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) return res.status(401).json({ error: 'Invalid email or password' });

  const token = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: publicUser(user) });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

// ---------- laundry ----------
function machineStatus(now) {
  const machines = db.prepare('SELECT id, name FROM machines ORDER BY id').all();
  const current = db.prepare(
    `SELECT end_ms FROM laundry_bookings WHERE machine_id = ? AND start_ms <= ? AND end_ms > ? LIMIT 1`
  );
  return machines.map((m) => {
    const b = current.get(m.id, now, now);
    return {
      id: m.id,
      name: m.name,
      inUse: !!b,
      minutesRemaining: b ? Math.ceil((b.end_ms - now) / 60000) : 0,
    };
  });
}

app.get('/api/laundry/status', auth, (req, res) => {
  res.json({ machines: machineStatus(Date.now()), slotMinutes: BOOKING_MINUTES });
});

// Booked windows for a machine, so the UI can show what is taken.
app.get('/api/laundry/slots', auth, (req, res) => {
  const machineId = Number(req.query.machineId);
  const rows = db.prepare(
    `SELECT start_ms, end_ms FROM laundry_bookings
     WHERE machine_id = ? AND end_ms > ? ORDER BY start_ms`
  ).all(machineId, Date.now());
  res.json({ booked: rows.map((r) => ({ start: new Date(r.start_ms).toISOString(), end: new Date(r.end_ms).toISOString() })) });
});

app.get('/api/laundry/bookings', auth, (req, res) => {
  const rows = db.prepare(
    `SELECT b.id, b.machine_id, m.name AS machine_name, b.start_ms, b.end_ms
     FROM laundry_bookings b JOIN machines m ON m.id = b.machine_id
     WHERE b.user_id = ? AND b.end_ms > ? ORDER BY b.start_ms`
  ).all(req.user.id, Date.now());
  res.json({
    bookings: rows.map((r) => ({
      id: r.id,
      machineId: r.machine_id,
      machineName: r.machine_name,
      start: new Date(r.start_ms).toISOString(),
      end: new Date(r.end_ms).toISOString(),
    })),
  });
});

app.post('/api/laundry/book', auth, (req, res) => {
  const machineId = Number((req.body || {}).machineId);
  const startMs = new Date((req.body || {}).start).getTime();
  if (!Number.isInteger(machineId) || Number.isNaN(startMs)) {
    return res.status(400).json({ error: 'machineId and a valid start time are required' });
  }
  if (!db.prepare('SELECT 1 FROM machines WHERE id = ?').get(machineId)) {
    return res.status(404).json({ error: 'Machine not found' });
  }
  if (startMs < Date.now()) return res.status(400).json({ error: 'Cannot book a slot in the past' });
  if (startMs > Date.now() + 14 * 24 * 3600 * 1000) {
    return res.status(400).json({ error: 'Slots can only be booked up to 14 days ahead' });
  }
  const endMs = startMs + BOOKING_MINUTES * 60000;

  // Check and insert inside one write transaction so two simultaneous requests cannot both pass the check.
  db.exec('BEGIN IMMEDIATE');
  try {
    // Two intervals [a,b) and [c,d) overlap exactly when a < d and c < b.
    const machineClash = db.prepare(
      `SELECT start_ms FROM laundry_bookings WHERE machine_id = ? AND start_ms < ? AND end_ms > ? LIMIT 1`
    ).get(machineId, endMs, startMs);
    if (machineClash) {
      db.exec('ROLLBACK');
      return res.status(409).json({
        error: 'That slot overlaps an existing booking on this machine. Please choose another time or machine.',
      });
    }
    // A student cannot hold two machines at the same time either.
    const userClash = db.prepare(
      `SELECT start_ms FROM laundry_bookings WHERE user_id = ? AND start_ms < ? AND end_ms > ? LIMIT 1`
    ).get(req.user.id, endMs, startMs);
    if (userClash) {
      db.exec('ROLLBACK');
      return res.status(409).json({ error: 'You already have a laundry booking at that time.' });
    }
    const info = db.prepare(
      `INSERT INTO laundry_bookings (user_id, machine_id, start_ms, end_ms) VALUES (?, ?, ?, ?)`
    ).run(req.user.id, machineId, startMs, endMs);
    db.exec('COMMIT');
    res.status(201).json({
      booking: {
        id: Number(info.lastInsertRowid),
        machineId,
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
      },
    });
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'That slot was just taken. Please choose another.' });
    }
    throw e;
  }
});

app.delete('/api/laundry/bookings/:id', auth, (req, res) => {
  const info = db.prepare('DELETE FROM laundry_bookings WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Booking not found' });
  res.json({ ok: true });
});

// ---------- mess ----------
const MENU = ['Chicken Curry', 'Rice', 'Salad'];
const today = () => new Date().toISOString().slice(0, 10);

app.get('/api/mess/menu', auth, (req, res) => {
  const mine = db.prepare('SELECT preference, feedback FROM mess_feedback WHERE user_id = ? AND meal_date = ?').get(req.user.id, today());
  res.json({ date: today(), menu: MENU, mine: mine || null });
});

app.post('/api/mess/preference', auth, (req, res) => {
  const preference = String((req.body || {}).preference || '');
  const feedback = String((req.body || {}).feedback || '').trim().slice(0, 1000);
  if (!['full', 'half', 'skip'].includes(preference)) return res.status(400).json({ error: 'Invalid meal preference' });
  db.prepare(
    `INSERT INTO mess_feedback (user_id, meal_date, preference, feedback) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, meal_date) DO UPDATE SET preference = excluded.preference, feedback = excluded.feedback`
  ).run(req.user.id, today(), preference, feedback || null);
  res.json({ ok: true });
});

// ---------- lost & found ----------
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '')),
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpe?g|gif|webp)$/.test(file.mimetype)),
});
app.use('/uploads', express.static(UPLOAD_DIR));

app.post('/api/lost-found', auth, upload.single('image'), (req, res) => {
  const kind = String(req.body.kind || '');
  const description = String(req.body.description || '').trim();
  const location = String(req.body.location || '').trim();
  if (!['lost', 'found'].includes(kind)) return res.status(400).json({ error: 'kind must be lost or found' });
  if (!description) return res.status(400).json({ error: 'Description is required' });
  const info = db.prepare(
    'INSERT INTO lost_found (user_id, kind, description, location, image_path) VALUES (?, ?, ?, ?, ?)'
  ).run(req.user.id, kind, description.slice(0, 1000), location.slice(0, 200) || null, req.file ? '/uploads/' + req.file.filename : null);
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

app.get('/api/lost-found', auth, (req, res) => {
  const rows = db.prepare(
    `SELECT l.id, l.kind, l.description, l.location, l.image_path AS image, l.created_at, u.name AS reporter
     FROM lost_found l JOIN users u ON u.id = l.user_id WHERE l.status = 'open' ORDER BY l.id DESC LIMIT 50`
  ).all();
  res.json({ items: rows });
});

// ---------- notices & issues ----------
app.get('/api/notices', auth, (req, res) => {
  res.json({ notices: db.prepare('SELECT id, title, created_at FROM notices ORDER BY id').all() });
});

app.post('/api/issues', auth, (req, res) => {
  const type = String((req.body || {}).type || '');
  const description = String((req.body || {}).description || '').trim();
  if (!['cleaning', 'technician'].includes(type)) return res.status(400).json({ error: 'Invalid issue type' });
  if (!description) return res.status(400).json({ error: 'Please describe the issue' });
  const info = db.prepare('INSERT INTO issues (user_id, type, description) VALUES (?, ?, ?)').run(req.user.id, type, description.slice(0, 2000));
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

// ---------- errors ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Campus Hub running at http://localhost:${PORT}`));
}
module.exports = app;
