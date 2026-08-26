const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { randomInt, randomBytes, createHash, timingSafeEqual } = require('crypto');
const { nanoid } = require('nanoid');
const db = require('../db');
const { publicRaffle, verifyUploadedImage, handleUpload, numberStatus, randomAvailableNumbers, maskWinnerName } = require('../utils');
const { reportLockout, sendMail } = require('../alerts');
const { notifyCustomer, notifyAdmin, findChatIdByUsername, sendTelegramMessage } = require('../telegram');
const { getClient: getSupabaseClient } = require('../supabase-sync');

const router = express.Router();

// Used to equalize login response time whether or not the username exists -
// see the timing-safety comment on the /login handler below.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('not-a-real-password-just-for-timing', 10);

// ---- Car photo upload (raffle images) ----
const carPhotosDir = path.join(__dirname, '..', '..', 'uploads', 'cars');
if (!fs.existsSync(carPhotosDir)) fs.mkdirSync(carPhotosDir, { recursive: true });

const carPhotoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, carPhotosDir),
  filename: (req, file, cb) => {
    // Same whitelist approach as receipt uploads in public.js - never trust
    // a client-supplied filename/extension directly.
    const rawExt = path.extname(file.originalname).toLowerCase();
    const ext = /^\.(jpg|jpeg|png|gif|webp)$/.test(rawExt) ? rawExt : '.jpg';
    cb(null, `${Date.now()}_${nanoid(6)}${ext}`);
  }
});
const uploadCarPhoto = multer({
  storage: carPhotoStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed for car photos'));
  }
});

// Car photos have the same durability problem receipts had: saved to local
// disk, which is wiped on every redeploy on hosts with an ephemeral
// filesystem (Render free tier). Unlike receipts, these are shown directly
// on the public storefront, so a wiped photo isn't just an admin
// inconvenience - it's a broken image for every buyer browsing the site.
// This bucket is PUBLIC (unlike the private receipts bucket), since car
// photos are meant to be visible to anyone, with no auth gate needed.
const CAR_PHOTOS_BUCKET = 'car-photos';
let carPhotosBucketEnsured = false;
async function ensureCarPhotosBucket() {
  if (carPhotosBucketEnsured) return;
  const supabase = getSupabaseClient();
  if (!supabase) return;
  try {
    const { error } = await supabase.storage.createBucket(CAR_PHOTOS_BUCKET, { public: true });
    if (error && !/already exists/i.test(error.message || '')) {
      console.warn('⚠️  Could not create Supabase car-photos bucket:', error.message);
    }
  } catch (err) {
    console.warn('⚠️  Could not create Supabase car-photos bucket:', err.message);
  } finally {
    carPhotosBucketEnsured = true;
  }
}
ensureCarPhotosBucket();

