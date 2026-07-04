# Meural push — operations runbook

How the family dashboard gets onto the two Meural Canvas II frames, and what to do when a frame shows the wrong thing. (Architecture/code lives in `meural-push.js`; this is the *operational* guide.)

> **State as of 2026-07-03:** Meural's cloud image-upload **recovered** (was broken 6/15–7/3, see mode #2). The display is still the **local postcard** — by design, not as a workaround. Cloud gallery work (upload + cleanup + resync) now runs **nightly only**: the day the cloud recovered, per-run uploads/deletes pushed sync events that kicked the frames out of the postcard preview and back to random gallery art every 15 min (mode #4). Rooting the frames to go fully cloud-free was attempted and **abandoned — every vector is locked** (see `MEURAL-REPURPOSE.md`).

## The setup

- **Script:** `~/family-display/meural-push.js` on the Pi (`coffee-display`, `192.168.2.164`), run **every 15 min** by pm2 cron `*/15 5-22 * * *` (5 AM–10 PM). Manual: `ssh coffee-display "cd ~/family-display && node meural-push.js"` (optional arg = screenshot count, default **1**).
- **Frames** — on the **IOT subnet `192.168.3.x`**. Verified 2026-06-18 against UniFi: this network's `firewall_zone_id` is the **Internal** zone (same as the `.2` LAN), `network_isolation_enabled: false` — so it is **NOT firewall-isolated** and is reachable from any internal host (Mac or Pi). The Pi is just where the cron happens to run. *(Earlier docs wrongly said "only from the Pi" — there was never a Pi-specific rule. TODO/low-priority: actually isolate `.3` from `.2` with a dedicated zone.)*

  | Frame | Model | IP | device id |
  |---|---|---|---|
  | whistler-341 | Canvas II 27" birch | `192.168.3.59` | 44255 |
  | tissot-913 | Canvas II 21" walnut ("the small one") | `192.168.3.151` | 41840 |

- **Meural cloud API:** `https://api.meural.com/v0` (AWS Cognito auth). Creds + device list in `config.js` (gitignored) under the `meural` block. The "Dashboard" gallery id is looked up by name each run (it's been recreated, so don't hardcode it).

## Monitoring (Gatus)

Defined in the **observability** repo, `observability/gatus/config.yaml` — three endpoints, all in the `fyi` group. The two heartbeats are *pushed* by `meural-push.js` each run (the script POSTs `success=…` to the gatus push URLs held in `config.js` → `gatus` block: `framesPushUrl`, `pushUrl`, `token`; auth `GATUS_TOKEN_MEURAL` on the gatus side).

| Gatus endpoint | Type | Interval | Green means | Red means |
|---|---|---|---|---|
| `meural-pi` | ICMP `192.168.2.164` | 5m | Pi is up | Pi offline / IP drift |
| `meural-frames` | push heartbeat (`framesOk`) | 1h | **PRIMARY** — the postcard reached **both** frames this run. Green *even while the cloud is down.* | A frame didn't take the postcard, **or** total silence (~4 missed `*/15` pushes ⇒ Pi/script dead) |
| `meural-push` | push heartbeat (`cloudOk`) | 26h | Meural's `/items` upload path healthy | Meural cloud 500ing (their side — *not* a real fault; check `meural-frames` for true dashboard health) **or** total silence. Pushed **once nightly** (the 22:00 cloud run), hence the 26h window. |

**Read it as:** `meural-frames` is the real "is the dashboard alive" signal; `meural-push` is just the "is Meural's cloud working" watch. A local `GET /remote/identify/` probe (no cloud, no auth) could later be added to catch a frame that's network-up but web-server-wedged — the ICMP check can't see that.

## Delivery — the key mental model

| Path | How | State |
|---|---|---|
| **Postcard (PRIMARY)** | `POST http://<frame-ip>/remote/postcard` → local API, no cloud, no size limit | The live display. **Persists** because `previewDuration` is pinned to 24h (see below); repainted every run. |
| **Cloud gallery (nightly backup / fallback)** | `POST /items` → add to gallery → device sync — **22:00 run only** (or a manual `resync` arg) | One fresh upload a day + full frame resync; the frames' *current gallery* is pinned to "Dashboard," so if a frame ever drops the preview, the fallback is a (≤24h-old) dashboard image, not random art. **Never per-run:** cloud item churn syncs to the frames and pops them out of the postcard preview (mode #4). |

**Why the postcard persists now:** a postcard is shown as a "preview," and the device setting `previewDuration` (default **60 s**) is how long before it reverts. We `PUT /devices/{id}` to set `previewDuration` / `imageDuration` / `overlayDuration` to **86400** (24h). `meural-push.js` re-pins these every run (idempotent). **Caveat: a changed `previewDuration` only takes effect at the frame's NEXT boot** — a sync isn't enough, and the API readback always shows the *saved* value, so it can't be verified from the script. After first setting it, **power-cycle each frame once**. Status: whistler-341 done (holds 24h); **tissot-913 still pending as of 2026-07-03** (reverts after ~60 s — but now reverts to the Dashboard gallery, so it still shows a dashboard image).

## Four failure modes — diagnose which one

