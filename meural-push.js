#!/usr/bin/env node
// meural-push.js — Clean up Dashboard gallery and push one fresh portrait screenshot
// Usage: node meural-push.js
// Requires: npm install puppeteer --save-dev  (first run only)
'use strict';

const path = require('path');
const fs   = require('fs');
const { meural: mc } = require('./config');

const COGNITO_URL     = `https://cognito-idp.${mc.cognitoRegion}.amazonaws.com/`;
const API_BASE        = 'https://api.meural.com/v0';
const PORTRAIT_URL    = (mc.portraitUrl || 'http://localhost:3000') + '/portrait.html';
const COUNT           = parseInt(process.argv[2]) || 6;
const SNAPSHOT_DIR    = __dirname;
const snapshotPath    = (i) => path.join(SNAPSHOT_DIR, `_meural-snapshot-${i}.jpg`);

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

// ── Gallery: find/create, remove duplicates, clear items ─────────────────────
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

  // Clear existing items so the gallery only ever has our fresh screenshots
  try {
    const items = await apiGet(token, `/galleries/${galleryId}/items?count=1000`);
    if (items && items.length > 0) {
      console.log(`Removing ${items.length} existing item(s)...`);
      for (const item of items) {
        await apiDelete(token, `/items/${item.id}`).catch(e => console.warn(`  item ${item.id}: ${e.message}`));
      }
    } else {
      console.log('Gallery is empty — nothing to clear');
    }
  } catch (e) {
    console.warn('Could not list gallery items:', e.message);
  }

  return galleryId;
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
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`=== Meural Push (${COUNT} shots) ===\n`);

  console.log('Authenticating...');
  const token = await getToken();
  console.log('✓ Authenticated\n');

  const galleryId = await prepareGallery(token);
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

  // Clean up local snapshot files
  for (const p of snapPaths) fs.unlinkSync(p);

  console.log('\n=== Done ===');
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
