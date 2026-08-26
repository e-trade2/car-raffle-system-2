const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { randomInt } = require('crypto');
const { nanoid } = require('nanoid');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

// Empty folders don't survive zip/git, so `data/` may not exist on a fresh
// checkout even though it's in the repo layout. Create it up front, same as
// uploads/ already does in index.js and routes/public.js.
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// A hardcoded default password (e.g. "admin123") checked into source is a
// standing risk the moment this ever runs somewhere reachable - anyone who
// has seen this repo (or guesses it, since it's a common default) can log
// in before the admin ever changes it. Generating a random one per install
// and printing it once removes that window entirely. Excludes visually
// ambiguous characters (0/O, 1/l/I) since this has to be read off a
// terminal and retyped.
const INITIAL_PASSWORD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
function generateInitialPassword(length = 14) {
  let pw = '';
  for (let i = 0; i < length; i++) pw += INITIAL_PASSWORD_CHARS[randomInt(INITIAL_PASSWORD_CHARS.length)];
  return pw;
}

function defaultData() {
  // On hosts with an ephemeral filesystem (e.g. Render's free tier), the
  // entire data/ directory - including this file - gets wiped on every
  // restart, redeploy, or spin-down/spin-up. Without an override, that means
  // defaultData() runs again on every restart and hands out a *new* random
  // password each time, even though nothing about the login actually
  // changed from the operator's point of view. Setting ADMIN_USERNAME /
  // ADMIN_PASSWORD makes the login stable across restarts by deriving it
  // from an env var instead of randomness. This does NOT fix data loss for
  // raffles/orders/customers - only persistent storage (a mounted disk or
  // an external DB) fixes that; this only keeps the admin login usable.
  const envUsername = process.env.ADMIN_USERNAME?.trim();
  const envPassword = process.env.ADMIN_PASSWORD;
  const usingEnvCreds = Boolean(envUsername && envPassword);

  // Only ever generated once, right here, the first time the app runs with
  // no data/db.json yet - printed to the console since this is the only
  // moment the plaintext exists (only the bcrypt hash gets persisted).
  // Lost it? Use `node server/reset-admin.js <username> <password>` instead
  // of deleting db.json, which would also wipe every raffle/order on file.
  const initialPassword = usingEnvCreds ? envPassword : generateInitialPassword();

  if (usingEnvCreds) {
    console.log('\n🔑 Admin login set from ADMIN_USERNAME / ADMIN_PASSWORD env vars:');
    console.log(`   Username: ${envUsername}`);
    console.log('   Password: (as set in the environment)');
    console.log('   This stays the same across restarts as long as those env vars are set.\n');
  } else {
    console.log('\n🔑 First run detected - generated an admin login:');
    console.log(`   Username: admin`);
    console.log(`   Password: ${initialPassword}`);
    console.log('   This will not be shown again. Save it now, then change it from Admin -> Settings.');
    console.log('   Note: on hosts with an ephemeral filesystem (e.g. Render free tier), this');
    console.log('   password will regenerate on every restart unless you set ADMIN_USERNAME and');
    console.log('   ADMIN_PASSWORD as environment variables instead.\n');
  }

  return {
    admins: [
      {
        id: nanoid(8),
        username: usingEnvCreds ? envUsername : 'admin',
        passwordHash: bcrypt.hashSync(initialPassword, 10),
        // Recovery email for the "forgot password" flow (server/routes/admin.js
        // POST /forgot-password). Null until the admin sets one from
        // Settings - without it, the only recovery path is the
        // reset-admin.js server script.
        email: null,
        // Set only while a reset email is outstanding. Holds a SHA-256
        // hash of the token, never the raw token, same reasoning as
        // passwordHash: if db.json ever leaked, a stored raw token would
        // be directly usable to take over the account.
        resetTokenHash: null,
        resetTokenExpiresAt: null,
        // Telegram DM target for order-notification pushes (see
        // notifyAdmin in server/telegram.js). telegramUsername is what the
        // admin types into Settings (their @handle, without the @).
        // telegramChatId is resolved separately via POST
        // /api/admin/telegram/link-account, which matches that username
        // against whoever has recently messaged the bot - Telegram's Bot
        // API can only ever send to a numeric chat id, never a username
        // directly, so the username alone isn't enough to message them.
        telegramUsername: null,
        telegramChatId: null,
        failedLoginAttempts: 0,
        lockedUntil: null,
        createdAt: new Date().toISOString()
      }
    ],
    raffles: [
      {
        id: nanoid(8),
        title: 'BYD Yuan UP',
        subtitle: 'Time Grey',
        imageUrl: '',
        price: 3000,
        totalNumbers: 3500,
        rating: 5.0,
        status: 'active', // active | ended
        badge: 'new', // new | hot | none
        drawAt: new Date(Date.now() + 9 * 24 * 60 * 60 * 1000).toISOString(),
        takenNumbers: [],
        pending: {}, // { "348": { orderId, reservedUntil } }
        createdAt: new Date().toISOString()
      }
    ],
    orders: [],
    // One record per phone number, created the first time that phone is
    // used on an order. The `id` is a second factor a ticket-lookup caller
    // must present alongside the phone number - see getOrCreateCustomer()
    // and GET /tickets in routes/public.js.
    customers: [],
    // Links a Telegram account to the phone number it shared with the bot.
    // Populated by the bot (POST /api/telegram/link) right after someone
    // taps "share phone". Read back by the mini app (POST
    // /api/telegram/prefill) to fill in name/phone automatically instead of
    // asking the user to retype what they already gave the bot.
    telegramUsers: [],
    // Site-wide broadcast messages the admin can post from Admin ->
    // Announcements - anything from "we have a winner" to a warning or a
    // general update. Shown to every visitor under the bell icon on the
    // customer app (see GET /api/announcements in routes/public.js), and
    // optionally also pushed as a Telegram DM to every linked user at
    // creation time (see POST /api/admin/announcements). Kept as its own
    // list rather than folded into raffles/orders since an announcement
    // isn't tied to any one raffle or order.
    announcements: [],
    banks: [
      { id: nanoid(6), name: 'Telebirr', holder: 'Getachew', account: '0924242419' },
      { id: nanoid(6), name: 'Commercial Bank of Ethiopia', holder: 'Getachew Fikadu Jirata', account: '1000528139489' }
    ]
  };
}

