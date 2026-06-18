// One-off diagnostic: capture the EXACT response Meural's /items returns.
// Auths like meural-push.js, then POSTs a real-sized JPEG and a 1x1 pixel,
// dumping status + telling headers + body. Read-API check proves auth is fine.
const fs = require('fs');
const { meural: mc } = require('./config');
const COGNITO_URL = `https://cognito-idp.${mc.cognitoRegion}.amazonaws.com/`;
const API_BASE = 'https://api.meural.com/v0';

async function getToken() {
  const res = await fetch(COGNITO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth' },
    body: JSON.stringify({ AuthFlow: 'USER_PASSWORD_AUTH', ClientId: mc.cognitoClientId, AuthParameters: { USERNAME: mc.email, PASSWORD: mc.password } }),
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status} ${await res.text()}`);
  return (await res.json()).AuthenticationResult.AccessToken;
}

function dumpHeaders(res) {
  const keep = ['server', 'via', 'cf-ray', 'x-amzn-requestid', 'x-amz-cf-id', 'x-cache', 'content-type', 'x-amzn-errortype', 'date'];
  const out = {};
  for (const k of keep) { const v = res.headers.get(k); if (v) out[k] = v; }
  return out;
}

async function tryUpload(token, path, label) {
  const bytes = fs.readFileSync(path);
  const form = new FormData();
  form.append('image', new Blob([bytes], { type: 'image/jpeg' }), 'dashboard.jpg');
  const t0 = Date.now();
  const res = await fetch(`${API_BASE}/items`, { method: 'POST', headers: { Authorization: `Token ${token}`, 'x-meural-api-version': '3' }, body: form });
  const body = await res.text();
  console.log(`\n=== ${label} (${bytes.length} bytes) → ${Date.now() - t0}ms ===`);
  console.log(`HTTP ${res.status} ${res.statusText}`);
  console.log('headers:', JSON.stringify(dumpHeaders(res)));
  console.log('body:', body.slice(0, 900));
}

async function tryUploadBrief(token, path, label) {
  const bytes = fs.readFileSync(path);
  const form = new FormData();
  form.append('image', new Blob([bytes], { type: 'image/jpeg' }), 'dashboard.jpg');
  const t0 = Date.now();
  const res = await fetch(`${API_BASE}/items`, { method: 'POST', headers: { Authorization: `Token ${token}`, 'x-meural-api-version': '3' }, body: form });
  const body = await res.text();
  const ms = Date.now() - t0;
  const tag = res.status === 201 ? '✓' : '✗';
  console.log(`${tag} ${label.padEnd(22)} ${String(bytes.length).padStart(8)}B  HTTP ${res.status} (${ms}ms)  ${res.status !== 201 ? body.slice(0, 200).replace(/\s+/g, ' ') : ''}`);
}

(async () => {
  const token = await getToken();
  console.log('✓ Cognito auth OK (token acquired)');
  const u = await fetch(`${API_BASE}/user`, { headers: { Authorization: `Token ${token}`, 'x-meural-api-version': '3' } });
  console.log(`GET /user → HTTP ${u.status}\n`);
  // Upload every /tmp/diag-*.jpg in ascending size order — brackets the failure threshold.
  const files = fs.readdirSync('/tmp').filter(f => /^diag-.*\.jpg$/.test(f)).map(f => `/tmp/${f}`)
    .sort((a, b) => fs.statSync(a).size - fs.statSync(b).size);
  for (const f of files) await tryUploadBrief(token, f, f.replace('/tmp/diag-', '').replace('.jpg', ''));
})().catch(e => { console.error('DIAG ERROR:', e.message); process.exit(1); });
