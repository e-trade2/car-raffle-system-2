const { randomInt, createHmac, timingSafeEqual } = require('crypto');
const fs = require('fs');
const multer = require('multer');

// ---- Real file-type validation (magic bytes) ----
// `file.mimetype` in a multer fileFilter is just whatever Content-Type the
// client's multipart request declared for that part - a plain HTTP client
// (curl, a scripted attacker) can set it to "image/png" while uploading a
// .php/.html/.svg-with-script file, sailing straight through a fileFilter
// that only checks that string. The only trustworthy signal is the actual
// leading bytes of the file on disk, so this checks those against the
// well-known magic numbers for the image formats this app accepts.
const IMAGE_SIGNATURES = [
  { format: 'jpeg', bytes: [0xff, 0xd8, 0xff] },
  { format: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { format: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] }
  // webp/heic are checked separately below since their "magic" isn't a
  // single fixed prefix (RIFF....WEBP / ftyp box with a variable offset).
];

function bufferMatches(buf, sig) {
  if (buf.length < sig.length) return false;
  return sig.every((b, i) => buf[i] === b);
}

function isValidImageBuffer(buf) {
  if (!buf || buf.length < 12) return false;
  if (IMAGE_SIGNATURES.some(sig => bufferMatches(buf, sig.bytes))) return true;
  // WEBP: "RIFF" .... "WEBP"
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return true;
  // HEIC/HEIF: ISO base media file box, bytes 4-7 are "ftyp" and the brand
  // (bytes 8-11) is one of a known set of HEIC/HEIF brands.
  if (buf.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.slice(8, 12).toString('ascii');
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return true;
  }
  return false;
}

// Reads just enough of the file to check its signature, then deletes it if
// it doesn't actually match an accepted image format - fileFilter alone
// can't do this (it only sees the client-declared mimetype, not disk
// content), so this runs as a second check after multer has written the
// file. Calls back with an Error (never throws) so route handlers can
// respond 400 instead of letting it fall through to the global 500 handler.
function verifyUploadedImage(filePath, cb) {
  fs.open(filePath, 'r', (openErr, fd) => {
    if (openErr) return cb(openErr);
    const buf = Buffer.alloc(12);
    fs.read(fd, buf, 0, 12, 0, (readErr) => {
      fs.close(fd, () => {});
      if (readErr) return cb(readErr);
      if (!isValidImageBuffer(buf)) {
        fs.unlink(filePath, () => {});
        return cb(new Error('Uploaded file is not a valid image'));
      }
      cb(null);
    });
  });
}

// Wraps a multer middleware (e.g. upload.single('photo')) so that both
// multer's own errors (file too large, unexpected field, etc - raised as
// multer.MulterError) and the fileFilter's plain Error("Only image files...")
// are turned into a 400 response here, instead of being passed to next(err)
// and falling through to the app-wide error handler in index.js, which
// always responds 500. A bad/oversized upload is a client mistake, not a
// server fault.
function handleUpload(uploadMiddleware) {
  return function (req, res, next) {
    uploadMiddleware(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError || err.message) {
          return res.status(400).json({ error: err.message || 'Upload failed' });
        }
        return next(err);
      }
      next();
    });
  };
}

function getAvailability(raffle) {
  const taken = new Set(raffle.takenNumbers);
  const pendingNums = new Set(Object.keys(raffle.pending || {}).map(Number));
  const soldCount = taken.size;
  const pendingCount = pendingNums.size;
  return { taken, pendingNums, soldCount, pendingCount };
}

function numberStatus(raffle, n) {
  const num = Number(n);
  if (raffle.takenNumbers.includes(num)) return 'taken';
  if (raffle.pending && raffle.pending[String(num)]) return 'pending';
  return 'available';
}

// A winner's full name lives on the order (and is fine for the admin panel
// to show in full), but broadcasting it verbatim to every visitor via the
// public /raffles list is more than this feature needs - "Abebe K." reads
// just as well as a winner announcement and doesn't hand out a stranger's
// full legal name. Falls back gracefully for single-word names.
function maskWinnerName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Winner';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

