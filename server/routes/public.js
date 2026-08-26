const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { nanoid } = require('nanoid');
const db = require('../db');
const { publicRaffle, numberStatus, randomAvailableNumbers, verifyUploadedImage, handleUpload, verifyTelegramInitData } = require('../utils');
const { reportLockout } = require('../alerts');
const { notifyAdmin } = require('../telegram');
const { getClient: getSupabaseClient } = require('../supabase-sync');

const router = express.Router();

// ---- Receipt storage ----
// Receipts used to live only on local disk (uploadsDir below), which is
// wiped on every redeploy/restart on hosts with an ephemeral filesystem
// (e.g. Render's free tier) - order *data* survived restarts fine via
// supabase-sync.js, but the receipt image files themselves quietly
// vanished, leaving "View" broken for any order placed before the last
// redeploy. Uploading to a Supabase Storage bucket instead makes receipts
// as durable as the rest of the app's data. The bucket is private - it's
// not meant to be reachable by a bare URL, only through the admin-gated
// GET /orders/:id/receipt route below, same access model as before.
const RECEIPT_BUCKET = 'receipts';
let bucketEnsured = false;
async function ensureReceiptBucket() {
  if (bucketEnsured) return;
  const supabase = getSupabaseClient();
  if (!supabase) return;
  try {
    const { error } = await supabase.storage.createBucket(RECEIPT_BUCKET, { public: false });
    // "already exists" isn't a real failure - just means a previous boot
    // (or manual dashboard setup) already created it.
    if (error && !/already exists/i.test(error.message || '')) {
      console.warn('⚠️  Could not create Supabase receipts bucket:', error.message);
    }
  } catch (err) {
    console.warn('⚠️  Could not create Supabase receipts bucket:', err.message);
  } finally {
    bucketEnsured = true; // don't retry every request even if it failed
  }
}
ensureReceiptBucket();

