#!/usr/bin/env node
// meural-push.js — Postcard a fresh portrait screenshot to each frame (the live
// display); nightly (22:00 or `resync` arg) also back it up to the cloud gallery.
// Usage: node meural-push.js
// Requires: npm install puppeteer --save-dev  (first run only)
'use strict';

const path = require('path');
const fs   = require('fs');
// The Pi has a ULA-only IPv6 (router RA, no v6 internet), so getaddrinfo offers
// AAAA records that Node's fetch tries first and ETIMEDOUTs on — curl survives via
// happy-eyeballs, Node doesn't. Prefer IPv4 (bit us 2026-07: Cognito auth fatals).
require('dns').setDefaultResultOrder('ipv4first');
const { meural: mc, gatus: gatusCfg } = require('./config');

const COGNITO_URL     = `https://cognito-idp.${mc.cognitoRegion}.amazonaws.com/`;
const API_BASE        = 'https://api.meural.com/v0';
const PORTRAIT_URL    = (mc.portraitUrl || 'http://localhost:3000') + '/portrait.html';
const COUNT           = parseInt(process.argv[2]) || 1;
// Meural shows a postcard as a "preview" governed by previewDuration (default 60s →
// it reverts after a minute). Pin preview/image/overlay durations high so a postcard
// HOLDS until the next push. (Applied by the frame at boot; re-set every run so a
// reset/firmware update can't silently drift it back to 60s.)
const HOLD_DURATION   = 86400; // 24h
const API_TIMEOUT     = 20_000; // ms — never let a sick Meural backend black-hole a run
const LOCK_FILE       = path.join(__dirname, '.meural-push.lock');
const SNAPSHOT_DIR    = __dirname;
const snapshotPath    = (i) => path.join(SNAPSHOT_DIR, `_meural-snapshot-${i}.jpg`);
const sleep           = (ms) => new Promise((r) => setTimeout(r, ms));

// Nightly cloud run: the first tick of the last cron hour (22:00 — schedule is
// `*/15 5-22 * * *`) gates ALL cloud gallery work — upload, cleanup, and the full
// resync that purges + re-pulls each frame's LOCAL gallery cache. Frames can
// silently stop honoring cloud item-deletes and hoard stale local snapshots — one
// wedged a frame on a 3-week-old image while the cloud gallery was perfectly
// current, and neither a reboot nor a gallery-bounce cleared it. Force manually
// with a `resync` arg:  node meural-push.js 6 resync
const NIGHTLY_RESYNC_HOUR = 22;
const RESYNC          = process.argv.slice(2).includes('resync') ||
  (new Date().getHours() === NIGHTLY_RESYNC_HOUR && new Date().getMinutes() < 15); // once/night even at */15 cadence