function load() {
  if (!fs.existsSync(DATA_FILE)) {
    save(defaultData());
  }
  const raw = fs.readFileSync(DATA_FILE, 'utf-8');
  const data = JSON.parse(raw);

  // Back-compat for db.json files written before `customers` existed:
  // without this, every phone number from before the upgrade would have
  // no customer id and could never pass the GET /tickets check below.
  if (!Array.isArray(data.customers)) data.customers = [];
  if (!Array.isArray(data.telegramUsers)) data.telegramUsers = [];
  if (!Array.isArray(data.announcements)) data.announcements = [];
  // Back-compat for telegramUsers records written before banning existed.
  for (const u of data.telegramUsers) {
    if (u.banned === undefined) u.banned = false;
    if (u.bannedAt === undefined) u.bannedAt = null;
    if (u.bannedReason === undefined) u.bannedReason = null;
  }
  for (const admin of data.admins || []) {
    if (admin.email === undefined) admin.email = null;
    if (admin.resetTokenHash === undefined) admin.resetTokenHash = null;
    if (admin.resetTokenExpiresAt === undefined) admin.resetTokenExpiresAt = null;
    if (admin.telegramUsername === undefined) admin.telegramUsername = null;
    if (admin.telegramChatId === undefined) admin.telegramChatId = null;
  }
  let migrated = false;
  for (const order of data.orders) {
    if (!order.phone) continue;
    const customer = getOrCreateCustomer(data, order.phone);
    if (order.customerId !== customer.id) {
      order.customerId = customer.id;
      migrated = true;
    }
  }
  if (migrated) save(data);

  return data;
}

// Looks up the customer record for a phone number, creating one (with a
// fresh id) the first time that phone is seen. The id is meant to travel
// back to the buyer once, at order-creation time, and be re-entered
// alongside the phone number to authorize a ticket lookup - a phone number
// alone is guessable/knowable by other people, so it can't be trusted as
// the sole key for handing back someone's order history and receipts.
function getOrCreateCustomer(data, phone) {
  let customer = data.customers.find(c => c.phone === phone);
  if (!customer) {
    customer = { id: nanoid(8).toUpperCase(), phone, createdAt: new Date().toISOString() };
    data.customers.push(customer);
  }
  return customer;
}

// Records/updates which phone+name a Telegram account shared with the bot.
// telegramId is Telegram's numeric user id (sent as a string/number from
// the bot) - not secret, but only the bot server should ever be able to
// call this, since it's writing a phone number under someone's control.
// That's enforced by the internal-key check in the route handler, not here.
function upsertTelegramUser(data, telegramId, phone, fullName, username, language) {
  const id = String(telegramId);
  let user = data.telegramUsers.find(u => u.telegramId === id);
  if (user) {
    user.phone = phone;
    user.fullName = fullName;
    // Telegram usernames are optional (not every account has one) and can
    // change, so only overwrite when a new value is actually provided -
    // otherwise a re-share without a username would blank out one we
    // already had on file.
    if (username) user.username = username;
    // Same idea for language: only overwrite when the bot actually sent
    // one, so an older bot deploy (pre-language-passthrough) re-linking
    // this user doesn't blank out a language we already had on file.
    if (language) user.language = language;
    user.updatedAt = new Date().toISOString();
  } else {
    user = {
      telegramId: id, phone, fullName, username: username || null,
      language: language || null,
      banned: false, bannedAt: null, bannedReason: null,
      updatedAt: new Date().toISOString()
    };
    data.telegramUsers.push(user);
  }
  return user;
}

function findTelegramUser(data, telegramId) {
  return data.telegramUsers.find(u => u.telegramId === String(telegramId)) || null;
}

