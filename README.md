# Campus Hub

A hostel services web app for students: book laundry machines, share mess preferences, report lost and found items, and read notices or raise maintenance issues.

It started as a frontend-only demo (data in `localStorage`) and is now a full-stack app with a Node/Express API and a SQLite database.

## Features

- **Accounts:** register and log in with an institute email. Passwords are hashed with bcrypt, sessions use JWT, and login and register are rate-limited.
- **Laundry Manager:** live machine status, 1-hour slot booking, cancel your own bookings. Double-booking is rejected (see below).
- **Mess Food Optimizer:** today's menu, one preference (full, half, skip) and feedback per student per day.
- **Lost & Found:** report lost or found items with an optional image (up to 2 MB), see recent reports.
- **Notices & Issues:** read notices, report cleaning or technician issues.

## How double-booking is prevented

Every slot lasts one hour. A booking request is rejected with HTTP 409 when it overlaps an existing booking on the same machine, or another booking the same student already holds. Back-to-back slots are allowed.

The overlap check and the insert run inside one `BEGIN IMMEDIATE` transaction, so simultaneous requests cannot both succeed. A unique index on `(machine_id, start_ms)` is a database-level backstop. The test suite fires 5 parallel requests at one slot and checks that exactly one wins.

## Tech stack

Node.js 22.5+, Express, SQLite (built-in `node:sqlite`, no native build), bcryptjs, jsonwebtoken, multer, express-rate-limit. Frontend is plain HTML and JS with Tailwind and Font Awesome from CDN.

## Getting started

```bash
git clone <your-repo-url>
cd campus-hub
npm install
npm start          # http://localhost:3000
npm test           # integration tests on a temporary database
```

Optional environment variables are listed in `.env.example` (`PORT`, `JWT_SECRET`, `DB_PATH`). If `JWT_SECRET` is not set, a random one is generated once and saved to `.jwt-secret`.

## Project structure

```
server.js        Express app and all API routes
db.js            SQLite schema and seed data
public/          Frontend (index.html)
test.js          Integration tests
uploads/         Uploaded lost and found images (git-ignored)
```

## API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | /api/register | Create account |
| POST | /api/login | Get JWT |
| GET | /api/me | Current user |
| GET | /api/laundry/status | Machine status |
| GET | /api/laundry/slots?machineId= | Upcoming booked windows |
| GET | /api/laundry/bookings | Your bookings |
| POST | /api/laundry/book | Book a slot (409 on conflict) |
| DELETE | /api/laundry/bookings/:id | Cancel your booking |
| GET | /api/mess/menu | Today's menu and your answer |
| POST | /api/mess/preference | Save preference and feedback |
| GET, POST | /api/lost-found | List or report items (multipart) |
| GET | /api/notices | List notices |
| POST | /api/issues | Report an issue |

All routes except register and login need an `Authorization: Bearer <token>` header.

## Limitations and next steps

- The mess menu is hardcoded and notices are seeded; there is no admin panel yet.
- No email verification or password reset.
- The token is kept in `localStorage`; an httpOnly cookie would be safer for production.

## License

MIT
