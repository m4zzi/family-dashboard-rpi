#!/usr/bin/env node
// meural-push.js — Clean up Dashboard gallery and push one fresh portrait screenshot
// Usage: node meural-push.js
// Requires: npm install puppeteer --save-dev  (first run only)
'use strict';

const path = require('path');
const fs   = require('fs');
const { meural: mc, gatus: gatusCfg } = require('./config');

const COGNITO_URL     = `https://cognito-idp.${mc.cognitoRegion}.amazonaws.com/`;
const API_BASE        = 'https://api.meural.com/v0';
const PORTRAIT_URL    = (mc.portraitUrl || 'http://localhost:3000') + '/portrait.html';
const COUNT           = parseInt(process.argv[2]) || 6;
const SNAPSHOT_DIR    = __dirname;
const snapshotPath    = (i) => path.join(SNAPSHOT_DIR, `_meural-snapshot-${i}.jpg`);
const sleep           = (ms) => new Promise((r) => setTimeout(r, ms));

// Nightly full resync: the last cron run of the day (local hour 22 — schedule is
// `0 5-22 * * *`) purges + re-pulls each frame's LOCAL gallery cache. Frames can
// silently stop honoring cloud item-deletes and hoard stale local snapshots — one
// wedged a frame on a 3-week-old image while the cloud gallery was perfectly
// current, and neither a reboot nor a gallery-bounce cleared it. Force manually
// with a `resync` arg:  node meural-push.js 6 resync
const NIGHTLY_RESYNC_HOUR = 22;
const RESYNC          = process.argv.slice(2).includes('resync') || new Date().getHours() === NIGHTLY_RESYNC_HOUR;

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
  const res = await fetch(`${API_BASE}${p}`, { headers: headers(token) });
  if (!res.ok) throw new Error(`GET ${p}: ${res.status}`);
  return (await res.json()).data;
}

async function apiPost(token, p, body) {
  const isForm = body instanceof FormData;
  const res = await fetch(`${API_BASE}${p}`, {
    method: 'POST',
    headers: headers(token, isForm ? {} : { 'content-type': 'application/json' }),
    body: isForm ? body : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${p}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function apiDelete(token, p) {
  const res = await fetch(`${API_BASE}${p}`, { method: 'DELETE', headers: headers(token) });
  // 404 = already gone, that's fine
  if (!res.ok && res.status !== 404) throw new Error(`DELETE ${p}: ${res.status}`);
}

// ── Gallery: find/create, remove duplicates, collect existing item IDs ────────
async function prepareGallery(token) {
  const all = await apiGet(token, '/user/galleries?count=1000');
  const matches = all.filter(g => g.name === mc.galleryName);

  if (matches.length > 1) {
    console.log(`Found ${matches.length} "${mc.galleryName}" galleries — removing duplicates`);
    for (const g of matches.slice(1)) {
      await apiDelete(token, `/galleries/${g.id}`);
      console.log(`  deleted gallery ${g.id}`);
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
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
  const { data } = await res.json();
  console.log(`  ${label} → item id: ${data.id}`);
  return data.id;
}

// ── Assign gallery to devices + local postcard ────────────────────────────────
async function pushToDevices(token, galleryId, postcardPath) {
  for (const device of mc.devices) {
    console.log(`\n--- ${device.name} (id: ${device.id}) ---`);

    try {
      await fetch(`${API_BASE}/devices/${device.id}/galleries/${galleryId}`, {
        method: 'POST', headers: headers(token),
      });
      console.log(`  ✓ Gallery ${galleryId} assigned`);
    } catch (e) { console.warn(`  assign: ${e.message}`); }

    try {
      await fetch(`${API_BASE}/devices/${device.id}/sync`, {
        method: 'POST', headers: headers(token),
      });
      console.log('  ✓ Sync triggered');
    } catch (e) { console.warn(`  sync: ${e.message}`); }

    // Postcard = first snapshot, shows immediately on the frame
    try {
      const form = new FormData();
      form.append('photo', new Blob([fs.readFileSync(postcardPath)], { type: 'image/jpeg' }), 'dashboard.jpg');
      const res = await fetch(`http://${device.ip}/remote/postcard`, {
        method: 'POST', body: form, signal: AbortSignal.timeout(8_000),
      });
      console.log(`  ✓ Postcard: ${res.ok ? 'showing now' : `HTTP ${res.status}`}`);
    } catch (e) { console.warn(`  postcard: ${e.message}`); }

    // Pin the frame to the Dashboard gallery and resume playback. Postcards are
    // only a temporary override; without this the frame's slideshow can drift
    // back to other galleries (Sampler, Kids, Recents) or replay stale cached
    // Dashboard items after a wifi blip. change_gallery forces a re-pull.
    try {
      await fetch(`http://${device.ip}/remote/control_command/change_gallery/${galleryId}`, {
        signal: AbortSignal.timeout(10_000),
      });
      await fetch(`http://${device.ip}/remote/control_command/resume`, {
        signal: AbortSignal.timeout(10_000),
      });
      console.log(`  ✓ Pinned to gallery ${galleryId}`);
    } catch (e) { console.warn(`  pin: ${e.message}`); }
  }
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
      await apiDelete(token, `/devices/${device.id}/galleries/${galleryId}`);
      await fetch(`${API_BASE}/devices/${device.id}/sync`, { method: 'POST', headers: headers(token) });
      console.log('  ✓ gallery removed + purge sync');
      await sleep(8_000);   // let the frame act on the removal before re-adding
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

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`=== Meural Push (${COUNT} shots) ===\n`);

  console.log('Authenticating...');
  const token = await getToken();
  console.log('✓ Authenticated\n');

  const { galleryId, oldItemIds } = await prepareGallery(token);
  console.log();

  const snapPaths = await takeScreenshots(COUNT);
  console.log();

  console.log(`Uploading ${snapPaths.length} image(s)...`);
  for (let i = 0; i < snapPaths.length; i++) {
    const itemId = await uploadItem(token, snapPaths[i], `[${i + 1}/${snapPaths.length}]`);
    try {
      await fetch(`${API_BASE}/galleries/${galleryId}/items/${itemId}`, {
        method: 'POST', headers: headers(token),
      });
    } catch (e) { console.warn(`  add to gallery: ${e.message}`); }
  }
  console.log('✓ All items in gallery');

  await pushToDevices(token, galleryId, snapPaths[0]);

  // Delete old items now that new content is live — if we fail before this
  // point, old items remain in the gallery so frames never go blank.
  await clearOldItems(token, oldItemIds);

  // Last run of the night: force frames to purge + re-pull their local cache so
  // they can't drift into hoarding stale snapshots (see resyncDevices comment).
  if (RESYNC) await resyncDevices(token, galleryId);

  // Clean up local snapshot files
  for (const p of snapPaths) fs.unlinkSync(p);

  console.log('\n=== Done ===');

  // Success-only monitoring heartbeat (optional `gatus` block in config.js).
  // Reached only when the whole push completed — a failed run skips it, and the
  // monitor's heartbeat window flags the silence.
  if (gatusCfg?.pushUrl && gatusCfg?.token) {
    try {
      const res = await fetch(gatusCfg.pushUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${gatusCfg.token}` },
        signal: AbortSignal.timeout(10_000),
      });
      console.log(`Monitoring heartbeat: ${res.ok ? 'sent' : `HTTP ${res.status}`}`);
    } catch (e) { console.warn(`Monitoring heartbeat failed: ${e.message}`); }
  }
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