function publicRaffle(raffle) {
  const { soldCount, pendingCount } = getAvailability(raffle);
  const remaining = raffle.totalNumbers - soldCount - pendingCount;
  return {
    id: raffle.id,
    raffleNumber: raffle.raffleNumber,
    title: raffle.title,
    subtitle: raffle.subtitle,
    imageUrl: raffle.imageUrl,
    price: raffle.price,
    totalNumbers: raffle.totalNumbers,
    rating: raffle.rating,
    status: raffle.status,
    badge: raffle.badge,
    drawAt: raffle.drawAt,
    soldCount,
    remaining: Math.max(0, remaining),
    percentFilled: Math.round((soldCount / raffle.totalNumbers) * 100),
    // Only surfaced once a raffle has actually been drawn - undrawn raffles
    // simply omit the field rather than sending winner:null everywhere.
    ...(raffle.status === 'ended' && raffle.winner ? {
      winner: {
        number: raffle.winner.number,
        name: maskWinnerName(raffle.winner.fullName),
        drawnAt: raffle.winner.drawnAt
      }
    } : {})
  };
}

function randomAvailableNumbers(raffle, qty, exclude) {
  const { taken, pendingNums } = getAvailability(raffle);
  const excludeSet = exclude && exclude.length ? new Set(exclude) : null;
  const pool = [];
  for (let i = 1; i <= raffle.totalNumbers; i++) {
    if (!taken.has(i) && !pendingNums.has(i) && !(excludeSet && excludeSet.has(i))) pool.push(i);
  }
  // shuffle (Fisher-Yates) then take qty. Uses crypto.randomInt rather than
  // Math.random() - Math.random() isn't a CSPRNG, and "which numbers you're
  // randomly assigned" is close enough to the money side of this app that
  // it's worth not having to argue about predictability later.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, qty);
}

// Verifies that a Telegram.WebApp.initData string genuinely came from
// Telegram for *this* bot, per Telegram's documented check:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//
//   secret_key = HMAC_SHA256(<bot_token>, "WebAppData")
//   data_check_string = all fields except `hash`, sorted by key,
//                        joined as "key=value" with "\n"
//   expected_hash = HMAC_SHA256(data_check_string, secret_key), hex
//
// A raw string is not proof of anything by itself - it's just whatever
// the client's JS handed the page, and a page can be opened outside
// Telegram entirely. Without this check, anyone could POST a made-up
// { user: { id: <any id> } } payload and pull back another Telegram
// user's linked phone number from /api/telegram/prefill.
//
// maxAgeSeconds rejects old initData too - Telegram signs it once per
// mini-app open, but a captured initData string would otherwise stay
// "valid" forever; Telegram's own guidance is to treat auth_date as a
// freshness check, not just a formatting field.
function verifyTelegramInitData(initData, botToken, maxAgeSeconds = 24 * 60 * 60) {
  if (!initData || typeof initData !== 'string' || !botToken) return null;

  let params;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }

  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const pairs = [];
  for (const key of params.keys()) pairs.push(key);
  const uniqueKeys = [...new Set(pairs)].sort();
  const dataCheckString = uniqueKeys.map(k => `${k}=${params.get(k)}`).join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const hashBuf = Buffer.from(hash, 'hex');
  const expectedBuf = Buffer.from(expectedHash, 'hex');
  if (hashBuf.length !== expectedBuf.length || !timingSafeEqual(hashBuf, expectedBuf)) {
    return null;
  }

  const authDate = Number(params.get('auth_date'));
  if (!authDate || (Date.now() / 1000 - authDate) > maxAgeSeconds) return null;

  let user = null;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    user = null;
  }
  if (!user || !user.id) return null;

  return user;
}

module.exports = { getAvailability, numberStatus, publicRaffle, randomAvailableNumbers, verifyUploadedImage, handleUpload, verifyTelegramInitData, maskWinnerName };