function requireAuth(req, res, next) {
  if (req.session && req.session.adminId) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

// ---- Login brute-force protection ----
// Two layers, since each catches a different attack shape:
// 1. Per-IP sliding window - slows down a single scripted attacker hammering
//    many usernames/passwords from one machine. In-memory only (resets on
//    restart) since it's meant to throttle a live attack, not act as a
//    permanent ban list.
// 2. Per-account lockout - protects a specific admin account even if the
//    attacker spreads attempts across many IPs/botnets. Persisted in
//    data/db.json so it survives restarts.
const LOGIN_IP_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_IP_MAX_ATTEMPTS = 20;
const loginAttemptsByIp = new Map(); // ip -> { count, windowStart }

function isIpRateLimited(ip) {
  const now = Date.now();
  const entry = loginAttemptsByIp.get(ip);
  if (!entry || now - entry.windowStart > LOGIN_IP_WINDOW_MS) {
    loginAttemptsByIp.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > LOGIN_IP_MAX_ATTEMPTS;
}

const ACCOUNT_MAX_FAILED_ATTEMPTS = 5;
const ACCOUNT_LOCK_MS = 15 * 60 * 1000;

// Separate from the login limiter above - these two endpoints have their
// own cost/abuse shape (forgot-password sends a real email each time;
// reset-password lets someone try many token guesses). Tighter caps than
// login since there's no legitimate reason to hit either one often.
const RESET_IP_WINDOW_MS = 15 * 60 * 1000;
const RESET_IP_MAX_ATTEMPTS = 8;
const resetAttemptsByIp = new Map();
function isResetIpRateLimited(ip) {
  const now = Date.now();
  const entry = resetAttemptsByIp.get(ip);
  if (!entry || now - entry.windowStart > RESET_IP_WINDOW_MS) {
    resetAttemptsByIp.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > RESET_IP_MAX_ATTEMPTS;
}

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

// ---- Auth ----
router.post('/login', (req, res) => {
  if (isIpRateLimited(req.ip)) {
    reportLockout(`ip:${req.ip}`, `IP ${req.ip} exceeded ${LOGIN_IP_MAX_ATTEMPTS} login attempts in ${LOGIN_IP_WINDOW_MS / 60000} minutes.`);
    return res.status(429).json({ error: 'Too many login attempts from this network. Please try again later.' });
  }

  const { username, password } = req.body;
  const data = db.load();
  const admin = data.admins.find(a => a.username === username);

  // Locked accounts are rejected before checking the password at all, so a
  // correct password doesn't quietly bypass the lockout.
  if (admin && admin.lockedUntil && new Date(admin.lockedUntil).getTime() > Date.now()) {
    const minsLeft = Math.max(1, Math.ceil((new Date(admin.lockedUntil).getTime() - Date.now()) / 60000));
    return res.status(429).json({ error: `Account temporarily locked after repeated failed logins. Try again in ${minsLeft} minute(s).` });
  }

  // Always run bcrypt against *something*, even when the username doesn't
  // exist, and only branch on the result afterwards. bcrypt.compareSync is
  // deliberately slow (~50-100ms at cost factor 10) - short-circuiting past
  // it for unknown usernames would make existing-vs-nonexistent accounts
  // distinguishable purely by response time, even though the error message
  // below is identical either way.
  const passwordMatches = bcrypt.compareSync(password || '', admin ? admin.passwordHash : DUMMY_PASSWORD_HASH);
  const valid = !!admin && passwordMatches;
  if (!valid) {
    if (admin) {
      admin.failedLoginAttempts = (admin.failedLoginAttempts || 0) + 1;
      if (admin.failedLoginAttempts >= ACCOUNT_MAX_FAILED_ATTEMPTS) {
        admin.lockedUntil = new Date(Date.now() + ACCOUNT_LOCK_MS).toISOString();
        admin.failedLoginAttempts = 0;
        db.save(data);
        reportLockout(`account:${admin.username}`, `Admin account "${admin.username}" locked for 15 minutes after ${ACCOUNT_MAX_FAILED_ATTEMPTS} failed login attempts (from IP ${req.ip}).`);
        return res.status(429).json({ error: 'Too many failed attempts. This account is locked for 15 minutes.' });
      }
      db.save(data);
    }
    // Same generic message whether the username doesn't exist or the
    // password is wrong, so login can't be used to enumerate valid usernames.
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  admin.failedLoginAttempts = 0;
  admin.lockedUntil = null;
  db.save(data);
  req.session.adminId = admin.id;
  res.json({ ok: true, username: admin.username });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  if (!req.session.adminId) return res.status(401).json({ error: 'Not authenticated' });
  const data = db.load();
  const admin = data.admins.find(a => a.id === req.session.adminId);
  if (!admin) return res.status(401).json({ error: 'Not authenticated' });
  res.json({
    username: admin.username,
    email: admin.email || null,
    telegramUsername: admin.telegramUsername || null,
    telegramLinked: Boolean(admin.telegramChatId)
  });
});

// ---- Forgot / reset password ----
// Deliberately public (no requireAuth) - that's the entire point, someone
// using this has no valid session. Both routes always return the same
// generic response shape regardless of whether the username/token was
// real, so this can't be used to enumerate which usernames exist or
// whether a given token is merely expired vs never valid.
router.post('/forgot-password', async (req, res) => {
  if (isResetIpRateLimited(req.ip)) {
    reportLockout(`reset-request-ip:${req.ip}`, `IP ${req.ip} exceeded ${RESET_IP_MAX_ATTEMPTS} password-reset requests in ${RESET_IP_WINDOW_MS / 60000} minutes.`);
    return res.status(429).json({ error: 'Too many requests from this network. Please wait a bit and try again.' });
  }

  const generic = { ok: true, message: 'If that account exists and has a recovery email set, a reset link has been sent to it.' };
  const username = String((req.body && req.body.username) || '').trim();
  if (!username) return res.json(generic);

  const data = db.load();
  const admin = data.admins.find(a => a.username === username);
  if (!admin || !admin.email) return res.json(generic); // same response either way - see comment above

  const token = randomBytes(32).toString('hex');
  admin.resetTokenHash = hashToken(token);
  admin.resetTokenExpiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
  db.save(data);

  const origin = `${req.protocol}://${req.get('host')}`;
  const resetLink = `${origin}/admin/reset-password.html?token=${token}`;

  try {
    await sendMail({
      to: admin.email,
      subject: 'Reset your raffle admin password',
      text:
        `Someone (hopefully you) requested a password reset for the admin account "${admin.username}".\n\n` +
        `Reset your password here (expires in 30 minutes):\n${resetLink}\n\n` +
        `If you didn't request this, you can ignore this email - your password hasn't been changed.`
    });
  } catch (err) {
    console.error('[admin] Failed to send password-reset email:', err.message);
    // Still return the generic response - don't reveal to the caller
    // whether the account/email existed based on send success/failure.
  }

  res.json(generic);
});

router.post('/reset-password', (req, res) => {
  if (isResetIpRateLimited(req.ip)) {
    reportLockout(`reset-confirm-ip:${req.ip}`, `IP ${req.ip} exceeded ${RESET_IP_MAX_ATTEMPTS} password-reset confirmations in ${RESET_IP_WINDOW_MS / 60000} minutes - possible token guessing.`);
    return res.status(429).json({ error: 'Too many attempts from this network. Please wait a bit and try again.' });
  }

  const { token, newPassword } = req.body || {};
  if (!token || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'A valid reset link and a new password (6+ characters) are required.' });
  }

  const data = db.load();
  const tokenHash = hashToken(token);
  const tokenHashBuf = Buffer.from(tokenHash);
  const admin = data.admins.find(a => {
    if (!a.resetTokenHash) return false;
    const storedBuf = Buffer.from(a.resetTokenHash);
    return storedBuf.length === tokenHashBuf.length && timingSafeEqual(storedBuf, tokenHashBuf);
  });

  if (!admin || !admin.resetTokenExpiresAt || new Date(admin.resetTokenExpiresAt).getTime() < Date.now()) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
  }

  admin.passwordHash = bcrypt.hashSync(newPassword, 10);
  admin.resetTokenHash = null;
  admin.resetTokenExpiresAt = null;
  // A legitimate reset just proved account ownership via email - no reason
  // to keep an unrelated login lockout in effect afterwards.
  admin.failedLoginAttempts = 0;
  admin.lockedUntil = null;
  db.save(data);

  res.json({ ok: true });
});

router.post('/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  const data = db.load();
  const admin = data.admins.find(a => a.id === req.session.adminId);
  if (!bcrypt.compareSync(currentPassword || '', admin.passwordHash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  admin.passwordHash = bcrypt.hashSync(newPassword, 10);
  db.save(data);
  res.json({ ok: true });
});

router.post('/change-username', requireAuth, (req, res) => {
  const { currentPassword, newUsername } = req.body;
  const data = db.load();
  const admin = data.admins.find(a => a.id === req.session.adminId);

  // Require the current password before changing the username, same as
  // change-password - otherwise an unattended/hijacked logged-in session
  // could silently take over the account identity without knowing the
  // credentials, which would also let someone lock the real admin out by
  // renaming the account they think they're logging into.
  if (!bcrypt.compareSync(currentPassword || '', admin.passwordHash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const trimmed = String(newUsername || '').trim();
  if (!trimmed) {
    return res.status(400).json({ error: 'New username is required' });
  }
  if (trimmed.length < 3 || trimmed.length > 32) {
    return res.status(400).json({ error: 'Username must be between 3 and 32 characters' });
  }
  // Whitelist characters - a username is later rendered as plain text in
  // the admin UI (safe either way via textContent), but also flows into
  // login lookups, so keep it to a predictable, unambiguous character set.
  if (!/^[a-zA-Z0-9_.-]+$/.test(trimmed)) {
    return res.status(400).json({ error: 'Username can only contain letters, numbers, underscores, dots, and hyphens' });
  }
  // Case-insensitive uniqueness check. Only one admin exists today, but this
  // keeps the check correct if multi-admin support is added later, and
  // stops a same-letters-different-case "change" from silently no-op'ing.
  const clash = data.admins.find(a => a.id !== admin.id && a.username.toLowerCase() === trimmed.toLowerCase());
  if (clash) {
    return res.status(409).json({ error: 'That username is already taken' });
  }

  admin.username = trimmed;
  db.save(data);
  res.json({ ok: true, username: admin.username });
});

router.post('/account/email', requireAuth, (req, res) => {
  const { currentPassword, email } = req.body;
  const data = db.load();
  const admin = data.admins.find(a => a.id === req.session.adminId);

  // Same reasoning as change-password/change-username: require the current
  // password before changing this, since it's the account's recovery
  // mechanism - a hijacked/unattended session shouldn't be able to
  // silently redirect password resets to an attacker-controlled inbox.
  if (!bcrypt.compareSync(currentPassword || '', admin.passwordHash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const trimmed = String(email || '').trim();
  if (trimmed) {
    // Deliberately simple format check, not full RFC 5322 validation -
    // the real proof this address works happens when they click a reset
    // link sent to it, not at save time.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      return res.status(400).json({ error: 'That doesn\'t look like a valid email address' });
    }
    admin.email = trimmed;
  } else {
    admin.email = null; // explicit clear
  }
  db.save(data);
  res.json({ ok: true, email: admin.email });
});

// ---- Telegram notifications (order-approval pings) ----
// Two-step, same reasoning as a linked customer (see db.js
// upsertTelegramUser): a username alone can't be messaged - Telegram's
// Bot API only ever accepts a numeric chat id for a private DM - so this
// is split into "save the handle" (here) and "resolve it to a chat id"
// (POST /telegram/link-account below), which the admin triggers after
// actually messaging the bot at least once.
router.post('/account/telegram', requireAuth, (req, res) => {
  const { currentPassword, telegramUsername } = req.body;
  const data = db.load();
  const admin = data.admins.find(a => a.id === req.session.adminId);

  // Same reasoning as change-password/change-username/account-email: this
  // controls where order-approval notifications go, so an
  // unattended/hijacked session shouldn't be able to silently redirect
  // them without the real admin's password.
  if (!bcrypt.compareSync(currentPassword || '', admin.passwordHash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const trimmed = String(telegramUsername || '').trim().replace(/^@/, '');
  if (trimmed) {
    if (trimmed.length < 5 || trimmed.length > 32 || !/^[a-zA-Z0-9_]+$/.test(trimmed)) {
      return res.status(400).json({ error: 'That doesn\'t look like a valid Telegram username' });
    }
    // Changing the username invalidates any chat id linked to the old one
    // - they're not the same Telegram account until re-linked, and
    // sending to a stale chat id would DM the wrong person.
    if (admin.telegramUsername !== trimmed) admin.telegramChatId = null;
    admin.telegramUsername = trimmed;
  } else {
    admin.telegramUsername = null;
    admin.telegramChatId = null;
  }
  db.save(data);
  res.json({ ok: true, telegramUsername: admin.telegramUsername, telegramLinked: Boolean(admin.telegramChatId) });
});

router.post('/telegram/link-account', requireAuth, async (req, res) => {
  const data = db.load();
  const admin = data.admins.find(a => a.id === req.session.adminId);
  if (!admin.telegramUsername) {
    return res.status(400).json({ error: 'Save your Telegram username first' });
  }

  try {
    const chatId = await findChatIdByUsername(admin.telegramUsername);
    if (!chatId) {
      return res.status(404).json({
        error: `No recent message from @${admin.telegramUsername} found. Open the bot in Telegram, send it any message (e.g. /start), then try again.`
      });
    }
    admin.telegramChatId = chatId;
    db.save(data);
    res.json({ ok: true, telegramLinked: true });
  } catch (err) {
    console.error('[admin] Telegram link-account failed:', err.message);
    res.status(502).json({ error: 'Could not reach Telegram. Check TELEGRAM_BOT_TOKEN is set and try again.' });
  }
});

// everything below requires auth
router.use(requireAuth);

// ---- Dashboard summary ----
router.get('/summary', (req, res) => {
  const data = db.load();
  const totalOrders = data.orders.length;
  const pendingOrders = data.orders.filter(o => o.status === 'pending').length;
  const confirmedOrders = data.orders.filter(o => o.status === 'confirmed').length;
  const revenue = data.orders
    .filter(o => o.status === 'confirmed')
    .reduce((sum, o) => sum + o.total, 0);
  res.json({
    raffleCount: data.raffles.length,
    totalOrders, pendingOrders, confirmedOrders, revenue,
    // "Registered" = every distinct phone number the bot has ever recorded
    // for a Telegram account, i.e. everyone who has shared their phone
    // number with the bot at least once (regardless of whether they went
    // on to place an order).
    telegramRegisteredCount: data.telegramUsers.length
  });
});

// ---- Telegram users who shared their phone number with the bot ----
router.get('/telegram-users', (req, res) => {
  const data = db.load();
  const users = [...data.telegramUsers]
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .map(u => ({
      telegramId: u.telegramId,
      username: u.username || null,
      fullName: u.fullName || '',
      phone: u.phone,
      updatedAt: u.updatedAt,
      banned: Boolean(u.banned),
      bannedAt: u.bannedAt || null,
      bannedReason: u.bannedReason || null
    }));
  res.json({ total: users.length, users });
});

// ---- Ban / unban a Telegram user ----
// Banning blocks that person's linked phone number from creating new
// orders (see isPhoneBanned in db.js, enforced in routes/public.js POST
// /orders). It does not touch any order already placed - existing orders
// still go through their normal awaiting_payment/pending/confirmed flow;
// an admin who wants to also undo a specific order should reject it
// separately from the Orders tab.
router.post('/telegram-users/:telegramId/ban', (req, res) => {
  const data = db.load();
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 300) : '';
  const user = db.banTelegramUser(data, req.params.telegramId, reason);
  if (!user) return res.status(404).json({ error: 'Telegram user not found' });
  db.save(data);
  res.json({ ok: true, user });
});

router.post('/telegram-users/:telegramId/unban', (req, res) => {
  const data = db.load();
  const user = db.unbanTelegramUser(data, req.params.telegramId);
  if (!user) return res.status(404).json({ error: 'Telegram user not found' });
  db.save(data);
  res.json({ ok: true, user });
});

// ---- Announcements (site-wide broadcast, shown under the bell icon) ----
// General-purpose messaging: winner news, warnings, updates - anything the
// admin wants every visitor to see. Always saved to data.announcements so
// it shows in the customer app's notification panel (GET /api/announcements
// in routes/public.js) regardless of Telegram. Optionally ALSO pushed as a
// Telegram DM to every user who has linked their phone, for the subset of
// users who'll actually see a push notification for it rather than having
// to open the app and check the bell.
router.get('/announcements', (req, res) => {
  const data = db.load();
  res.json({ announcements: data.announcements || [] });
});

router.post('/announcements', (req, res) => {
  const { title, message, type, notifyTelegram, winner } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
  const isWinner = type === 'winner';
  // A winner announcement is meaningless without at least a name and a
  // ticket number - everything else in `winner` (phone, lottery, prize) is
  // optional so the admin isn't blocked if e.g. the raffle has no subtitle.
  if (isWinner) {
    if (!winner || !winner.name || !winner.name.trim()) return res.status(400).json({ error: 'Winner name is required' });
    if (!winner.ticket || !String(winner.ticket).trim()) return res.status(400).json({ error: 'Winning ticket number is required' });
  } else if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }

  const data = db.load();
  const announcement = db.createAnnouncement(data, { title, message, type, winner });
  db.save(data);
  res.status(201).json({ announcement });

  // Fire-and-forget, same pattern as notifyCustomer call sites elsewhere in
  // this file: never block the HTTP response on Telegram delivery, and one
  // blocked/broken recipient must not stop the rest from being messaged.
  // Skips banned users deliberately - a warning/update isn't meant to
  // reach someone the admin has already banned.
  if (notifyTelegram) {
    const recipients = (data.telegramUsers || []).filter(u => !u.banned);
    const text = isWinner
      ? `🏆 ${announcement.title}\n\n` +
        `Winner: ${winner.name}${winner.phone ? ` (${winner.phone})` : ''}\n` +
        (winner.lottery ? `Lottery: ${winner.lottery}\n` : '') +
        `Winning ticket: #${winner.ticket}\n` +
        (winner.prize ? `Prize: ${winner.prize}\n` : '') +
        (announcement.message ? `\n${announcement.message}` : '')
      : `${announcement.title}\n\n${announcement.message}`;
    Promise.allSettled(recipients.map(u => sendTelegramMessage(u.telegramId, text)))
      .then(results => {
        const failed = results.filter(r => r.status === 'rejected').length;
        if (failed) console.warn(`[announcements] ${failed}/${recipients.length} Telegram sends failed for announcement ${announcement.id}`);
      });
  }
});

router.delete('/announcements/:id', (req, res) => {
  const data = db.load();
  const removed = db.deleteAnnouncement(data, req.params.id);
  if (!removed) return res.status(404).json({ error: 'Announcement not found' });
  db.save(data);
  res.json({ ok: true });
});

// ---- Raffles CRUD ----
router.get('/raffles', (req, res) => {
  const data = db.load();
  res.json({ raffles: data.raffles.map(r => ({ ...publicRaffle(r), takenNumbers: r.takenNumbers })) });
});

// Upload a car photo -> returns { imageUrl } to plug into raffle create/edit.
// Kept as its own step (rather than bundled into raffle create/edit) so the
// admin form can show a preview immediately and so raffle create/edit can
// stay simple JSON instead of multipart.
router.post('/raffles/photo', handleUpload(uploadCarPhoto.single('photo')), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });
  // Same reasoning as the receipt upload in public.js - the client-declared
  // mimetype fileFilter checked isn't proof of what was actually written to
  // disk, so confirm the real file signature before trusting it.
  verifyUploadedImage(req.file.path, async (verifyErr) => {
    if (verifyErr) return res.status(400).json({ error: verifyErr.message });

    const supabase = getSupabaseClient();
    if (supabase) {
      try {
        const fileBuffer = fs.readFileSync(req.file.path);
        const objectPath = req.file.filename;
        const { error: uploadErr } = await supabase.storage
          .from(CAR_PHOTOS_BUCKET)
          .upload(objectPath, fileBuffer, { contentType: req.file.mimetype, upsert: false });
        fs.unlink(req.file.path, () => {}); // only ever needed locally for the signature check above
        if (uploadErr) {
          console.warn('⚠️  Supabase car photo upload failed:', uploadErr.message);
          return res.status(502).json({ error: 'Could not store the photo. Please try again.' });
        }
        const { data: pub } = supabase.storage.from(CAR_PHOTOS_BUCKET).getPublicUrl(objectPath);
        return res.json({ imageUrl: pub.publicUrl });
      } catch (err) {
        fs.unlink(req.file.path, () => {});
        console.warn('⚠️  Supabase car photo upload failed:', err.message);
        return res.status(502).json({ error: 'Could not store the photo. Please try again.' });
      }
    }

    // No Supabase configured (e.g. local dev) - same local-disk behavior as
    // before. On Render free tier this won't survive a redeploy.
    const imageUrl = `/uploads/cars/${req.file.filename}`;
    res.json({ imageUrl });
  });
});

router.post('/raffles', (req, res) => {
  const { title, subtitle, imageUrl, price, totalNumbers, drawAt, badge, rating, raffleNumber } = req.body;
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  // The admin sets this explicitly (rather than it being auto-counted)
  // because raffles can be deleted/re-ordered and the admin may want the
  // displayed sequence to reflect something other than raw row count -
  // e.g. skipping a cancelled raffle. Required so it's never silently
  // missing from the customer-facing title.
  if (raffleNumber === undefined || raffleNumber === null || raffleNumber === '' || !Number.isInteger(Number(raffleNumber)) || Number(raffleNumber) <= 0) {
    return res.status(400).json({ error: 'raffleNumber must be a positive integer' });
  }
  // Same coercion/validation as PUT /raffles/:id - a truthy check alone
  // (the previous `!price || !totalNumbers`) lets non-numeric strings like
  // "abc" through, which Number() then turns into NaN and silently corrupts
  // every downstream total (order totals, revenue, the number grid).
  const priceNum = Number(price);
  if (price === undefined || price === null || price === '' || !Number.isFinite(priceNum) || priceNum <= 0) {
    return res.status(400).json({ error: 'price must be a positive number' });
  }
  const totalNumbersNum = Number(totalNumbers);
  if (totalNumbers === undefined || totalNumbers === null || totalNumbers === '' || !Number.isInteger(totalNumbersNum) || totalNumbersNum <= 0) {
    return res.status(400).json({ error: 'totalNumbers must be a positive integer' });
  }
  let ratingNum = 5.0;
  if (rating !== undefined && rating !== null && rating !== '') {
    ratingNum = Number(rating);
    if (!Number.isFinite(ratingNum) || ratingNum < 0 || ratingNum > 5) {
      return res.status(400).json({ error: 'rating must be between 0 and 5' });
    }
  }
  const data = db.load();
  const raffle = {
    id: nanoid(8),
    raffleNumber: Number(raffleNumber),
    title, subtitle: subtitle || '', imageUrl: imageUrl || '',
    price: priceNum, totalNumbers: totalNumbersNum,
    rating: ratingNum,
    status: 'active', badge: badge || 'none',
    drawAt: drawAt || new Date(Date.now() + 9 * 24 * 60 * 60 * 1000).toISOString(),
    takenNumbers: [], pending: {},
    createdAt: new Date().toISOString()
  };
  data.raffles.push(raffle);
  db.save(data);
  res.status(201).json({ raffle });
});

router.put('/raffles/:id', (req, res) => {
  const data = db.load();
  const raffle = data.raffles.find(r => r.id === req.params.id);
  if (!raffle) return res.status(404).json({ error: 'Raffle not found' });

  // Numeric fields must actually be coerced/validated here, the same as on
  // create - otherwise a client sending e.g. price as "" or a non-numeric
  // string would silently corrupt raffle.price into NaN, which then breaks
  // every total calculation downstream (order totals, revenue, etc).
  if (req.body.price !== undefined) {
    const price = Number(req.body.price);
    if (!Number.isFinite(price) || price <= 0) return res.status(400).json({ error: 'price must be a positive number' });
    raffle.price = price;
  }
  if (req.body.totalNumbers !== undefined) {
    const totalNumbers = Number(req.body.totalNumbers);
    if (!Number.isInteger(totalNumbers) || totalNumbers <= 0) return res.status(400).json({ error: 'totalNumbers must be a positive integer' });
    // Never let totalNumbers shrink below tickets already sold/reserved -
    // that would silently strand existing buyers' numbers outside the
    // valid range and break number-grid rendering.
    const highestHeld = Math.max(0, ...raffle.takenNumbers, ...Object.keys(raffle.pending || {}).map(Number));
    if (totalNumbers < highestHeld) {
      return res.status(400).json({ error: `totalNumbers can't be less than the highest ticket already sold/reserved (${highestHeld})` });
    }
    raffle.totalNumbers = totalNumbers;
  }
  if (req.body.rating !== undefined) {
    const rating = Number(req.body.rating);
    if (!Number.isFinite(rating) || rating < 0 || rating > 5) return res.status(400).json({ error: 'rating must be between 0 and 5' });
    raffle.rating = rating;
  }
  if (req.body.raffleNumber !== undefined) {
    const raffleNumber = Number(req.body.raffleNumber);
    if (!Number.isInteger(raffleNumber) || raffleNumber <= 0) return res.status(400).json({ error: 'raffleNumber must be a positive integer' });
    raffle.raffleNumber = raffleNumber;
  }
  const passthroughFields = ['title', 'subtitle', 'imageUrl', 'drawAt', 'badge', 'status'];
  for (const f of passthroughFields) {
    if (req.body[f] !== undefined) raffle[f] = req.body[f];
  }
  db.save(data);
  res.json({ raffle });
});

// ---- Admin takes a batch of tickets directly, no order/payment involved ----
// For numbers the admin wants held back for themselves, giveaways, offline
// cash sales, etc. Either give an exact `numbers` list, or a `quantity` and
// let the system pick that many random still-available numbers - the same
// randomAvailableNumbers() used for the public "auto-pick" flow, so there's
// no bias in which numbers come out.
// This creates a normal 'confirmed' order (total: 0, so it never inflates
// revenue) so it plugs into the existing order lifecycle for free - it shows
// up in the Orders tab, and can be released again with the existing
// Unconfirm -> Reject flow if the admin changes their mind.
router.post('/raffles/:id/admin-take', (req, res) => {
  let data = db.load();
  data = db.sweepExpired(data);
  const raffle = data.raffles.find(r => r.id === req.params.id);
  if (!raffle) return res.status(404).json({ error: 'Raffle not found' });

  const { numbers, quantity, note } = req.body || {};
  let selected;

  if (Array.isArray(numbers) && numbers.length) {
    const normalized = numbers.map(n => Number.parseInt(n, 10));
    if (normalized.some(n => !Number.isInteger(n) || n < 1 || n > raffle.totalNumbers)) {
      return res.status(400).json({ error: 'One or more numbers are invalid for this raffle' });
    }
    if (new Set(normalized).size !== normalized.length) {
      return res.status(400).json({ error: 'Duplicate numbers in selection' });
    }
    const conflict = normalized.find(n => numberStatus(raffle, n) !== 'available');
    if (conflict !== undefined) {
      return res.status(409).json({ error: `Number ${conflict} is already taken or pending`, conflict });
    }
    selected = normalized;
  } else {
    const qty = Number.parseInt(quantity, 10);
    if (!Number.isInteger(qty) || qty <= 0) {
      return res.status(400).json({ error: 'Provide either a positive integer quantity, or a numbers array' });
    }
    selected = randomAvailableNumbers(raffle, qty);
    if (selected.length < qty) {
      return res.status(409).json({ error: `Only ${selected.length} numbers are still available, can't take ${qty}` });
    }
  }

  const order = {
    id: nanoid(10),
    raffleId: raffle.id,
    ticketNumbers: selected,
    quantity: selected.length,
    unitPrice: raffle.price,
    total: 0, // admin-taken, not a real sale - kept out of revenue on purpose
    fullName: note ? `Admin: ${note}` : 'Admin Reserved',
    phone: 'ADMIN',
    customerId: null,
    status: 'confirmed',
    bankSelected: null,
    receiptPath: null,
    adminTaken: true,
    createdAt: new Date().toISOString(),
    confirmedAt: new Date().toISOString()
  };

  raffle.takenNumbers = raffle.takenNumbers || [];
  for (const n of selected) {
    if (!raffle.takenNumbers.includes(n)) raffle.takenNumbers.push(n);
  }
  data.orders.push(order);
  db.save(data);
  res.json({ order, raffle: publicRaffle(raffle) });
});

router.delete('/raffles/:id', (req, res) => {
  const data = db.load();
  const idx = data.raffles.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Raffle not found' });
  data.raffles.splice(idx, 1);

  // Cascade delete: an order for a raffle that no longer exists has nothing
  // left to point back to - no car, no numbers, no draw - and previously it
  // just lingered forever as an "Unknown" entry in the buyer's "My Tickets"
  // list. The frontend's confirm dialog already tells the admin this
  // deletes "all its data", so actually do that.
  const orphanedOrders = data.orders.filter(o => o.raffleId === req.params.id);
  data.orders = data.orders.filter(o => o.raffleId !== req.params.id);

  const uploadsRoot = path.join(__dirname, '..', '..', 'uploads');
  for (const order of orphanedOrders) {
    if (!order.receiptPath) continue;
    const filePath = path.join(uploadsRoot, order.receiptPath.replace(/^\/uploads\//, ''));
    // Best-effort cleanup - a missing/already-gone file shouldn't block the
    // raffle deletion itself.
    fs.unlink(filePath, () => {});
  }

  db.save(data);
  res.json({ ok: true, removedOrders: orphanedOrders.length });
});

// ---- Orders queue + approval ----
router.get('/orders', (req, res) => {
  let data = db.load();
  data = db.sweepExpired(data);
  const status = req.query.status;
  let orders = data.orders.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (status) orders = orders.filter(o => o.status === status);
  orders = orders.map(o => {
    const raffle = data.raffles.find(r => r.id === o.raffleId);
    return { ...o, raffleTitle: raffle ? raffle.title : 'Unknown', raffleStatus: raffle ? raffle.status : null };
  });
  res.json({ orders });
});

router.post('/orders/:id/approve', (req, res) => {
  let data = db.load();
  data = db.sweepExpired(data);
  const order = data.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'pending') return res.status(400).json({ error: `Cannot approve order in status ${order.status}` });

  const raffle = data.raffles.find(r => r.id === order.raffleId);
  if (raffle) {
    for (const n of order.ticketNumbers) {
      delete raffle.pending[String(n)];
      if (!raffle.takenNumbers.includes(n)) raffle.takenNumbers.push(n);
    }
  }
  order.status = 'confirmed';
  order.confirmedAt = new Date().toISOString();
  db.save(data);
  res.json({ order });

  // Fire-and-forget: never awaited, and notifyCustomer() itself swallows
  // every failure, so a customer who never linked Telegram (or a Telegram
  // API hiccup) can't turn a successful approval into an error response.
  // See server/telegram.js.
  const ticketWord = order.ticketNumbers.length > 1 ? 'numbers' : 'number';
  notifyCustomer(data, order,
    `Your order for "${raffle ? raffle.title : 'your raffle'}" has been approved.\n\n` +
    `Ticket ${ticketWord}: ${order.ticketNumbers.join(', ')}\n\n` +
    `Good luck!`
  );
});

router.post('/orders/:id/reject', (req, res) => {
  let data = db.load();
  data = db.sweepExpired(data);
  const order = data.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!['pending', 'awaiting_payment'].includes(order.status)) {
    return res.status(400).json({ error: `Cannot reject order in status ${order.status}` });
  }
  const raffle = data.raffles.find(r => r.id === order.raffleId);
  if (raffle) {
    for (const n of order.ticketNumbers) delete raffle.pending[String(n)];
  }
  order.status = 'rejected';
  order.rejectedReason = req.body.reason || null;
  order.rejectedAt = new Date().toISOString();
  db.save(data);
  res.json({ order });

  // See the approve handler above for why this is unawaited and unguarded.
  const reasonLine = order.rejectedReason ? `\n\nReason: ${order.rejectedReason}` : '';
  notifyCustomer(data, order,
    `Your order for "${raffle ? raffle.title : 'your raffle'}" was not approved.${reasonLine}\n\n` +
    `If you think this is a mistake, please get in touch with us.`
  );
});

// ---- Undo a mistaken approval ----
// approve is meant to be a considered, final-ish action (it's what marks
// numbers as actually sold and counts toward revenue), but a misclick is a
// misclick - without this, there was no way back from an accidental
// Approve short of hand-editing Supabase's stored JSON directly. This puts
// the order back where reject already knows how to send it from: pending,
// with its numbers held (not released to the public pool, since the
// order/receipt are still real and still need a decision) rather than
// fully open for someone else to grab.
router.post('/orders/:id/unconfirm', (req, res) => {
  let data = db.load();
  data = db.sweepExpired(data);
  const order = data.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'confirmed') {
    return res.status(400).json({ error: `Cannot unconfirm order in status ${order.status}` });
  }
  const raffle = data.raffles.find(r => r.id === order.raffleId);
  if (raffle) {
    raffle.pending = raffle.pending || {};
    for (const n of order.ticketNumbers) {
      raffle.takenNumbers = raffle.takenNumbers.filter(t => t !== n);
      raffle.pending[String(n)] = { orderId: order.id, reservedUntil: order.reservedUntil || null };
    }
  }
  order.status = 'pending';
  delete order.confirmedAt;
  order.unconfirmedAt = new Date().toISOString();
  db.save(data);
  res.json({ order });
});

// ---- Release admin-taken tickets back to available ----
// admin-take (above) marks numbers taken with no real order/payment behind
// them, so releasing them shouldn't go through the real Unconfirm -> Reject
// two-step meant for actual buyers - one click, straight back to available.
// Only works on batches created via admin-take (order.adminTaken), and only
// while they're still 'confirmed' (that's the only state where the numbers
// are actually held in raffle.takenNumbers). Pass `numbers` to release part
// of a batch; omit it to release the whole thing.
router.post('/orders/:id/admin-release', (req, res) => {
  const data = db.load();
  const order = data.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!order.adminTaken) {
    return res.status(400).json({ error: 'Only admin-taken batches can be released this way - use Unconfirm/Reject for real orders' });
  }
  if (order.status !== 'confirmed') {
    return res.status(400).json({ error: `Cannot release a batch in status ${order.status}` });
  }

  const raffle = data.raffles.find(r => r.id === order.raffleId);
  const { numbers } = req.body || {};
  let toRelease = order.ticketNumbers;
  if (Array.isArray(numbers) && numbers.length) {
    const normalized = numbers.map(n => Number.parseInt(n, 10));
    const invalid = normalized.find(n => !order.ticketNumbers.includes(n));
    if (invalid !== undefined) {
      return res.status(400).json({ error: `Number ${invalid} isn't part of this batch` });
    }
    toRelease = normalized;
  }

  if (raffle) {
    raffle.takenNumbers = raffle.takenNumbers.filter(n => !toRelease.includes(n));
  }
  const remaining = order.ticketNumbers.filter(n => !toRelease.includes(n));
  if (remaining.length) {
    // Partial release - batch is still 'confirmed', just smaller now.
    order.ticketNumbers = remaining;
    order.quantity = remaining.length;
  } else {
    order.status = 'released';
    order.releasedAt = new Date().toISOString();
  }
  db.save(data);
  res.json({ order, released: toRelease, raffle: raffle ? publicRaffle(raffle) : null });
});