// ── Cognito auth ──────────────────────────────────────────────────────────────
async function getToken() {
  const res = await fetch(COGNITO_URL, {
    method: 'POST',
    headers: {
      'content-type':  'application/x-amz-json-1.1',
      'x-amz-target':  'AWSCognitoIdentityProviderService.InitiateAuth',
    },
    body: JSON.stringify({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: mc.cognitoClientId,
      AuthParameters: { USERNAME: mc.email, PASSWORD: mc.password },
    }),
    signal: AbortSignal.timeout(API_TIMEOUT),
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status} ${await res.text()}`);
  const { AuthenticationResult } = await res.json();
  return AuthenticationResult.AccessToken;
}

// ── Meural API helpers ────────────────────────────────────────────────────────
function headers(token, extra = {}) {
  return { Authorization: `Token ${token}`, 'x-meural-api-version': '3', ...extra };
}

async function apiGet(token, p) {
  const res = await fetch(`${API_BASE}${p}`, { headers: headers(token), signal: AbortSignal.timeout(API_TIMEOUT) });
  if (!res.ok) throw new Error(`GET ${p}: ${res.status}`);
  return (await res.json()).data;
}

async function apiPost(token, p, body) {
  const isForm = body instanceof FormData;
  const res = await fetch(`${API_BASE}${p}`, {
    method: 'POST',
    headers: headers(token, isForm ? {} : { 'content-type': 'application/json' }),
    body: isForm ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(API_TIMEOUT),
  });
  if (!res.ok) throw new Error(`POST ${p}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function apiDelete(token, p) {
  const res = await fetch(`${API_BASE}${p}`, { method: 'DELETE', headers: headers(token), signal: AbortSignal.timeout(API_TIMEOUT) });
  // 404 = already gone, that's fine
  if (!res.ok && res.status !== 404) throw new Error(`DELETE ${p}: ${res.status}`);
}

// ── Pin display durations so a postcard persists (the bridge while cloud is down) ──
// Idempotent: re-applied each run. Takes effect on the frame at its NEXT boot — but
// keeping the saved value at 86400 means any reboot (power blip, update) applies it.
async function setHoldDurations(token) {
  for (const d of mc.devices) {
    if (!d.id) continue;
    try {
      const body = new URLSearchParams({
        previewDuration: String(HOLD_DURATION),
        imageDuration:   String(HOLD_DURATION),
        overlayDuration: String(HOLD_DURATION),
      });
      const res = await fetch(`${API_BASE}/devices/${d.id}`, {
        method: 'PUT',
        headers: headers(token, { 'content-type': 'application/x-www-form-urlencoded' }),
        body,
        signal: AbortSignal.timeout(10_000),
      });
      console.log(`  ${d.name}: durations ${res.ok ? 'pinned' : `HTTP ${res.status}`}`);
    } catch (e) { console.warn(`  ${d.name}: durations failed: ${e.message}`); }
  }
}

// ── Gallery: find/create, remove duplicates, collect existing item IDs ────────
async function prepareGallery(token) {
  const all = await apiGet(token, '/user/galleries?count=1000');
  // Sort populated-first so dedup keeps the gallery WITH items, not an empty stray
  // that happened to sort first (the API order is arbitrary).
  const itemsOf = (g) => g.itemCount ?? g.imageCount ?? g.count ?? 0;
  const matches = all.filter(g => g.name === mc.galleryName).sort((a, b) => itemsOf(b) - itemsOf(a));

  if (matches.length > 1) {
    console.log(`Found ${matches.length} "${mc.galleryName}" galleries — keeping the populated one, removing duplicates`);
    for (const g of matches.slice(1)) {
      await apiDelete(token, `/galleries/${g.id}`);
      console.log(`  deleted gallery ${g.id} (${itemsOf(g)} items)`);
    }
  }

  let galleryId;
  if (matches.length >= 1) {
    galleryId = matches[0].id;
    console.log(`Gallery "${mc.galleryName}" id: ${galleryId}`);
  } else {
    const { data } = await apiPost(token, '/galleries', { name: mc.galleryName, orientation: 'portrait' });
    galleryId = data.id;
    console.log(`Created gallery "${mc.galleryName}" id: ${galleryId}`);
  }

  // Collect existing item IDs — we'll delete them after new content is pushed
  let oldItemIds = [];
  try {
    const items = await apiGet(token, `/galleries/${galleryId}/items?count=1000`);
    if (items && items.length > 0) {
      oldItemIds = items.map(item => item.id);
      console.log(`Found ${oldItemIds.length} existing item(s) — will remove after push`);
    } else {
      console.log('Gallery is empty');
    }
  } catch (e) {
    console.warn('Could not list gallery items:', e.message);
  }

  return { galleryId, oldItemIds };
}

// ── Delete old items (called after new content is pushed) ─────────────────────
async function clearOldItems(token, oldItemIds) {
  if (oldItemIds.length === 0) return;
  console.log(`\nRemoving ${oldItemIds.length} old item(s)...`);
  for (const id of oldItemIds) {
    await apiDelete(token, `/items/${id}`).catch(e => console.warn(`  item ${id}: ${e.message}`));
  }
}

// ── Screenshots via Puppeteer ─────────────────────────────────────────────────
async function takeScreenshots(count) {
  let puppeteer;
  try { puppeteer = require('puppeteer-core'); }
  catch { try { puppeteer = require('puppeteer'); }
  catch { throw new Error('Install puppeteer or puppeteer-core: npm install puppeteer-core --save-dev'); } }

  console.log(`Taking ${count} screenshot(s) of ${PORTRAIT_URL} ...`);
  const launchOpts = {
    headless: 'new',
    args: ['--no-sandbox', '--password-store=basic', '--disable-dev-shm-usage'],
  };
  if (mc.chromiumPath) launchOpts.executablePath = mc.chromiumPath;
  const browser = await puppeteer.launch(launchOpts);

  const paths = [];
  try {
    for (let i = 0; i < count; i++) {
      const page = await browser.newPage();
      await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });
      await page.goto(PORTRAIT_URL, { waitUntil: 'networkidle0', timeout: 30_000 });
      await page.waitForFunction(
        () => document.body.dataset.ready === 'true',
        { timeout: 15_000 }
      ).catch(() => console.warn('  data-ready timeout — screenshotting anyway'));
      const p = snapshotPath(i);
      await page.screenshot({ path: p, type: 'jpeg', quality: 92 });
      await page.close();
      console.log(`  [${i + 1}/${count}] saved: ${path.basename(p)}`);
      paths.push(p);
    }
  } finally {
    await browser.close();
  }
  return paths;
}

