require('dotenv').config();
// Render's free-tier containers have no outbound IPv6 route. Node's default
// DNS resolution order can still hand back an IPv6 (AAAA) address first for
// hosts that have both - and 'family: 4' on an individual socket doesn't
// reliably override that on every Node version. Setting this here forces
// IPv4-first resolution for every DNS lookup in the whole process (SMTP,
// Supabase, etc.), which is more robust than fixing it per-call.
require('dns').setDefaultResultOrder('ipv4first');
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const db = require('./db');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

// A fixed fallback string checked into source (e.g. the old
// 'change-this-secret-in-production') is just as much a standing risk as a
// hardcoded admin password: anyone who's seen this repo already knows it,
// and express-session uses it to sign the cookie that says "this browser is
// logged in as admin" - knowing the secret lets you forge that cookie
// outright, no password needed. Same fix as the admin password in db.js:
// generate a real random one instead. Unlike the password, this one has to
// be stable across restarts (regenerating it would silently log every admin
// out each time the process restarts), so it's persisted to a local file
// rather than only printed - and unlike db.json, it's pure entropy with no
// reason to ever be read or edited by hand, so a dotfile that tooling
// naturally skips is a better fit than another top-level data file.
const SESSION_SECRET_FILE = path.join(__dirname, '..', 'data', '.session-secret');
function getOrCreateSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  try {
    return fs.readFileSync(SESSION_SECRET_FILE, 'utf-8').trim();
  } catch {
    const generated = crypto.randomBytes(32).toString('hex');
    // 0o600: readable/writable by the owner only - this file is as
    // sensitive as a password, since anyone who can read it can forge an
    // admin session outright.
    fs.writeFileSync(SESSION_SECRET_FILE, generated, { mode: 0o600 });
    return generated;
  }
}

// Express sends "X-Powered-By: Express" on every response by default - free
// reconnaissance for an attacker (confirms the framework, narrows which
// CVEs/known issues to try) for zero benefit to real users. No reason to
// volunteer it.
app.disable('x-powered-by');

// Only trust the X-Forwarded-For header when explicitly told to (i.e. you've
// actually deployed behind a reverse proxy/load balancer like Render, Fly.io,
// Railway, or nginx). Trusting it unconditionally would let a client spoof
// their own IP and dodge the login rate limiter in server/routes/admin.js.
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', 1);
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Stops browsers from ever guessing a served file (e.g. a receipt/car photo
// upload) is something other than what its Content-Type says it is. Doesn't
// touch framing/CSP - deliberately not setting X-Frame-Options here since
// this is also served as a Telegram Mini App, which loads the page in an
// embedded webview that a blanket frame-deny would break.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

app.use(session({
  secret: getOrCreateSessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
    httpOnly: true,
    // 'auto' = secure only over HTTPS (checks req.secure, which respects the
    // trust-proxy setting above) - stays usable over plain http://localhost
    // in dev, but won't send the session cookie in cleartext once deployed
    // behind HTTPS. sameSite:'lax' stops the cookie being attached to
    // cross-site POSTs, which is the main practical CSRF defense here since
    // the admin panel doesn't use separate CSRF tokens.
    secure: 'auto',
    sameSite: 'lax'
  }
}));

// Car photos (raffle listing images) are public marketing content, so they
// stay served as plain static files. Payment receipts live in this same
// uploads/ folder (at its root, not under cars/) but are NOT mounted here -
// they're financial documents, and a static mount means anyone who ever
// obtains the URL (leaked via browser history, a referrer header, a shared
// screenshot, etc.) can view it forever with zero access control beyond an
// unguessable filename. Receipts are only reachable through the
// authenticated GET /api/orders/:id/receipt route in routes/public.js.
const uploadsDir = path.join(__dirname, '..', 'uploads');
const carPhotosDir = path.join(uploadsDir, 'cars');
if (!fs.existsSync(carPhotosDir)) fs.mkdirSync(carPhotosDir, { recursive: true });
app.use('/uploads/cars', express.static(carPhotosDir));

// API routes
app.use('/api', publicRoutes);
app.use('/api/admin', adminRoutes);

// Static frontend (customer app + admin panel).
// index.html gets explicit no-cache headers - Telegram's in-app browser
// has been observed holding onto a stale copy of it (and whatever it
// references) well past a redeploy, seemingly ignoring normal conditional
// caching. Bumping the ?v= on /app.js in index.html (see public/index.html)
// is what actually forces a fresh app.js fetch when this app updates -
// this header just makes sure the HTML *pointing* to that URL isn't itself
// stale.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

// The two most common "forgot to finish setup" security gaps are both
// silent otherwise - the app works fine either way, so nothing forces you
// to notice before real customers/money show up. Print a loud warning
// instead of staying quiet about it.
function printStartupWarnings() {
  const warnings = [];
  if (!process.env.SESSION_SECRET) {
    warnings.push('SESSION_SECRET is not set in .env - using an auto-generated one persisted to data/.session-secret instead (fine for a single instance). If you ever run more than one instance of this app behind a load balancer, set SESSION_SECRET explicitly to the same value on all of them, or each instance\'s sessions will only work against itself.');
  }
  if (!process.env.INTERNAL_API_KEY || !process.env.TELEGRAM_BOT_TOKEN) {
    warnings.push('INTERNAL_API_KEY and/or TELEGRAM_BOT_TOKEN is not set in .env - the Telegram bot will not be able to prefill name/phone in the mini app (POST /telegram/link and /telegram/prefill will just return 503). Fine if you\'re not using the Telegram bot.');
  }
  // Loading here (rather than only when routes need it) also has the side
  // effect of creating data/db.json - and printing the one-time generated
  // admin password to the console - on the very first run, before anyone
  // has a chance to hit the login page.
  try {
    db.load();
  } catch {
    // A broken check shouldn't block startup - worst case we just don't warn.
  }
  if (warnings.length) {
    console.warn('\n\u26A0\uFE0F  SECURITY WARNINGS:');
    warnings.forEach(w => console.warn(`   - ${w}`));
    console.warn('');
  }
}
// Restoring from Supabase (if configured) has to finish *before*
// printStartupWarnings() calls db.load(), or db.load() would see an empty
// data/db.json, think it's a genuine first run, and hand out a fresh
// random admin login even though real data is sitting in Supabase waiting
// to be pulled down. That await is the only reason startup is wrapped in
// an async function here.
async function start() {
  await require('./supabase-sync').pullLatestIntoLocalFile();

  printStartupWarnings();

  app.listen(PORT, () => {
    console.log(`Car raffle system running at http://localhost:${PORT}`);
    console.log(`Admin panel at http://localhost:${PORT}/admin  (username: admin - see above for the password on first run, or check data/db.json's existing setup)`);
  });
}
start();