// ---- Delete an order record ----
// Deliberately restrictive about *when* this is allowed, because unlike
// reject/unconfirm this can't be undone - there's no db.json history to
// recover a deleted row from. Allowed only when the order can't represent
// a live, reversible decision anymore:
//   - already rejected/expired: no money or held number attached, so
//     deleting it can't desync anything - it was already functionally gone.
//   - its raffle has ended: even a 'confirmed' order here is done growing -
//     the raffle it belongs to is over, nothing will re-sell that number,
//     and you (the admin) are the one deciding you no longer need that
//     record kept around. Ended-raffle orders are excluded from this
//     safety net on purpose, at the admin's request, to allow cleaning up
//     old raffles entirely - just be aware this also erases your own
//     revenue/sales history for that raffle if you delete a confirmed one.
router.delete('/orders/:id', (req, res) => {
  const data = db.load();
  const order = data.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const raffle = data.raffles.find(r => r.id === order.raffleId);
  const raffleEnded = raffle ? raffle.status === 'ended' : false;
  const orderInactive = ['rejected', 'expired', 'released'].includes(order.status);
  if (!orderInactive && !raffleEnded) {
    return res.status(400).json({
      error: `Cannot delete an order in status "${order.status}" unless its raffle has ended. Reject or unconfirm it first.`
    });
  }

  if (raffle && raffle.pending) {
    for (const n of order.ticketNumbers) {
      const p = raffle.pending[String(n)];
      if (p && p.orderId === order.id) delete raffle.pending[String(n)];
    }
  }
  data.orders = data.orders.filter(o => o.id !== order.id);
  db.save(data);
  res.json({ ok: true });
});