// ---- Banning ----
// A ban lives on the telegramUsers record (keyed by telegramId, the stable
// identity) rather than on the phone/customer record, since a phone number
// can be reused/reassigned but a Telegram account can't. isPhoneBanned is
// what actually gates order creation (routes/public.js POST /orders),
// since that endpoint only ever sees a phone number, not a telegramId -
// it works because upsertTelegramUser links exactly one phone per
// telegramId, and a re-share from a banned account intentionally does NOT
// clear the ban (see upsertTelegramUser above).
function banTelegramUser(data, telegramId, reason) {
  const user = findTelegramUser(data, telegramId);
  if (!user) return null;
  user.banned = true;
  user.bannedAt = new Date().toISOString();
  user.bannedReason = (reason || '').trim() || null;
  return user;
}

function unbanTelegramUser(data, telegramId) {
  const user = findTelegramUser(data, telegramId);
  if (!user) return null;
  user.banned = false;
  user.bannedAt = null;
  user.bannedReason = null;
  return user;
}

function isPhoneBanned(data, phone) {
  return data.telegramUsers.some(u => u.phone === phone && u.banned);
}

// ---- Announcements (on-site broadcast, shown under the bell icon) ----
// type is a display hint for the customer app (which icon/color/layout to
// use). 'winner' announcements carry extra structured fields (name, phone,
// lottery, ticket, prize) so the admin can hand-type a rich winner card -
// same visual format as the automatic one from POST /raffles/:id/draw -
// without that card being tied to an actual raffle draw. Those fields are
// simply ignored/omitted for 'update' and 'warning' types.
function createAnnouncement(data, { title, message, type, winner }) {
  const isWinner = type === 'winner';
  const announcement = {
    id: nanoid(8),
    title: (title || '').trim(),
    message: (message || '').trim(),
    type: ['winner', 'warning', 'update'].includes(type) ? type : 'update',
    createdAt: new Date().toISOString(),
    ...(isWinner && winner ? {
      winner: {
        name: (winner.name || '').trim(),
        phone: (winner.phone || '').trim(),
        lottery: (winner.lottery || '').trim(),
        ticket: (winner.ticket || '').trim(),
        prize: (winner.prize || '').trim()
      }
    } : {})
  };
  data.announcements.unshift(announcement); // newest first
  return announcement;
}

function deleteAnnouncement(data, id) {
  const idx = data.announcements.findIndex(a => a.id === id);
  if (idx === -1) return false;
  data.announcements.splice(idx, 1);
  return true;
}

function save(data) {
  // Node is single-threaded and writeFileSync is synchronous, so this is
  // safe against concurrent corruption for this app's request volume.
  const tmpFile = DATA_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, DATA_FILE);

  // Local file is already correct at this point - this is a best-effort
  // mirror to Supabase so the data survives a restart on hosts with an
  // ephemeral filesystem. No-op if Supabase isn't configured; never blocks
  // or throws, see supabase-sync.js.
  require('./supabase-sync').pushToSupabaseInBackground(data);

  return data;
}

// Sweep expired reservations back to available.
//
// Iterates orders (the source of truth for status), not raffle.pending -
// a raffle.pending entry can already be gone (deleted by a previous, buggy
// sweep run, or never written due to a crash) while the order itself is
// still incorrectly sitting in 'awaiting_payment'. Driving this off orders
// means any such already-broken order gets self-healed the next time this
// runs, instead of staying stuck forever just because its pending-map
// breadcrumb disappeared.
//
// Only 'awaiting_payment' orders are time-limited. Once a receipt is
// uploaded (status -> 'pending'), the buyer has already acted and is just
// waiting on the admin - time alone must never expire that out from under
// them; only an explicit admin reject should. Applying the same 30-minute
// clock to 'pending' orders was a real bug: a slow admin review could
// silently expire an order the buyer had already paid for.
function sweepExpired(data) {
  const now = Date.now();
  let changed = false;
  for (const order of data.orders) {
    if (order.status !== 'awaiting_payment') continue;
    if (!order.reservedUntil || new Date(order.reservedUntil).getTime() >= now) continue;

    order.status = 'expired';
    changed = true;

    const raffle = data.raffles.find(r => r.id === order.raffleId);
    if (raffle && raffle.pending) {
      for (const n of order.ticketNumbers) {
        const p = raffle.pending[String(n)];
        // Only clear the slot if it still points at *this* expired order -
        // a later order may have legitimately re-reserved the same number
        // after this one lapsed, and that must not be stolen back.
        if (p && p.orderId === order.id) delete raffle.pending[String(n)];
      }
    }
  }
  if (changed) save(data);
  return data;
}

module.exports = {
  load, save, sweepExpired, defaultData, getOrCreateCustomer,
  upsertTelegramUser, findTelegramUser,
  banTelegramUser, unbanTelegramUser, isPhoneBanned,
  createAnnouncement, deleteAnnouncement,
  DATA_FILE
};