const uploadsDir = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    // Only trust a short whitelist of characters in the extension - a raw
    // client-supplied filename (e.g. crafted via curl, not a real browser
    // file picker) can otherwise smuggle quotes/angle-brackets onto disk.
    const rawExt = path.extname(file.originalname).toLowerCase();
    const ext = /^\.(jpg|jpeg|png|gif|webp|heic|heif)$/.test(rawExt) ? rawExt : '.jpg';
    cb(null, `${Date.now()}_${nanoid(6)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed for receipts'));
  }
});

// ---- Abuse throttling ----
// Order creation reserves numbers for RESERVE_MINUTES with no payment yet -
// with no limit, one script looping this endpoint could hold the entire
// pool "reserved" indefinitely (renewing before each reservation expires)
// and make a live raffle look sold out to real buyers. Same sliding-window
// shape as the admin login limiter in routes/admin.js, just scoped to a
// different key per limiter instance.
function makeIpRateLimiter(windowMs, maxAttempts) {
  const attemptsByIp = new Map();
  return function isRateLimited(ip) {
    const now = Date.now();
    const entry = attemptsByIp.get(ip);
    if (!entry || now - entry.windowStart > windowMs) {
      attemptsByIp.set(ip, { count: 1, windowStart: now });
      return false;
    }
    entry.count += 1;
    return entry.count > maxAttempts;
  };
}

const ORDER_CREATE_WINDOW_MS = 15 * 60 * 1000;
const ORDER_CREATE_MAX_ATTEMPTS = 10; // ~1 every 90s sustained - generous for a real buyer, tight for a scripted loop
const isOrderCreateRateLimited = makeIpRateLimiter(ORDER_CREATE_WINDOW_MS, ORDER_CREATE_MAX_ATTEMPTS);

const PAYMENT_UPLOAD_WINDOW_MS = 15 * 60 * 1000;
const PAYMENT_UPLOAD_MAX_ATTEMPTS = 15; // a bit looser - legit users may retry a failed upload
const isPaymentUploadRateLimited = makeIpRateLimiter(PAYMENT_UPLOAD_WINDOW_MS, PAYMENT_UPLOAD_MAX_ATTEMPTS);

// GET /tickets takes an arbitrary phone number and, with no auth, returns
// every order for it - full name, ticket numbers, order total, and a link
// to the uploaded payment receipt image. Unlike the write endpoints above,
// this had no throttle at all, so it was the one place in this file where
// a script could sit in a loop trying phone numbers and scrape other
// buyers' order/receipt data. Same sliding-window shape as the others,
// just looser since a real buyer may legitimately re-check their tickets
// several times in a session (e.g. after each of several purchases).
const TICKETS_LOOKUP_WINDOW_MS = 15 * 60 * 1000;
const TICKETS_LOOKUP_MAX_ATTEMPTS = 20;
const isTicketsLookupRateLimited = ()=> false; // disabled per request - was makeIpRateLimiter(TICKETS_LOOKUP_WINDOW_MS, TICKETS_LOOKUP_MAX_ATTEMPTS)

// Keyed on the phone number itself rather than the requesting IP - the
// per-IP limiter above doesn't catch someone spreading requests for one
// specific target phone number across many IPs (cheap to do with rotating
// proxies). This doesn't stop enumeration that spreads *both* across many
// phone numbers *and* many IPs at a low rate per pair - nothing short of
// verifying the requester actually owns the phone number (e.g. an SMS OTP
// step) closes that gap. Tighter than the per-IP limit since a real buyer
// re-checking their own tickets a handful of times a session is normal;
// two dozen lookups for the same number in 15 minutes is not.
const TICKETS_LOOKUP_PHONE_WINDOW_MS = 15 * 60 * 1000;
const TICKETS_LOOKUP_PHONE_MAX_ATTEMPTS = 8;
const isTicketsLookupPhoneRateLimited = ()=> false; // disabled per request - was makeIpRateLimiter(TICKETS_LOOKUP_PHONE_WINDOW_MS, TICKETS_LOOKUP_PHONE_MAX_ATTEMPTS)

// Admin re-opens receipts repeatedly while working through the orders
// queue, so this is looser than the lookup limiters above - it's here as
// cheap insurance (e.g. against a leaked/stolen admin session cookie being
// used to script through every receipt on file), not as the primary
// control, since the route below already requires an admin session.
const RECEIPT_VIEW_WINDOW_MS = 15 * 60 * 1000;
const RECEIPT_VIEW_MAX_ATTEMPTS = 60;
const isReceiptViewRateLimited = makeIpRateLimiter(RECEIPT_VIEW_WINDOW_MS, RECEIPT_VIEW_MAX_ATTEMPTS);

const RESERVE_MINUTES = 30;

// ---- List raffles ----
router.get('/raffles', (req, res) => {
  let data = db.load();
  data = db.sweepExpired(data);
  const list = data.raffles.map(publicRaffle);
  res.json({ raffles: list });
});

// ---- Raffle detail ----
router.get('/raffles/:id', (req, res) => {
  let data = db.load();
  data = db.sweepExpired(data);
  const raffle = data.raffles.find(r => r.id === req.params.id);
  if (!raffle) return res.status(404).json({ error: 'Raffle not found' });
  res.json({ raffle: publicRaffle(raffle) });
});

// ---- Numbers grid for a raffle (status per number) ----
router.get('/raffles/:id/numbers', (req, res) => {
  let data = db.load();
  data = db.sweepExpired(data);
  const raffle = data.raffles.find(r => r.id === req.params.id);
  if (!raffle) return res.status(404).json({ error: 'Raffle not found' });

  // Specific-numbers lookup (e.g. "is number 348 still mine, still taken,
  // or free again?") - used by the ticket history view for expired/rejected
  // orders, so it doesn't have to pull a whole page range just to check a
  // handful of scattered numbers.
  if (req.query.nums) {
    const requested = String(req.query.nums)
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => Number.isInteger(n) && n >= 1 && n <= raffle.totalNumbers);
    const numbers = requested.map(n => ({ n, status: numberStatus(raffle, n) }));
    return res.json({ numbers, totalNumbers: raffle.totalNumbers });
  }

  const start = Math.max(1, parseInt(req.query.start) || 1);
  const end = Math.min(raffle.totalNumbers, parseInt(req.query.end) || Math.min(raffle.totalNumbers, start + 199));

  const numbers = [];
  for (let n = start; n <= end; n++) {
    numbers.push({ n, status: numberStatus(raffle, n) });
  }
  res.json({ numbers, totalNumbers: raffle.totalNumbers });
});

// ---- Step 1: create order (reserve numbers, pending payment) ----
router.post('/orders', (req, res) => {
  if (isOrderCreateRateLimited(req.ip)) {
    reportLockout(`order-create-ip:${req.ip}`, `IP ${req.ip} exceeded ${ORDER_CREATE_MAX_ATTEMPTS} order-creation attempts in ${ORDER_CREATE_WINDOW_MS / 60000} minutes - possible ticket-hoarding/inventory-exhaustion abuse.`);
    return res.status(429).json({ error: 'Too many order attempts from this network. Please wait a bit and try again.' });
  }
  const { raffleId, quantity, numbers, fullName, phone, mode } = req.body;
  if (!raffleId || !fullName || !phone) {
    return res.status(400).json({ error: 'raffleId, fullName and phone are required' });
  }
  let data = db.load();
  data = db.sweepExpired(data);
  const raffle = data.raffles.find(r => r.id === raffleId);
  if (!raffle) return res.status(404).json({ error: 'Raffle not found' });
  if (raffle.status !== 'active') return res.status(400).json({ error: 'This raffle is not active' });

  // A banned Telegram account is blocked from creating new orders via its
  // linked phone number. Checked here rather than only in the bot, since
  // this endpoint is the one place that actually holds/sells numbers -
  // phone is client-supplied and unauthenticated at this point, but that's
  // fine: the check exists to stop the *specific* phone an admin banned,
  // not to prove identity.
  if (db.isPhoneBanned(data, phone)) {
    reportLockout(`banned-order-attempt:${phone}`, `Banned phone ${phone} attempted to create an order from IP ${req.ip}.`);
    return res.status(403).json({ error: 'This phone number is banned from placing orders. Contact support if you believe this is a mistake.' });
  }

  let qty = parseInt(quantity) || (Array.isArray(numbers) ? numbers.length : 1);
  qty = Math.max(1, Math.min(qty, 20));

  let selected;
  if (mode === 'manual') {
    if (!Array.isArray(numbers) || numbers.length !== qty) {
      return res.status(400).json({ error: 'Selected numbers must match the quantity' });
    }
    // Coerce to real integers before any validation. numberStatus() compares
    // against takenNumbers with strict equality, so a raw API call passing
    // numbers as strings (e.g. ["348"]) would otherwise silently skip the
    // "already taken" check - .includes("348") never matches a stored 348.
    const normalized = numbers.map(n => Number.parseInt(n, 10));
    if (normalized.some(n => !Number.isInteger(n) || n < 1 || n > raffle.totalNumbers)) {
      return res.status(400).json({ error: 'Selected numbers are invalid' });
    }
    if (new Set(normalized).size !== normalized.length) {
      return res.status(400).json({ error: 'Duplicate numbers in selection' });
    }
    for (const n of normalized) {
      if (numberStatus(raffle, n) !== 'available') {
        return res.status(409).json({ error: `Number ${n} is no longer available`, conflict: n });
      }
    }
    selected = normalized;
  } else if (mode === 'mixed') {
    // Buyer picked some numbers manually, then hit Quick Pick to fill the
    // rest at random - e.g. picked 3 of their own, let Quick Pick assign
    // the other 7. `numbers` here is the partial manual selection (can be
    // empty), validated the same way as a full manual pick.
    const manualNums = Array.isArray(numbers) ? numbers.map(n => Number.parseInt(n, 10)) : [];
    if (manualNums.some(n => !Number.isInteger(n) || n < 1 || n > raffle.totalNumbers)) {
      return res.status(400).json({ error: 'Selected numbers are invalid' });
    }
    if (new Set(manualNums).size !== manualNums.length) {
      return res.status(400).json({ error: 'Duplicate numbers in selection' });
    }
    if (manualNums.length > qty) {
      return res.status(400).json({ error: 'Selected numbers exceed quantity' });
    }
    for (const n of manualNums) {
      if (numberStatus(raffle, n) !== 'available') {
        return res.status(409).json({ error: `Number ${n} is no longer available`, conflict: n });
      }
    }
    const remaining = qty - manualNums.length;
    const extra = remaining > 0 ? randomAvailableNumbers(raffle, remaining, manualNums) : [];
    if (extra.length < remaining) {
      return res.status(409).json({ error: 'Not enough tickets remaining' });
    }
    selected = [...manualNums, ...extra];
  } else {
    selected = randomAvailableNumbers(raffle, qty);
    if (selected.length < qty) {
      return res.status(409).json({ error: 'Not enough tickets remaining' });
    }
  }

  // Same customer id every time this phone number orders again - it's
  // issued once per phone, not once per order, so a repeat buyer's old id
  // still works after a later purchase.
  const customer = db.getOrCreateCustomer(data, phone);

  const order = {
    id: nanoid(10),
    raffleId,
    ticketNumbers: selected,
    quantity: qty,
    unitPrice: raffle.price,
    total: raffle.price * qty,
    fullName,
    phone,
    customerId: customer.id,
    status: 'awaiting_payment', // awaiting_payment -> pending (receipt uploaded) -> confirmed / rejected / expired
    bankSelected: null,
    receiptPath: null,
    createdAt: new Date().toISOString(),
    reservedUntil: new Date(Date.now() + RESERVE_MINUTES * 60 * 1000).toISOString()
  };

  raffle.pending = raffle.pending || {};
  for (const n of selected) {
    raffle.pending[String(n)] = { orderId: order.id, reservedUntil: order.reservedUntil };
  }
  data.orders.push(order);
  db.save(data);

  res.status(201).json({ order, banks: data.banks, reserveMinutes: RESERVE_MINUTES });
});

// ---- Buyer cancels their own not-yet-paid order ----
// Called by the frontend when the buyer backs out of checkout (Back button
// on step 2, or closing the modal) after step 1 already reserved numbers
// on the server. Without this, going Back and resubmitting the same
// numbers would fail with "no longer available" for a full
// RESERVE_MINUTES window - not because someone else took them, but
// because the buyer's own abandoned order was still holding them.
// Deliberately narrow, same reasoning as DELETE /orders/:id below: only
// 'awaiting_payment' orders qualify (nothing paid/uploaded yet, so
// there's nothing real to lose), and phone must match so this can't be
// used to cancel a stranger's in-progress order.
router.post('/orders/:id/cancel', (req, res) => {
  const phone = (req.body.phone || '').trim();
  if (!phone) return res.status(400).json({ error: 'phone is required' });

  const data = db.load();
  const order = data.orders.find(o => o.id === req.params.id);
  if (!order || order.phone !== phone) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'awaiting_payment') {
    // Already paid/reviewed/expired - nothing for this route to do. Not an
    // error: the frontend calls this defensively and shouldn't have to
    // know the order's exact state first.
    return res.json({ ok: true });
  }

  const raffle = data.raffles.find(r => r.id === order.raffleId);
  if (raffle && raffle.pending) {
    for (const n of order.ticketNumbers) {
      const p = raffle.pending[String(n)];
      // Only clear the slot if it still points at *this* order - mirrors
      // sweepExpired's same guard in db.js.
      if (p && p.orderId === order.id) delete raffle.pending[String(n)];
    }
  }
  data.orders = data.orders.filter(o => o.id !== order.id);
  db.save(data);
  res.json({ ok: true });
});

// ---- Step 2: attach payment (bank chosen + receipt image) ----
router.post('/orders/:id/payment', (req, res, next) => {
  if (isPaymentUploadRateLimited(req.ip)) {
    reportLockout(`payment-upload-ip:${req.ip}`, `IP ${req.ip} exceeded ${PAYMENT_UPLOAD_MAX_ATTEMPTS} payment-upload attempts in ${PAYMENT_UPLOAD_WINDOW_MS / 60000} minutes.`);
    return res.status(429).json({ error: 'Too many upload attempts from this network. Please wait a bit and try again.' });
  }
  next();
}, handleUpload(upload.single('receipt')), (req, res) => {
  let data = db.load();
  data = db.sweepExpired(data);
  const order = data.orders.find(o => o.id === req.params.id);
  if (!order) {
    // Clean up: file was already saved to disk before we knew the order
    // lookup would fail.
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(404).json({ error: 'Order not found' });
  }
  if (order.status !== 'awaiting_payment') {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: `Order is not awaiting payment (status: ${order.status})` });
  }
  if (!req.file) return res.status(400).json({ error: 'Payment receipt image is required' });

  // fileFilter only ever saw the client-declared Content-Type for this part,
  // which a non-browser client can set to anything - confirm the bytes
  // actually on disk are a real image before accepting the upload.
  verifyUploadedImage(req.file.path, async (verifyErr) => {
    if (verifyErr) return res.status(400).json({ error: verifyErr.message });

    const supabase = getSupabaseClient();
    if (supabase) {
      try {
        const fileBuffer = fs.readFileSync(req.file.path);
        const objectPath = req.file.filename; // already unique: Date.now()_nanoid.ext
        const { error: uploadErr } = await supabase.storage
          .from(RECEIPT_BUCKET)
          .upload(objectPath, fileBuffer, { contentType: req.file.mimetype, upsert: false });
        // The local copy was only ever needed for verifyUploadedImage above -
        // clean it up either way now, since uploadsDir doesn't survive a
        // restart anyway and there's no reason to let it pile up meanwhile.
        fs.unlink(req.file.path, () => {});
        if (uploadErr) {
          console.warn('⚠️  Supabase receipt upload failed, order will have no viewable receipt:', uploadErr.message);
          return res.status(502).json({ error: 'Could not store the receipt image. Please try again.' });
        }
        order.receiptPath = `supabase:${objectPath}`;
      } catch (err) {
        fs.unlink(req.file.path, () => {});
        console.warn('⚠️  Supabase receipt upload failed, order will have no viewable receipt:', err.message);
        return res.status(502).json({ error: 'Could not store the receipt image. Please try again.' });
      }
    } else {
      // No Supabase configured (e.g. local dev without those env vars) -
      // same local-disk behavior as before. Fine for local dev; on Render
      // free tier this means the receipt won't survive a redeploy, same
      // caveat as everything else that isn't in Supabase.
      order.receiptPath = `/uploads/${req.file.filename}`;
    }

    order.bankSelected = req.body.bankId || null;
    order.senderAccount = req.body.senderAccount || null;
    order.status = 'pending'; // now awaiting admin approval
    order.submittedAt = new Date().toISOString();

    db.save(data);
    res.json({ order });

    // Fire-and-forget, same contract as notifyCustomer in the approve/
    // reject handlers: never awaited, and notifyAdmin() swallows every
    // failure itself, so a missing/unlinked Telegram setup can't turn a
    // successful receipt upload into an error response for the buyer.
    const raffle = data.raffles.find(r => r.id === order.raffleId);
    const ticketWord = order.ticketNumbers.length > 1 ? 'numbers' : 'number';
    notifyAdmin(data,
      `🔔 New order awaiting approval - "${raffle ? raffle.title : 'Unknown raffle'}"\n\n` +
      `Buyer: ${order.fullName} (${order.phone})\n` +
      `Ticket ${ticketWord}: ${order.ticketNumbers.join(', ')}\n` +
      `Total: ${order.total.toLocaleString()} Birr\n\n` +
      `Review it in the admin panel.`
    );
  });
});

// ---- Get single order status (for polling / resuming payment) ----
router.get('/orders/:id', (req, res) => {
  let data = db.load();
  data = db.sweepExpired(data);
  const order = data.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({ order });
});

// ---- Payment receipt image (admin-only) ----
// The only way to fetch a receipt's actual image bytes - see the static-
// mount comment in index.js for why this isn't just a public /uploads URL.
// The buyer-facing app never links back to a buyer's own receipt after
// upload (it only uploads, never displays it back), so there's currently no
// legitimate non-admin caller to accommodate here. If that changes, key off
// order.phone the same way GET /tickets already does, rather than reopening
// the file to public static serving.
router.get('/orders/:id/receipt', async (req, res) => {
  if (!req.session || !req.session.adminId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (isReceiptViewRateLimited(req.ip)) {
    return res.status(429).json({ error: 'Too many requests from this network. Please wait a bit and try again.' });
  }
  const data = db.load();
  const order = data.orders.find(o => o.id === req.params.id);
  if (!order || !order.receiptPath) return res.status(404).json({ error: 'Receipt not found' });

  if (order.receiptPath.startsWith('supabase:')) {
    const objectPath = order.receiptPath.slice('supabase:'.length);
    const supabase = getSupabaseClient();
    if (!supabase) return res.status(404).json({ error: 'Receipt not found' });
    const { data: fileBlob, error } = await supabase.storage.from(RECEIPT_BUCKET).download(objectPath);
    if (error || !fileBlob) return res.status(404).json({ error: 'Receipt not found' });
    const arrayBuffer = await fileBlob.arrayBuffer();
    res.setHeader('Content-Type', fileBlob.type || 'application/octet-stream');
    return res.send(Buffer.from(arrayBuffer));
  }

  // Legacy path: receipts uploaded before the Supabase Storage switch (or
  // when Supabase isn't configured) are still just a local file.
  const resolved = path.resolve(uploadsDir, order.receiptPath.replace(/^\/uploads\//, ''));
  if (!resolved.startsWith(uploadsDir + path.sep)) {
    return res.status(404).json({ error: 'Receipt not found' });
  }
  res.sendFile(resolved, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Receipt not found' });
  });
});

// ---- Bank accounts (read-only) ----
// Previously only ever sent back as part of the order-create response, which
// meant a customer who left mid-checkout (order created, payment not yet
// uploaded) had no way to see the bank list again without creating a brand
// new order. Needed to resume payment on an existing order from "My Tickets".
router.get('/banks', (req, res) => {
  const data = db.load();
  res.json({ banks: data.banks });
});

// ---- Lookup tickets by phone number ----
// Requires the phone number *and* the customer id that was handed back
// when that phone first placed an order (see getOrCreateCustomer in
// db.js). A phone number alone is knowable/guessable by someone other
// than its owner; the id is an opaque per-phone secret that only the
// buyer has seen, so this is what actually gates access to another
// buyer's name, ticket numbers, order history and receipt link - the
// rate limiters below only slow down guessing, they don't prevent it.
router.get('/tickets', (req, res) => {
  if (isTicketsLookupRateLimited(req.ip)) {
    reportLockout(`tickets-lookup-ip:${req.ip}`, `IP ${req.ip} exceeded ${TICKETS_LOOKUP_MAX_ATTEMPTS} ticket-lookup attempts in ${TICKETS_LOOKUP_WINDOW_MS / 60000} minutes - possible phone-number enumeration.`);
    return res.status(429).json({ error: 'Too many lookup attempts from this network. Please wait a bit and try again.' });
  }
  const phone = (req.query.phone || '').trim();
  const customerId = (req.query.customerId || '').trim().toUpperCase();
  if (!phone) return res.status(400).json({ error: 'phone query param required' });
  if (!customerId) return res.status(400).json({ error: 'customerId query param required' });
  if (isTicketsLookupPhoneRateLimited(phone)) {
    reportLockout(`tickets-lookup-phone:${phone}`, `Phone number ${phone} was looked up more than ${TICKETS_LOOKUP_PHONE_MAX_ATTEMPTS} times in ${TICKETS_LOOKUP_PHONE_WINDOW_MS / 60000} minutes, possibly from multiple IPs - possible targeted scraping of one buyer's data.`);
    return res.status(429).json({ error: 'Too many lookups for this number. Please wait a bit and try again.' });
  }
  let data = db.load();
  data = db.sweepExpired(data);

  const customer = data.customers.find(c => c.phone === phone);
  if (!customer || customer.id !== customerId) {
    reportLockout(`tickets-lookup-badid:${phone}`, `Ticket lookup for phone ${phone} was made with a wrong/missing customer id from IP ${req.ip} - possible attempt to access another buyer's tickets.`);
    return res.status(403).json({ error: 'Phone number and customer ID do not match. Check the ID we gave you when you first ordered.' });
  }

  const orders = data.orders
    .filter(o => o.phone === phone)
    .map(o => {
      const raffle = data.raffles.find(r => r.id === o.raffleId);
      return { ...o, raffleTitle: raffle ? raffle.title : 'Unknown', raffleImage: raffle ? raffle.imageUrl : '', raffleNumber: raffle ? raffle.raffleNumber : null };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const active = orders.filter(o => o.status === 'confirmed').length;
  const pending = orders.filter(o => o.status === 'pending' || o.status === 'awaiting_payment').length;

  res.json({ orders, counts: { active, pending, total: orders.length } });
});