// ── Upload image ──────────────────────────────────────────────────────────────
async function uploadItem(token, filePath, label) {
  const imageBytes = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('image', new Blob([imageBytes], { type: 'image/jpeg' }), 'dashboard.jpg');

  const res = await fetch(`${API_BASE}/items`, {
    method: 'POST',
    headers: headers(token),
    body: form,
    signal: AbortSignal.timeout(API_TIMEOUT),
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
  const { data } = await res.json();
  console.log(`  ${label} → item id: ${data.id}`);
  return data.id;
}

// ── Push to devices: postcard ONLY (the live display path) ─────────────────────
// The postcard goes straight to each frame's local API, bypasses Meural's cloud,
// and HOLDS because previewDuration is pinned to 24h (see setHoldDurations). It is
// the display, full stop. We deliberately do NOT assign/sync/change_gallery the
// device here, even when the cloud upload succeeded: doing so switches the frame to
// the gallery and — because the device sync is async — it lands on the OLD, not-yet-
// downloaded item and (with imageDuration pinned to 24h) sits there for a full day,
// silently defeating the fresh postcard. (Caught in peer review, 2026-06-18.) The
// cloud gallery is still kept populated by main() as a backup for if/when we switch
// back to gallery mode, but it is not what's shown. Returns # of frames delivered.
async function pushToDevices(postcardPath) {
  let delivered = 0;
  for (const device of mc.devices) {
    console.log(`\n--- ${device.name} (${device.ip}) ---`);
    try {
      const form = new FormData();
      form.append('photo', new Blob([fs.readFileSync(postcardPath)], { type: 'image/jpeg' }), 'dashboard.jpg');
      const res = await fetch(`http://${device.ip}/remote/postcard`, {
        method: 'POST', body: form, signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) { delivered++; console.log('  ✓ Postcard delivered (holds via 24h previewDuration)'); }
      else console.warn(`  ✗ Postcard HTTP ${res.status}`);
    } catch (e) { console.warn(`  ✗ postcard failed: ${e.message}`); }
  }
  return delivered;
}

// ── Nightly full resync: purge + re-pull each frame's LOCAL gallery cache ──────
// Removing the gallery from the device + sync makes the frame delete its local
// copy (the stale-hoard); re-adding + sync re-pulls only the current items. Run
// AFTER the normal push so the re-pull lands on fresh content. Heavier than a
// normal sync (extra delete/sync round-trips), so it's once-a-night, not hourly.
async function resyncDevices(token, galleryId) {
  console.log('\n=== Nightly full resync (purge stale local cache + re-pull) ===');
  for (const device of mc.devices) {
    console.log(`\n--- ${device.name} (id: ${device.id}) ---`);
    try {
      // Purge step is best-effort: DELETE 400s if the gallery isn't attached to the
      // device (e.g. after a long cloud outage) — nothing to purge, go straight to add.
      try {
        await apiDelete(token, `/devices/${device.id}/galleries/${galleryId}`);
        await fetch(`${API_BASE}/devices/${device.id}/sync`, { method: 'POST', headers: headers(token) });
        console.log('  ✓ gallery removed + purge sync');
        await sleep(8_000);   // let the frame act on the removal before re-adding
      } catch (e) { console.warn(`  purge skipped (gallery not attached?): ${e.message}`); }
      await fetch(`${API_BASE}/devices/${device.id}/galleries/${galleryId}`, { method: 'POST', headers: headers(token) });
      await fetch(`${API_BASE}/devices/${device.id}/sync`, { method: 'POST', headers: headers(token) });
      console.log('  ✓ gallery re-added + re-pull sync');
      await sleep(10_000);  // let the re-pull finish before forcing display
      await fetch(`http://${device.ip}/remote/control_command/change_gallery/${galleryId}/`, { signal: AbortSignal.timeout(10_000) });
      await fetch(`http://${device.ip}/remote/control_command/resume/`, { signal: AbortSignal.timeout(10_000) });
      console.log('  ✓ re-pinned + resumed');
    } catch (e) { console.warn(`  resync: ${e.message}`); }
  }
}

// ── Gatus heartbeat (no-op unless that endpoint is configured) ─────────────────
async function sendHeartbeat(pushUrl, token, success, label) {
  if (!pushUrl || !token) return;
  try {
    const url = /[?&]success=/.test(pushUrl)
      ? pushUrl.replace(/([?&]success=)[^&]*/, `$1${success}`)
      : pushUrl + (pushUrl.includes('?') ? '&' : '?') + `success=${success}`;
    const res = await fetch(url, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
    });
    console.log(`Heartbeat ${label}=${success}: ${res.ok ? 'sent' : `HTTP ${res.status}`}`);
  } catch (e) { console.warn(`Heartbeat ${label} failed: ${e.message}`); }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Overlap guard: a hung cloud call plus the 15-min cron could otherwise stack two
  // runs racing on the same gallery. A lock older than 10 min is treated as stale.
  if (fs.existsSync(LOCK_FILE)) {
    const ageMs = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
    if (ageMs < 10 * 60_000) {
      console.log(`Another meural-push run is active (lock ${Math.round(ageMs / 1000)}s old) — exiting.`);
      return;
    }
    console.warn(`Stale lock (${Math.round(ageMs / 1000)}s old) — overriding.`);
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));

  let snapPaths = [];
  try {
    console.log(`=== Meural Push (${COUNT} shots) ===\n`);

    console.log('Authenticating...');
    const token = await getToken();
    console.log('✓ Authenticated\n');

    // Pin display durations so the postcard holds (no 60s revert). Idempotent.
    // NOTE: the frame only applies a changed previewDuration at its NEXT boot — a
    // sync isn't enough and the device API readback always shows the saved value, so
    // this can't be verified from here. A frame must be power-cycled once after the
    // value first changes; thereafter this keeps it pinned against drift.
    console.log('Pinning display durations...');
    await setHoldDurations(token);
    console.log();

    snapPaths = await takeScreenshots(COUNT);
    console.log();

    // Cloud gallery work runs NIGHTLY ONLY (the 22:00 tick, or a manual `resync` arg).
    // The Dashboard gallery is assigned to both devices, so every cloud item add/delete
    // pushes a sync event that kicks the frame out of the postcard preview and back to
    // gallery art until the next cron tick — per-run uploads meant random old photos
    // popping up all day (surfaced 2026-07-03, the day Meural's /items recovered; the
    // outage had been masking it). One backup upload a day is plenty: the postcard is
    // the display, the gallery is history. cloudOk: null = not probed this run.
    let cloudOk = null;
    let galleryId, oldItemIds;
    if (RESYNC) {
      ({ galleryId, oldItemIds } = await prepareGallery(token));
      console.log();

      // Meural's backend 500'd on every real image 6/15–7/3. Treat the FIRST upload as
      // a probe: one failure = cloud is down, stop and let the postcard carry the run.
      console.log('Probing cloud upload (1 failure → fall back to postcard)...');
      let uploaded = 0;
      for (let i = 0; i < snapPaths.length; i++) {
        try {
          const itemId = await uploadItem(token, snapPaths[i], `[${i + 1}/${snapPaths.length}]`);
          await fetch(`${API_BASE}/galleries/${galleryId}/items/${itemId}`, {
            method: 'POST', headers: headers(token), signal: AbortSignal.timeout(API_TIMEOUT),
          }).catch((e) => console.warn(`  add to gallery: ${e.message}`));
          uploaded++;
        } catch (e) {
          console.warn(`  cloud upload failed → postcard fallback: ${e.message.slice(0, 70)}`);
          break;   // one failure = cloud down; don't hammer the remaining shots
        }
      }
      cloudOk = uploaded > 0;
      console.log(cloudOk
        ? `✓ cloud is UP — ${uploaded} item(s) in gallery`
        : '⚠ cloud down (Meural 500) — postcard is carrying the dashboard this run');
    }

    // Postcard is the live display (always, cloud-independent). # frames that took it.
    const delivered = await pushToDevices(snapPaths[0]);
    const framesOk = delivered === mc.devices.length;
    console.log(`\nFrames delivered: ${delivered}/${mc.devices.length}${framesOk ? '' : '  ⚠ a frame did NOT take the postcard'}`);

    // Cloud gallery housekeeping only on probe runs where the cloud was actually up.
    // (These add/delete/sync events pop the frames off the postcard preview — fine
    // once a night at 22:00, when resync re-pins to the just-uploaded fresh image.)
    if (cloudOk) {
      await clearOldItems(token, oldItemIds);
      await resyncDevices(token, galleryId);
    }

    console.log('\n=== Done ===');

    // TWO independent signals (peer-review recommendation):
    //  • framesOk → PRIMARY: did the dashboard actually reach the frames this run?
    //              Green even while Meural's cloud is broken. Post to gatus.framesPushUrl.
    //  • cloudOk  → "is Meural's upload path working?" watch — only probed on the
    //              nightly run now, so it posts once a day (Gatus window is 26h).
    // Each is a no-op until its endpoint is set in config.js, so this is backward-compatible.
    await sendHeartbeat(gatusCfg?.framesPushUrl, gatusCfg?.token, framesOk, 'framesOk');
    if (cloudOk !== null) await sendHeartbeat(gatusCfg?.pushUrl, gatusCfg?.token, cloudOk, 'cloudOk');
  } finally {
    for (const p of snapPaths) { try { fs.unlinkSync(p); } catch { /* already gone */ } }
    try { fs.unlinkSync(LOCK_FILE); } catch { /* already gone */ }
  }
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
