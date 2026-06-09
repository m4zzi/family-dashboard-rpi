// babycam.js — kitchen baby-camera overlay (KIOSK ONLY).
// Loads its config from /api/cameras; if that returns nothing, the feature stays
// dark (FAB hidden) — so a fresh clone without a `babycam` block in config.js shows
// nothing. This file is referenced only by index.html, never portrait.html, so the
// Meural snapshot pipeline can never capture the camera.

const overlay   = document.getElementById('babycamOverlay');
const stage     = document.getElementById('babycamStage');
const camsBox   = document.getElementById('babycamCams');
const loadingEl = document.getElementById('babycamLoading');
const timerEl   = document.getElementById('babycamTimer');
const muteBtn   = document.getElementById('babycamMute');
const extendBtn = document.getElementById('babycamExtend');
const closeBtn  = document.getElementById('babycamClose');
const fab       = document.getElementById('fabBabyCam');

let cfg = null;          // { port, autoCloseHours, cameras: [{id,label}] }
let vs = null;           // <video-stream> element (created lazily on first open)
let activeId = null;
let wantSound = true;    // default unmuted — audio is the point of a baby monitor
let closeAt = 0;
let tick = null;

async function init() {
  let r;
  try { r = await fetch('/api/cameras'); } catch { return; }
  if (!r.ok) return;
  try { cfg = await r.json(); } catch { return; }
  if (!cfg || !Array.isArray(cfg.cameras) || cfg.cameras.length === 0) return;

  cfg.cameras.forEach(cam => {
    const b = document.createElement('button');
    b.className = 'babycam-cam';
    b.textContent = cam.label;
    b.dataset.id = cam.id;
    b.addEventListener('click', e => { e.stopPropagation(); selectCam(cam.id); });
    camsBox.appendChild(b);
  });

  fab.hidden = false;
  fab.addEventListener('click', open);
  closeBtn.addEventListener('click', e => { e.stopPropagation(); close(); });
  muteBtn.addEventListener('click', e => { e.stopPropagation(); toggleMute(); });
  extendBtn.addEventListener('click', e => { e.stopPropagation(); extend(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !overlay.hidden) close(); });
}

function ensureStream() {
  if (vs) return vs;
  vs = document.createElement('video-stream');
  vs.mode = 'webrtc,mse';   // webrtc = low-latency + audio; mse fallback also carries audio
  vs.background = false;     // auto-disconnect when the overlay is hidden → go2rtc only pulls while watching
  stage.appendChild(vs);
  return vs;
}

const streamUrl = id => `ws://${location.hostname}:${cfg.port}/api/ws?src=${encodeURIComponent(id)}`;

function selectCam(id) {
  activeId = id;
  ensureStream();
  loadingEl.hidden = false;
  // Close any live socket/peer first — onconnect() bails while this.ws/this.pc
  // still exist, so without this a camera *switch* never opens the new stream.
  vs.ondisconnect();
  vs.src = streamUrl(id);                          // → onconnect() opens a fresh socket to the new camera
  camsBox.querySelectorAll('.babycam-cam').forEach(b => b.classList.toggle('active', b.dataset.id === id));
  applyAudio();                                   // attempt sound inside this tap gesture
  const v = vs.video;
  if (v) v.addEventListener('playing', () => { loadingEl.hidden = true; applyAudio(); }, { once: true });
}

function applyAudio() {
  if (!vs || !vs.video) return;
  vs.video.muted = !wantSound;
  if (wantSound) vs.video.play?.().catch(() => {});   // if blocked, plays muted; user taps unmute
  muteBtn.textContent = vs.video.muted ? '🔇' : '🔊';
}

function open() {
  overlay.hidden = false;
  closeAt = Date.now() + (cfg.autoCloseHours || 2) * 3600 * 1000;
  renderTimer();
  tick = setInterval(renderTimer, 1000);
  selectCam(activeId || cfg.cameras[0].id);
}

function close() {
  overlay.hidden = true;
  if (tick) { clearInterval(tick); tick = null; }
  if (vs) vs.ondisconnect();                        // stop the stream immediately (go2rtc drops the source)
}

function toggleMute() {
  wantSound = !wantSound;
  applyAudio();
}

function extend() { closeAt += 3600 * 1000; renderTimer(); }

function renderTimer() {
  const ms = closeAt - Date.now();
  if (ms <= 0) { close(); return; }
  const s = Math.floor(ms / 1000);
  timerEl.textContent = `auto-close ${Math.floor(s/3600)}:${String(Math.floor(s%3600/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}

init();
