// Bridges the local, synchronous data/db.json file (which the rest of the
// app reads/writes with plain fs calls) to Supabase Postgres, so the data
// survives restarts on hosts with an ephemeral filesystem (e.g. Render's
// free tier), without having to convert every db.load()/db.save() call
// site across the routes into async code.
//
// The whole app's state is stored as a single JSONB blob in one row - not
// normalized into real tables - because the local file is already the
// source of truth for the shape of that data (see db.js/defaultData()),
// and duplicating that shape into a relational schema would just be a
// second place for the two to drift out of sync. This trades relational
// query power (which nothing here needs - the app already loads the whole
// blob into memory) for a migration that can't silently lose or
// misinterpret fields.
//
// Strategy:
//   - On startup, pull the latest saved blob down from Supabase and write
//     it over the local data/db.json *before* the app's normal db.load()
//     runs, so the app boots up already "warm" with real data instead of
//     looking like a fresh install.
//   - On every db.save(), after the local file write completes (so the
//     app is never slowed down or blocked by a network call), fire off a
//     background upsert to Supabase. If it fails, the local file is still
//     correct - the failure is only logged, not thrown, since a save
//     succeeding locally should never look like a save that failed.
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_KEY to be set (use the
// service_role key, not the anon key - this code only ever runs on the
// server, never reaches the browser, and needs to bypass Row Level
// Security to read/write its own row unconditionally). If either is
// missing, every function here is a no-op and the app behaves exactly as
// it did before this file existed - pure local file storage.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

// Single-row table: this app has exactly one "state" to persist, so there's
// no meaningful id to key on other than a constant.
const ROW_ID = 1;

let cachedClient; // undefined = not checked yet, null = checked and unavailable
function getClient() {
  if (cachedClient !== undefined) return cachedClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    cachedClient = null;
    return cachedClient;
  }

  const { createClient } = require('@supabase/supabase-js');
  cachedClient = createClient(url, key);
  return cachedClient;
}

// Called once at startup, before db.load(). Overwrites the local file with
// whatever was last saved to Supabase, if anything. Never throws - a
// Supabase outage on boot should degrade to "start with whatever's on
// local disk" (which, on a fresh container, means db.js's normal
// first-run/random-password path), not crash the app.
async function pullLatestIntoLocalFile() {
  const supabase = getClient();
  if (!supabase) return;

  try {
    const { data: row, error } = await supabase
      .from('app_state')
      .select('data')
      .eq('id', ROW_ID)
      .maybeSingle();

    if (error) {
      console.warn('⚠️  Supabase pull failed, starting from local data/db.json instead:', error.message);
      return;
    }
    if (!row || !row.data) {
      console.log('ℹ️  No saved state in Supabase yet - this looks like a genuine first run.');
      return;
    }

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(row.data, null, 2));
    console.log('✅ Restored data/db.json from Supabase (raffles, orders, admin login, etc. carried over from before restart).');
  } catch (err) {
    console.warn('⚠️  Supabase pull failed, starting from local data/db.json instead:', err.message);
  }
}

// Fire-and-forget: called from db.js's save(), after the local file write
// has already completed, so a Supabase hiccup never blocks or fails a
// request that already succeeded locally.
function pushToSupabaseInBackground(data) {
  const supabase = getClient();
  if (!supabase) return;

  supabase
    .from('app_state')
    .upsert({ id: ROW_ID, data, updated_at: new Date().toISOString() })
    .then(({ error }) => {
      if (error) console.warn('⚠️  Supabase save failed (local data/db.json is still up to date):', error.message);
    })
    .catch(err => {
      console.warn('⚠️  Supabase save failed (local data/db.json is still up to date):', err.message);
    });
}

module.exports = { pullLatestIntoLocalFile, pushToSupabaseInBackground, getClient };