// ---- Buyer deletes their own expired order ----
// Deliberately narrow, mirroring the admin-side delete rule: only 'expired'
// orders qualify. An expired order already has no money and no held
// number attached (sweepExpired already released it back to the pool), so
// there's nothing for a buyer to lose by clearing it from their own list -
// unlike a pending/awaiting_payment/confirmed order, which still
// represents something real that only the admin should be able to unwind.
router.delete('/orders/:id', (req, res) => {
  if (isTicketsLookupRateLimited(req.ip)) {
    reportLockout(`tickets-lookup-ip:${req.ip}`, `IP ${req.ip} exceeded ${TICKETS_LOOKUP_MAX_ATTEMPTS} ticket-lookup attempts in ${TICKETS_LOOKUP_WINDOW_MS / 60000} minutes - possible phone-number enumeration.`);
    return res.status(429).json({ error: 'Too many attempts from this network. Please wait a bit and try again.' });
  }
  const phone = (req.body.phone || '').trim();
  const customerId = (req.body.customerId || '').trim().toUpperCase();
  if (!phone) return res.status(400).json({ error: 'phone is required' });
  if (!customerId) return res.status(400).json({ error: 'customerId is required' });
  if (isTicketsLookupPhoneRateLimited(phone)) {
    reportLockout(`tickets-lookup-phone:${phone}`, `Phone number ${phone} was looked up more than ${TICKETS_LOOKUP_PHONE_MAX_ATTEMPTS} times in ${TICKETS_LOOKUP_PHONE_WINDOW_MS / 60000} minutes, possibly from multiple IPs - possible targeted scraping of one buyer's data.`);
    return res.status(429).json({ error: 'Too many attempts for this number. Please wait a bit and try again.' });
  }

  let data = db.load();
  data = db.sweepExpired(data);

  const customer = data.customers.find(c => c.phone === phone);
  if (!customer || customer.id !== customerId) {
    reportLockout(`tickets-lookup-badid:${phone}`, `Order delete for phone ${phone} was attempted with a wrong/missing customer id from IP ${req.ip} - possible attempt to modify another buyer's data.`);
    return res.status(403).json({ error: 'Phone number and customer ID do not match.' });
  }

  const order = data.orders.find(o => o.id === req.params.id);
  if (!order || order.phone !== phone) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'expired') {
    return res.status(400).json({ error: 'Only expired orders can be deleted.' });
  }

  data.orders = data.orders.filter(o => o.id !== order.id);
  db.save(data);
  res.json({ ok: true });
});

