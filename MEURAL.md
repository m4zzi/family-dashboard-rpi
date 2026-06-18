# Meural push — operations runbook

How the family dashboard gets onto the two Meural Canvas II frames, and what to do when a frame shows the wrong thing. (Architecture/code lives in `meural-push.js`; this is the *operational* guide.)

> **State as of 2026-06-18:** Meural's cloud image-upload is broken (their side, see mode #2). The dashboard is delivered entirely by the **local postcard**, which now *persists* because we pinned the frames' `previewDuration` to 24h. Rooting the frames to go fully cloud-free was attempted and **abandoned — every vector is locked** (see `MEURAL-REPURPOSE.md`).

## The setup

- **Script:** `~/family-display/meural-push.js` on the Pi (`coffee-display`, `192.168.2.164`), run **every 15 min** by pm2 cron `*/15 5-22 * * *` (5 AM–10 PM). Manual: `ssh coffee-display "cd ~/family-display && node meural-push.js"` (optional arg = screenshot count, default **1**).
- **Frames** — on the **IOT subnet `192.168.3.x`**. Verified 2026-06-18 against UniFi: this network's `firewall_zone_id` is the **Internal** zone (same as the `.2` LAN), `network_isolation_enabled: false` — so it is **NOT firewall-isolated** and is reachable from any internal host (Mac or Pi). The Pi is just where the cron happens to run. *(Earlier docs wrongly said "only from the Pi" — there was never a Pi-specific rule. TODO/low-priority: actually isolate `.3` from `.2` with a dedicated zone.)*

  | Frame | Model | IP | device id |
  |---|---|---|---|
  | whistler-341 | Canvas II 27" birch | `192.168.3.59` | 44255 |
  | tissot-913 | Canvas II 21" walnut ("the small one") | `192.168.3.151` | 41840 |

- **Meural cloud API:** `https://api.meural.com/v0` (AWS Cognito auth). Creds + device list in `config.js` (gitignored) under the `meural` block. The "Dashboard" gallery id is looked up by name each run (it's been recreated, so don't hardcode it).

## Delivery — the key mental model

| Path | How | State |
|---|---|---|
| **Postcard (PRIMARY)** | `POST http://<frame-ip>/remote/postcard` → local API, no cloud, no size limit | The live display. **Persists** because `previewDuration` is pinned to 24h (see below); repainted every run. |
| **Cloud gallery (dormant backup)** | `POST /items` → add to gallery → device sync | The *intended* path, but **broken** (mode #2). We still try one upload per run to detect recovery + keep the gallery populated, but it is **not** what's shown. |

**Why the postcard persists now:** a postcard is shown as a "preview," and the device setting `previewDuration` (default **60 s**) is how long before it reverts. We `PUT /devices/{id}` to set `previewDuration` / `imageDuration` / `overlayDuration` to **86400** (24h) — the settings API works even though image-upload is broken. `meural-push.js` re-pins these every run (idempotent). **Caveat: a changed `previewDuration` only takes effect at the frame's NEXT boot** — a sync isn't enough, and the API readback always shows the *saved* value, so it can't be verified from the script. After first setting it, **power-cycle each frame once**; both have been done.

## Three failure modes — diagnose which one

### 1. Frame stuck on a WEEKS-old image; reboot + power-cycle don't fix it; cloud looks current
The frame's **local cache is wedged** — hoarding stale items and cycling its own junk. (Mostly moot now that the postcard overlays everything, but can surface if the postcard ever fails.)
**Confirm** local item count exceeds the cloud gallery's, then **fix** with a full purge + re-pull (only works when the cloud is up):
```bash
ssh coffee-display "cd ~/family-display && node meural-push.js 6 resync"
```
The nightly 22:00 run does this automatically — but only when the cloud is healthy. *(Hit tissot-913 2026-06-12, frozen ~3 weeks.)*

### 2. Frames stale + a manual push prints `cloud down (Meural 500)`
**Meural's cloud upload API is broken — their side.** `POST /items` returns a bare `nginx/1.25.5` 500 while Cognito auth + `GET /user` + `PUT /devices/{id}` settings all return 200 (auth/account/read/settings fine — only image ingestion is broken). **Not our code** — the official app fails identically, with matching 2025–26 NETGEAR-community reports.

**What we know about the cause (2026-06-18, via `meural-diag.js`):** failure is **byte-size-correlated** — at a fixed 1080×1920, a 12 KB image uploads (201) but 24 KB+ 500s; a 270 KB screenshot 500s. It is *not* pixel-count and *not* decode-complexity. **Mechanism uncertain:** a bare 500 (not a 413) plus the outage being *intermittent* argue against a static nginx `client_max_body_size` and point to a flaky / size-sensitive upstream (a thumbnailer or worker failing on larger payloads). Either way there's no compression workaround — a legible dashboard is far over the threshold.

**This is handled, and the dashboard stays current anyway:** the postcard (primary path) carries it, persisting via the 24h `previewDuration`. The run logs `cloud down … postcard is carrying the dashboard`, delivers the postcard, and reports `framesOk`. The gallery/cloud auto-resumes if Meural's `/items` ever returns 201 again.
```bash
ssh coffee-display "cd ~/family-display && node meural-push.js"
# "✓ cloud is UP …"     → Meural recovered (gallery uploads resume)
# "⚠ cloud down (500)"  → still down (postcard carrying it — frames still current)
```
*(Broke ~2026-06-15 19:00.)*

### 3. Stale date/weather, but the run says `=== Done ===` / `Frames delivered: 2/2`
The **dashboard server** (`family-display` pm2) or the Puppeteer screenshot is failing (look for `Navigation timeout` / `data-ready timeout`). A blank/spinner screenshot can still be delivered successfully.
```bash
ssh coffee-display "pm2 logs family-display --lines 30 --nostream"
ssh coffee-display "curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/portrait.html"   # want 200
```

## What the script does each run (`main()`)
1. **Pin durations** (`setHoldDurations`, idempotent PUT) so the postcard holds.
2. **One screenshot** of `/portrait.html`.
3. **Probe the cloud upload** — on the *first* 500 it breaks and falls back (no hammering). Success ⇒ `cloudOk`, gallery kept populated as a backup; the script never switches the frame to the gallery (doing so raced the postcard and could pin a stale image for 24h — removed 2026-06-18 after peer review).
4. **Postcard both frames** = the live display. Tracks `framesOk` (every frame took it).
5. **Heartbeats (two, each optional):** `framesOk` → primary "did the dashboard reach the frames" signal (green even while the cloud is down); `cloudOk` → "is Meural fixed yet?" watch (stays red during the outage). `framesOk` only fires if `gatus.framesPushUrl` is configured.
6. A **lockfile** prevents a hung run from overlapping the next 15-min tick.

## Pre-flight (if a push misbehaves)
```bash
ping -c2 -W2 192.168.2.164                                   # Pi up?
ssh coffee-display "ping -c1 -W2 192.168.3.59 && ping -c1 -W2 192.168.3.151"   # frames up? (from Pi)
ssh coffee-display "curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/portrait.html"   # dashboard 200?
```
If a frame won't hold the postcard (reverts after ~60 s), it hasn't been power-cycled since `previewDuration` was set — **power-cycle it once**.
