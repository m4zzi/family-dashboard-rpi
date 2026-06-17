# Meural push — operations runbook

How the family dashboard gets onto the two Meural Canvas II frames, and what to do when a frame shows the wrong thing. (Architecture/code lives in `meural-push.js`; this is the *operational* guide.)

## The setup

- **Script:** `~/family-display/meural-push.js` on the Pi (`coffee-display`, `192.168.2.164`), run hourly by pm2 cron `0 5-22 * * *` (5 AM–10 PM). Manual: `ssh coffee-display "cd ~/family-display && node meural-push.js 6"` (arg = screenshot count).
- **Frames** — on the **IOT VLAN `192.168.3.x`**, so reachable **only from the Pi**, not the Mac:

  | Frame | Model | IP | device id |
  |---|---|---|---|
  | whistler-341 | Canvas II 27" birch | `192.168.3.59` | 44255 |
  | tissot-913 | Canvas II 21" walnut ("the small one") | `192.168.3.151` | 41840 |

- **Dashboard gallery id:** `617125`. **Meural cloud API:** `https://api.meural.com/v0` (AWS Cognito auth). Creds + device list in `config.js` (gitignored) under the `meural` block.

## Two delivery paths (this is the key mental model)

| Path | How | Property |
|---|---|---|
| **Cloud gallery** | `POST /items` → add to gallery 617125 → frame syncs from cloud | **Persistent** (survives rotation) but depends on Meural's cloud — the **flaky** path |
| **Postcard** | `POST http://<frame-ip>/remote/postcard` | Straight to the frame's **local** API, **bypasses the cloud** — instant but a temporary override. The **reliable** path |

The hourly run does both: best-effort cloud upload (persistence) **+** always a postcard (the thing that actually shows current content).

## Three failure modes — diagnose which one

### 1. Frame stuck on a WEEKS-old image; reboot + power-cycle don't fix it; cloud looks current
The frame's **local cache is wedged** — it's hoarding stale items and cycling its own junk; the image it's stuck on no longer even exists in the cloud gallery.

**Confirm:** local item count exceeds the cloud gallery's (cloud has ~6; a wedged frame shows 20+):
```bash
ssh coffee-display "curl -s http://192.168.3.151/remote/get_frame_items_by_gallery_json/617125/ \
  | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get(\"response\",[])))'"
```
**Fix** — full purge + re-pull (a reboot can't touch local-cache rot):
```bash
ssh coffee-display "cd ~/family-display && node meural-push.js 6 resync"
```
…or the raw cloud-API cycle: `DELETE /devices/{id}/galleries/617125` → `POST /devices/{id}/sync` → re-add → sync. *(Hit tissot-913 on 2026-06-12, frozen ~3 weeks.)*

The **nightly 22:00 run** does this purge automatically (`NIGHTLY_RESYNC_HOUR`) to pre-empt recurrence — but only when the cloud is healthy.

### 2. All frames stale by a day or two + a manual push prints `Fatal: Upload failed: 500`
**Meural's cloud upload API is down — their side.** `POST /items` returns a 500 HTML gateway page for real images, while a 1×1 test pixel still returns 201 (so auth/account are fine; their image-ingestion backend is broken). **Not our code.**

**As of commit `9fcefc1` this is handled gracefully** — the run no longer Fatals; it logs `cloud upload … failed (continuing)`, delivers postcards, and skips the gallery re-pin (so frames stay current via postcard). Nothing to fix on our end; it auto-resumes when Meural recovers.

**Check if Meural recovered:**
```bash
ssh coffee-display "cd ~/family-display && node meural-push.js 1"
# ✓ N/N item(s) in gallery   → cloud is BACK (gallery uploads + cleanup + resync resume)
# ⚠ cloud upload unavailable  → still down (postcards only)
```
*(Broke ~2026-06-15 19:00.)*

### 3. Stale date/weather, but the run says `=== Done ===`
The **dashboard server** (`family-display` pm2) or the Puppeteer screenshot is failing (look for `Navigation timeout`).
```bash
ssh coffee-display "pm2 logs family-display --lines 30 --nostream"
ssh coffee-display "curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/portrait.html"   # want 200
```

## Resilience design (why a Meural cloud outage no longer blanks the frames)

`meural-push.js` `main()`:
1. **Best-effort cloud upload** — each item in a `try/catch`; a 500 logs and continues (never `process.exit`). Counts successes → `cloudOk`.
2. **Always `pushToDevices(..., cloudOk)`** — the postcard fires unconditionally (local path). The gallery assign + sync + re-pin run **only when `cloudOk`** — re-pinning to a stale gallery while the cloud is down would replace the fresh postcard with old content, so we don't.
3. **`clearOldItems` + nightly `resyncDevices`** run **only when `cloudOk`** — no point churning a stale gallery.

So: frames track the dashboard hourly via postcards through any Meural cloud outage, and full persistent gallery uploads auto-resume the moment `/items` returns 201 again.

## Pre-flight (if a push misbehaves)
```bash
ping -c2 -W2 192.168.2.164                                   # Pi up?
ssh coffee-display "ping -c1 -W2 192.168.3.59 && ping -c1 -W2 192.168.3.151"   # frames up? (from Pi)
ssh coffee-display "curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/portrait.html"   # dashboard 200?
```
Last resort for a single wedged frame: physical power-cycle (only helps mode #1 if the cache also gets cleared — usually the `resync` is the real fix).