// ---- Telegram bot <-> mini app bridge ----
//
// POST /telegram/link is called by the bot's own server, right after a
// user shares their phone number, to record "this Telegram account = this
// phone/name". It is NOT reachable by the mini app or any browser client -
// it's gated on a shared secret (INTERNAL_API_KEY) that only the bot
// process holds, because it writes a phone number under someone's control
// and must not be callable by an arbitrary visitor.
//
// POST /telegram/prefill is called by the mini app frontend, once, on
// load. It proves who's asking via Telegram's signed initData (see
// verifyTelegramInitData in utils.js) rather than a client-supplied id -
// otherwise anyone could POST { user: { id: <someone else's id> } } and
// pull back that person's phone number.
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

router.post('/telegram/link', (req, res) => {
  if (!INTERNAL_API_KEY) {
    return res.status(503).json({ error: 'Telegram linking is not configured on this server' });
  }
  const providedKey = req.get('x-internal-key') || '';
  if (!providedKey || !timingSafeStringEqual(providedKey, INTERNAL_API_KEY)) {
    reportLockout(`telegram-link-badkey:${req.ip}`, `IP ${req.ip} called POST /telegram/link with a missing/wrong internal key - possible attempt to plant a fake phone/telegramId pairing.`);
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { telegramId, phone, fullName, username, language } = req.body || {};
  if (!telegramId || !phone) {
    return res.status(400).json({ error: 'telegramId and phone are required' });
  }
  // Only accept languages the mini app actually supports - an unrecognized
  // value here would otherwise get stored and later handed back to the
  // frontend's applyLang(), which has no fallback for an unknown code.
  const SUPPORTED_LANGS = ['om', 'am', 'en'];
  const safeLanguage = SUPPORTED_LANGS.includes(language) ? language : null;
  const data = db.load();
  const user = db.upsertTelegramUser(
    data,
    telegramId,
    String(phone).trim(),
    String(fullName || '').trim(),
    username ? String(username).trim() : '',
    safeLanguage
  );
  db.save(data);
  res.json({ ok: true, telegramId: user.telegramId });
});

router.post('/telegram/prefill', (req, res) => {
  if (isTicketsLookupRateLimited(req.ip)) {
    return res.status(429).json({ error: 'Too many attempts from this network. Please wait a bit and try again.' });
  }
  if (!TELEGRAM_BOT_TOKEN) {
    return res.status(503).json({ error: 'Telegram verification is not configured on this server' });
  }
  const { initData } = req.body || {};
  const tgUser = verifyTelegramInitData(initData, TELEGRAM_BOT_TOKEN);
  if (!tgUser) {
    return res.status(403).json({ error: 'Could not verify Telegram session' });
  }
  const data = db.load();
  const linked = db.findTelegramUser(data, tgUser.id);
  if (!linked) {
    // Not an error - just means this Telegram account hasn't shared its
    // phone with the bot yet (or shared it before this feature existed).
    return res.json({ linked: false });
  }
  // Also hand back this phone's customerId, the opaque secret /tickets
  // normally requires alongside the phone number to stop a stranger from
  // looking up someone else's orders by phone alone. That protection isn't
  // needed here - verifyTelegramInitData above already cryptographically
  // proved this request really is from the Telegram account linked to this
  // phone, which is at least as strong a guarantee as knowing the id. Without
  // this, "My Tickets" had the phone but never the id, so it could never
  // auto-load - the buyer would see an empty list despite having real orders.
  const customer = data.customers.find(c => c.phone === linked.phone);
  res.json({
    linked: true,
    phone: linked.phone,
    fullName: linked.fullName,
    customerId: customer ? customer.id : null,
    language: linked.language || null
  });
});

// ---- Announcements (public, read-only) ----
// Site-wide messages the admin posts from Admin -> Announcements. No auth
// needed to read these - they're meant to be visible to every visitor,
// same as the winner cards already shown in this panel. Capped at 30 so
// the bell panel doesn't have to paginate; older ones are still in
// data.json if ever needed, just not returned here.
router.get('/announcements', (req, res) => {
  const data = db.load();
  const list = (data.announcements || []).slice(0, 30);
  res.json({ announcements: list });
});

module.exports = router;