### 1. Frame stuck on a WEEKS-old image; reboot + power-cycle don't fix it; cloud looks current
The frame's **local cache is wedged** — hoarding stale items and cycling its own junk. (Mostly moot now that the postcard overlays everything, but can surface if the postcard ever fails.)
**Confirm** local item count exceeds the cloud gallery's, then **fix** with a full purge + re-pull (only works when the cloud is up):
```bash
ssh coffee-display "cd ~/family-display && node meural-push.js 6 resync"
```
The nightly 22:00 run does this automatically — but only when the cloud is healthy. *(Hit tissot-913 2026-06-12, frozen ~3 weeks.)*

### 2. Frames stale + a manual push prints `cloud down (Meural 500)`
**Meural's cloud upload API is broken — their side.** `POST /items` returns a bare `nginx/1.25.5` 500 while Cognito auth + `GET /user` + `PUT /devices/{id}` settings all return 200 (auth/account/read/settings fine — only image ingestion is broken). **Not our code** — the official app fails identically, with matching 2025–26 NETGEAR-community reports.

**What we know about the cause (2026-06-18, via `meural-diag.js` + exact-size probes):** failure is **request-size-correlated**. Cognito auth and `GET /user` are 200, a 774 B 1x1 JPEG uploads with 201, and real 1080x1920 JPEGs from ~34 KB up return a bare `nginx/1.25.5` 500. An exact-size invalid-JPEG probe returned normal JSON validation errors through 15 KB, then flipped to the same nginx 500 at 16 KB+, which strongly suggests a size-sensitive gateway/upstream failure before the app's normal image validation. It is *not* dashboard rendering, auth, account access, or local frame networking. **Mechanism uncertain:** a bare 500 (not a 413) plus the outage being intermittent argue against a clean static `client_max_body_size` response and point to a flaky / size-sensitive upstream such as thumbnailing or ingestion. Either way there's no compression workaround — a legible dashboard is far over the threshold.

**This is handled, and the dashboard stays current anyway:** the postcard (primary path) carries it, persisting via the 24h `previewDuration`. The run logs `cloud down … postcard is carrying the dashboard`, delivers the postcard, and reports `framesOk`. The gallery/cloud auto-resumes if Meural's `/items` ever returns 201 again.
```bash
ssh coffee-display "cd ~/family-display && node meural-push.js 1 resync"   # plain runs skip the cloud
# "✓ cloud is UP …"     → cloud healthy (nightly gallery backup working)
# "⚠ cloud down (500)"  → down again (postcard carrying it — frames still current)
```
*(Broke ~2026-06-15 19:00; recovered by 2026-07-03. Note: the recovery check now needs the `resync` arg — plain runs don't touch the cloud.)*

### 3. Stale date/weather, but the run says `=== Done ===` / `Frames delivered: 2/2`
The **dashboard server** (`family-display` pm2) or the Puppeteer screenshot is failing (look for `Navigation timeout` / `data-ready timeout`). A blank/spinner screenshot can still be delivered successfully.
```bash
ssh coffee-display "pm2 logs family-display --lines 30 --nostream"
ssh coffee-display "curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/portrait.html"   # want 200
```

### 4. Random old photos / stock art keep popping up between pushes (cloud is UP)
**Cloud item churn is interrupting the postcard preview.** Any cloud gallery add/delete/sync pushes an event to the frames that drops them out of the preview and back to their current gallery until the next push — if that gallery is "Recents" (tracks every account upload) the frame shows *your past uploads*, seemingly at random. Surfaced 2026-07-03, the day Meural's `/items` recovered: the outage had been masking it, because the per-run upload probe failed before any churn happened. **Fix (now built in):** all cloud work is gated to the nightly 22:00 run; */15 runs are postcard-only. If this recurs, check nothing else is writing to the Meural account during the day, and that the frames' current gallery is "Dashboard" (`GET /remote/get_gallery_status_json/` → `current_gallery_name`).

## What the script does each run (`main()`)
Every */15 run (postcard-only — no cloud gallery traffic, see mode #4):
1. **Pin durations** (`setHoldDurations`, idempotent PUT) so the postcard holds.
2. **One screenshot** of `/portrait.html`.
3. **Postcard both frames** = the live display. Tracks `framesOk` (every frame took it).
4. **Heartbeat** `framesOk` → primary "did the dashboard reach the frames" signal.
5. A **lockfile** prevents a hung run from overlapping the next 15-min tick.

The 22:00 run (or a manual `resync` arg) additionally does the cloud work, sandwiched around the postcard:
- **Probe the cloud upload** — on the *first* 500 it breaks and falls back (no hammering; this is how the 6/15–7/3 outage was ridden out). Success ⇒ `cloudOk`.
- **Cleanup** (delete yesterday's gallery item) + **full resync** (purge each frame's local cache, re-attach the Dashboard gallery, `change_gallery` + `resume`) — so the frames' fallback gallery is always the latest nightly dashboard image. The purge DELETE is best-effort (400 = gallery wasn't attached, e.g. after a long outage — skip straight to re-add).
- **Heartbeat** `cloudOk` → "is Meural's cloud working" watch (only posted on probe runs; Gatus window is 26h).

## Pre-flight (if a push misbehaves)
```bash
ping -c2 -W2 192.168.2.164                                   # Pi up?
ssh coffee-display "ping -c1 -W2 192.168.3.59 && ping -c1 -W2 192.168.3.151"   # frames up? (from Pi)
ssh coffee-display "curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/portrait.html"   # dashboard 200?
```
If a frame won't hold the postcard (reverts after ~60 s), it hasn't been power-cycled since `previewDuration` was set — **power-cycle it once**.