// ---- Banks ----
router.get('/banks', (req, res) => {
  const data = db.load();
  res.json({ banks: data.banks });
});

router.post('/banks', (req, res) => {
  const { name, holder, account } = req.body;
  if (!name || !account) return res.status(400).json({ error: 'name and account are required' });
  const data = db.load();
  const bank = { id: nanoid(6), name, holder: holder || '', account };
  data.banks.push(bank);
  db.save(data);
  res.status(201).json({ bank });
});

router.delete('/banks/:id', (req, res) => {
  const data = db.load();
  const idx = data.banks.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Bank not found' });
  data.banks.splice(idx, 1);
  db.save(data);
  res.json({ ok: true });
});

// ---- Winner draw (pick random confirmed ticket) ----
router.post('/raffles/:id/draw', (req, res) => {
  const data = db.load();
  const raffle = data.raffles.find(r => r.id === req.params.id);
  if (!raffle) return res.status(404).json({ error: 'Raffle not found' });
  const confirmedOrders = data.orders.filter(o => o.raffleId === raffle.id && o.status === 'confirmed');
  const pool = [];
  confirmedOrders.forEach(o => o.ticketNumbers.forEach(n => pool.push({ number: n, order: o })));
  if (pool.length === 0) return res.status(400).json({ error: 'No confirmed tickets to draw from' });
  // crypto.randomInt, not Math.random() - this is the actual "who wins the
  // car" moment, so it should be a CSPRNG rather than a non-cryptographic
  // PRNG that (in principle) someone could try to argue was predictable.
  const winner = pool[randomInt(0, pool.length)];
  raffle.winner = { number: winner.number, orderId: winner.order.id, fullName: winner.order.fullName, phone: winner.order.phone, drawnAt: new Date().toISOString() };
  raffle.status = 'ended';

  // Auto-draws feed into the same Announcements list a manually-typed
  // winner card would (see POST /announcements above) - this is the ONLY
  // on-site place a winner is shown now; there's no separate "Latest
  // Winners" list anymore. Uses maskWinnerName/no-phone by default since
  // this fires without any admin review, unlike a manual winner
  // announcement where the admin explicitly typed (and can choose to
  // publish) real contact details.
  db.createAnnouncement(data, {
    title: `Winner drawn: ${raffle.title}`,
    type: 'winner',
    winner: {
      name: maskWinnerName(winner.order.fullName),
      phone: '',
      lottery: raffle.title,
      ticket: String(winner.number),
      prize: raffle.subtitle || ''
    }
  });

  db.save(data);
  res.json({ winner: raffle.winner });

  // See the approve handler above for why this is unawaited and unguarded.
  notifyCustomer(data, winner.order,
    `🏆 Congratulations! You won the raffle!\n\n` +
    `Lottery: ${raffle.title}\n` +
    `Winning ticket: #${winner.number}\n` +
    (raffle.subtitle ? `Prize: ${raffle.subtitle}\n` : '') +
    `Phone on file: ${winner.order.phone}\n\n` +
    `Our team will be in touch with next steps.`
  );
});

module.exports = router;
