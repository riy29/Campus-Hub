// Integration test: spins up the app on a temp database and exercises the key guarantees.
process.env.DB_PATH = require('path').join(require('os').tmpdir(), `campus-hub-test-${Date.now()}.db`);
const assert = require('assert');
const app = require('./server');
const db = require('./db');

(async () => {
  const server = app.listen(0);
  const base = `http://localhost:${server.address().port}/api`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
  const user = (n) => ({ name: 'U' + n, institute: 'IITP', email: `u${n}@iitp.ac.in`, password: 'secret123', mobile: '9876543210', hostelBlock: 'A', roomNumber: '10' + n });
  let pass = 0;
  const ok = (name) => console.log('  ok  ' + name) || pass++;

  // registration + hashing
  assert.equal((await call('/register', { method: 'POST', body: user(1) })).status, 201);
  assert.equal((await call('/register', { method: 'POST', body: user(2) })).status, 201);
  ok('register users');
  const row = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('u1@iitp.ac.in');
  assert.notEqual(row.password_hash, 'secret123');
  assert.match(row.password_hash, /^\$2[aby]\$10\$/);
  ok('password stored as bcrypt hash, not plaintext');
  assert.equal((await call('/register', { method: 'POST', body: user(1) })).status, 409);
  assert.equal((await call('/register', { method: 'POST', body: { ...user(3), password: '123' } })).status, 400);
  ok('duplicate email and weak password rejected');

  // login
  assert.equal((await call('/login', { method: 'POST', body: { email: 'u1@iitp.ac.in', password: 'wrong' } })).status, 401);
  const l1 = await call('/login', { method: 'POST', body: { email: 'u1@iitp.ac.in', password: 'secret123' } });
  const l2 = await call('/login', { method: 'POST', body: { email: 'u2@iitp.ac.in', password: 'secret123' } });
  assert.equal(l1.status, 200);
  assert.ok(!JSON.stringify(l1.data).includes('password'));
  ok('login works, wrong password rejected, no password in response');
  const t1 = l1.data.token, t2 = l2.data.token;

  assert.equal((await call('/laundry/status')).status, 401);
  ok('protected routes require a token');

  // double booking
  const slot = new Date(Date.now() + 3 * 3600 * 1000); slot.setSeconds(0, 0);
  const iso = (offMin) => new Date(slot.getTime() + offMin * 60000).toISOString();

  assert.equal((await call('/laundry/book', { method: 'POST', token: t1, body: { machineId: 1, start: iso(0) } })).status, 201);
  ok('first booking succeeds');
  assert.equal((await call('/laundry/book', { method: 'POST', token: t2, body: { machineId: 1, start: iso(0) } })).status, 409);
  ok('same machine, same time: rejected');
  assert.equal((await call('/laundry/book', { method: 'POST', token: t2, body: { machineId: 1, start: iso(30) } })).status, 409);
  assert.equal((await call('/laundry/book', { method: 'POST', token: t2, body: { machineId: 1, start: iso(-30) } })).status, 409);
  ok('partially overlapping slots (before and after): rejected');
  assert.equal((await call('/laundry/book', { method: 'POST', token: t2, body: { machineId: 1, start: iso(60) } })).status, 201);
  ok('back-to-back slot (starts exactly when previous ends): allowed');
  assert.equal((await call('/laundry/book', { method: 'POST', token: t1, body: { machineId: 2, start: iso(0) } })).status, 409);
  ok('same user cannot hold two machines at once');
  assert.equal((await call('/laundry/book', { method: 'POST', token: t2, body: { machineId: 2, start: iso(0) } })).status, 201);
  ok('other machine, same time, different user: allowed');
  assert.equal((await call('/laundry/book', { method: 'POST', token: t1, body: { machineId: 1, start: new Date(Date.now() - 3600000).toISOString() } })).status, 400);
  ok('past slot rejected');

  // concurrent race
  const racer = new Date(slot.getTime() + 5 * 3600 * 1000).toISOString();
  const racers = await Promise.all([t1, t2, t1, t2, t1].map((t) => call('/laundry/book', { method: 'POST', token: t, body: { machineId: 1, start: racer } })));
  assert.equal(racers.filter((r) => r.status === 201).length, 1);
  ok('5 simultaneous requests for one slot: exactly 1 wins');

  // cancel frees the slot
  const mine = await call('/laundry/bookings', { token: t1 });
  const first = mine.data.bookings.find((b) => b.start === iso(0));
  assert.equal((await call('/laundry/bookings/' + first.id, { method: 'DELETE', token: t2 })).status, 404);
  assert.equal((await call('/laundry/bookings/' + first.id, { method: 'DELETE', token: t1 })).status, 200);
  assert.equal((await call('/laundry/book', { method: 'POST', token: t2, body: { machineId: 1, start: iso(-60) } })).status, 201);
  ok('only owner can cancel; cancelled slot becomes bookable');

  // other modules
  assert.equal((await call('/mess/preference', { method: 'POST', token: t1, body: { preference: 'half', feedback: 'ok' } })).status, 200);
  assert.equal((await call('/mess/preference', { method: 'POST', token: t1, body: { preference: 'bogus' } })).status, 400);
  assert.equal((await call('/issues', { method: 'POST', token: t1, body: { type: 'cleaning', description: 'Dirty corridor' } })).status, 201);
  assert.equal((await call('/notices', { token: t1 })).data.notices.length, 3);
  ok('mess, issues, notices');

  server.close();
  console.log(`\nAll ${pass} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
