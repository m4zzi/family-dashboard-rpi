# Meural local-control project — taking the frames off the cloud

> **STATUS 2026-06-18 — SHELVED; we did NOT need it.** Every rooting vector tried is locked (see "Outcome" below), and a **no-root fix won**: the local `/remote/postcard` endpoint + pinning `previewDuration` to 24h keeps the dashboard current with zero dependence on Meural's broken upload (see [`MEURAL.md`](MEURAL.md)). This doc is kept as the record + the plan if we ever revisit full cloud-independence. **Confirmed OS is Ubuntu 16.04** (not 14.04 as an early teardown report said).

**Goal (original):** drive the Meural panels with our own image, fully local, no Meural cloud — because their `POST /items` upload backend is broken (byte-size-correlated 500s; exact mechanism unproven — see [`MEURAL.md`](MEURAL.md) failure mode #2). It's a wound-down NETGEAR product; the cloud isn't getting fixed on any timeline we control.

## Outcome — every standard vector is locked
- **UART serial console:** works (115200, full boot log) but lands at an Ubuntu 16.04 `login:` with **unknown creds** (~40 combos incl. root/rock/linaro/firefly/meural/ubuntu all rejected).
- **U-Boot interrupt:** `bootdelay=0` and no `CONFIG_ZERO_BOOTDELAY_CHECK` — it prints "Hit any key" but never reads one. A pre-buffered key flood never stopped it.
- **MaskROM + `rkdeveloptool`:** fails on everything but "list devices" (signed-loader lock) — so even a **read/dump is blocked**, not just writes. Independently confirmed by another owner.
- **SD-card boot:** won't boot.

## If we ever revisit it (lower-effort first)
1. **CakePHP / `/remote` RCE (no hardware needed):** the local web stack is CakePHP + shell scripts on an old Ubuntu. Fuzz `/remote/*` for command injection (shell metachars in the `change_gallery` id, the postcard filename field) and known CakePHP CVEs. This is the cheapest try — pure software, no opening the case.
2. **eMMC ISP / chip-off (hardware):** secure boot stops at the kernel, not the ext4 rootfs — so bypass the SoC entirely: wire the eMMC CLK/CMD/DAT0/GND to a USB SD reader, mount the rootfs, edit `/etc/shadow`, write back. **Prerequisite we have NOT confirmed:** that those eMMC lines are exposed as probeable test points. If they're buried BGA, it's a full chip-off — a big difficulty jump.

**Two paths, try in this order:**
1. **Root the Meural's own Linux (non-destructive, BEST)** — it's a Rockchip RK3288 board running Ubuntu 16.04 with a framebuffer + local web server. Get a shell, disable the Meural app, run a tiny "show this JPEG on the framebuffer" loop fed by our existing `meural-push` screenshots. Keeps 100% of the hardware. ← **this doc**
2. **Gut + Pi (destructive, LAST resort)** — the panel is a **24-pin non-standard LVDS**, so this needs a driver board matched to a nonstandard panel (hard, maybe impossible to source cleanly). Only if rooting is truly dead.

Both paths run the **same software** (a framebuffer JPEG display fed by the dashboard renderer), so nothing is wasted whichever we land on.

---

## Hardware — what's confirmed vs. inherited from the teardown report
- **SoC:** Rockchip **RK3288** — **CONFIRMED 2026-06-18** by lifting the EMI shield on our unit (board rev `U121397 REV.0 GP 803219`); chip is marked `Rockchip RK3288`, flanked by 4 DDR3 chips, eMMC/`VP6014` nearby. Same SoC as the teardown, newer board rev. 3.3 V logic → Flipper-safe UART, no level shifter. MaskROM USB VID:PID = `2207:320b`; `rkdeveloptool ld` can see it, but loader/read commands are blocked. Console baud 115200.
- **OS / app:** our boot log shows **Ubuntu 16.04**. Earlier teardown notes reported Ubuntu 14.04 + a CakePHP/shell-script Meural app, so treat the app-stack detail as likely but not proven until we get filesystem access.
- **Two identical frames:** the rootfs image is likely the same across both (same model/firmware), so the twin is a useful reference for behavior — but each unit's MAC/serial/cloud-keys/calibration live in per-device storage, so don't clone a whole image unit-to-unit. Because USB readout is blocked, any future backup has to come from eMMC ISP/chip-off or a shell.
- **Two access doors, but neither yielded root on our units:**
  - **MaskROM mode** (USB): hold the **reset button** while plugging USB into a host → RK3288 enumerates in MaskROM (`2207:320b`), but signed-loader lock blocks loader upload and flash reads. Result: identification only, no backup/root.
  - **UART console**: TX/GND works at 115200 and shows the full boot log, but it lands at an Ubuntu 16.04 `login:` with unknown credentials; U-Boot cannot be interrupted because `bootdelay=0` and key input is ignored.
- **Panel:** 24-pin **non-standard LVDS** (why gut+Pi is the bad option).
- **Known brick trap:** flash fills with runaway syslog (a teardown unit had 3 GB of logs → boot loop / "Download failed!"). **Our display loop must write only to tmpfs/RAM, never spam the flash.**

---

# USB / MaskROM attempt — why it did not get us root

The original plan was to use Rockchip MaskROM as a read-only insurance path: identify the chip, dump the flash, mount the rootfs offline, and edit `/etc/shadow` or startup scripts. That assumption did **not** hold on these frames.

1. **Enter MaskROM:** Meural powered off → hold reset while plugging USB into a host. The RK3288 enumerates as Rockchip `2207:320b`.
2. **What works:** `rkdeveloptool ld` / USB enumeration can identify the SoC.
3. **What fails:** loader-dependent operations such as flash info/read/dump fail. In practice this means no `rfi`, no `rl`, no full-flash `backup.img`, and no offline rootfs edit path over USB.
4. **Best explanation:** the device uses a signed-loader / secure-boot path. MaskROM will enumerate, but it will not accept the generic loader needed for eMMC access. This blocks reads as well as writes, so USB is not merely write-protected; it is not a usable root path.

Consequence: the remaining hardware route is **eMMC ISP/chip-off**, bypassing the SoC entirely. That is only worth revisiting if the local `/remote` API path stops being enough.

---

# Phase 1 — UART live shell (Flipper Zero) → enable SSH

## Tools to have on the bench
- **Flipper Zero**, charged (it's the USB-UART adapter)
- 3× female-female **Dupont jumper wires** (+ fine probe tips / pogo pins / "helping hands" — the `G R T` points are small solder pads)
- **Multimeter** (continuity + DC volts) — to find/confirm GND; RK3288 is 3.3 V so no level shifter needed, but verify
- Mac with a serial terminal: `brew install picocom` (or `screen`)
- Plastic **spudger / guitar pick** to open the frame (clips + some adhesive — go slow around the edge)

## Step 0 — mindset / safety
- **Non-destructive:** Phase 1 is just reading/typing on a serial console. Because USB readout is blocked, there is no confirmed full-flash backup from these units.
- **READ before you DRIVE.** Hook up **RX + GND only** first and just *listen*. RK3288 is 3.3 V (Flipper-safe), but still confirm before connecting Flipper TX.
- Work on **one frame** (start with the 21" walnut **tissot-913** — least-missed, smaller to handle).

## Step 1 — open the frame & find the `G R T` pads
1. Power off, open the back, locate the **RK3288 board** (big SoC + wifi module + the ribbon to the panel).
2. Find the **three test solder points labeled `G R T`** (GND / RX / TX). The board has several decoy 4-pin sockets that are *not* the UART — the labeled `G R T` trio is the real console (per teardown).
3. Photograph the board + the panel's LVDS connector/sticker (for records + the fallback).

## Step 2 — confirm the pins with the multimeter
- **G (GND):** continuity (beep) to a known ground (metal shield / barrel-jack sleeve). Confirm it really is ground.
- Power the board ON, meter in **DC volts**, black probe on G:
  - **T (TX, device→us):** idle ~3.3 V, **dips/flickers during boot** as it spews the log → this is the one we read. Idle voltage confirms 3.3 V logic.
  - **R (RX, us→device):** steady high, no boot flicker.

## Step 2b — can't read the RX/TX labels? Sweep for TX with the Flipper (deterministic)
Our board (rev `U121397`) has many `TP##` pads and the debug breakout is a **row of ~5–6 round pads just above the hot-glued power/speaker connector** (near the wifi shield + the barcode sticker) — plus the `GND_TP1`/`VCC_IO_TP3` cluster by the SoC. Labels are sub-millimeter; don't bother reading them, find TX by its behavior:
1. Find **GND** by continuity to the shield frame / a mounting screw (any `GND_TP` pad).
2. Wire Flipper **GND → board GND** and Flipper **pin 14 (RX) → a flying probe wire**. Open the USB-UART bridge @ 115200 + `picocom` (Steps 4).
3. **Power on the board and touch the probe to each unknown pad in turn.** The pad that makes a **readable boot log scroll** in picocom is **TX** — only the UART TX spews ASCII at boot, so this disambiguates it from I²C/JTAG/test pads instantly.
4. **RX** is almost always the pad immediately adjacent to TX in the same row. Confirm it in Step 6 by typing once you've added Flipper TX.

## Step 3 — wire the Flipper (RX + GND ONLY for now)
- Flipper **pin 14 (RX)** → Meural **T (TX)**
- Flipper **pin 8/11/18 (GND)** → Meural **G (GND)**
- *(Leave Flipper pin 13/TX disconnected until Step 6.)*

## Step 4 — Flipper USB-UART bridge → Mac terminal
1. Flipper: **Main menu → GPIO → USB-UART Bridge.** Baud **115200** (Rockchip default). Plug Flipper into the Mac.
2. On the Mac: `ls /dev/tty.usbmodem*` → `picocom -b 115200 /dev/tty.usbmodem*` (or `screen /dev/tty.usbmodem* 115200`).
3. **Power-cycle the Meural** and watch.

## Step 5 — read the boot log, confirm baud
- **Readable U-Boot/kernel text scrolling?** → correct pads + baud (115200 is almost certainly right for RK3288).
- **Garbage ▒▒▒?** → wrong baud: try **115200 → 1500000 → 57600 → 9600**.
- **Nothing at all?** → RX↔TX swapped or wrong pad — swap the data wire.

## Step 6 — get a shell (add TX, 3.3 V confirmed)
Connect Flipper **pin 13 (TX) → Meural R (RX)**. Then, in order of luck:
1. **Auto-root console:** RK3288 dev images often drop to a `#` root shell on the console. Jackpot.
2. **`login:` prompt:** try `root` (blank), then common defaults.
3. **U-Boot interrupt:** spam a key at "Hit any key to stop autoboot" → bootloader; `printenv` to see boot args, can boot `init=/bin/sh` for instant root if needed.

## Step 7 — enable SSH, then do everything over the network (safe + reversible)
The teardown's exact move: from the console, **enable the SSH daemon and add a sudo user**, then unplug UART and work over SSH.
```
# capture state first (paste back to me):
cat /etc/os-release; uname -a; df -h; mount        # confirm Ubuntu 16.04, check flash isn't full
ls -la /dev/fb*                                     # framebuffer device = our display target
cat /etc/rc.local                                   # how startup works (where we'll hook sshd + our loop)
ps aux | grep -iE "cake|php|meural|gallery|display" # the app that drives the screen (to disable)
which fbi fbida fim feh ffmpeg                       # what image tools exist (16.04 may need an install)
# then enable ssh + a user (adapt once we see the box):
service ssh start || /etc/init.d/ssh start
# add 'service ssh start' (+ user create if needed) to /etc/rc.local so it survives reboot
```
Send me that capture and I'll write the exact rc.local edits + the **framebuffer JPEG-display service** and repoint `meural-push` to push to *this device's* LAN IP instead of Meural's cloud.

## Recovery / don't-brick rules
- We do **not** have a confirmed `backup.img` from these units; MaskROM readout was blocked. Treat any write attempt as high-risk unless eMMC ISP/chip-off produces a verified backup first.
- In the live shell: only **add** a startup line + **disable** the Meural app. Don't `rm -rf` system dirs, don't `dd`/`mmc write`.
- **Watch the flash:** the known brick is a full disk from logs. Our loop pulls JPEGs to **tmpfs (`/run` or a `mount -t tmpfs`)**, not the eMMC, and we should cap/disable Meural's chatty logging while we're in there.

---

## What "done" looks like
The Meural's own RK3288 (rooted) running a tiny loop: pull the latest dashboard JPEG from the LAN into **tmpfs**, blit it to `/dev/fb0`, repeat every N minutes; Meural's CakePHP app disabled. Zero Meural cloud, zero new hardware, your $1000s of panels showing a live local dashboard. The 24-pin nonstandard LVDS means gut+Pi is the bad option — rooting in place is the win.
