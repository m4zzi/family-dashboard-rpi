# AGENTS.md — context for Codex & other coding agents

> **Deployment status review (2026-09-06):** `.2.164` and the frame addresses
> below are the last documented Columbia targets. Newport Pi/frame operation has
> not been established by the available records; verify the actual target before
> deployment. [Newport architecture](../newport-infra/ARCHITECTURE.md) owns current
> hosting decisions. This update does not change or deploy the application.
>
> **Secrets migration remains open:** the existing application reads `config.js`;
> gitignore is not vault integration. Examples below describe that legacy mechanism.
> Store new credentials in Infisical, never in a file or commit; a runtime-loading
> migration requires separate implementation. See [the runbook](../infra/infisical.md).

> This is the agent entry point (Codex, Hermes, any non-Claude agent).
> **Read `CLAUDE.md` in this repo first** — it is the source of truth (Pi details,
> API routes, Meural pipeline, touch/scroll internals, known failure modes).

## What this repo is
Family dashboard for a Raspberry Pi kiosk (`m4zzi@192.168.2.164`, `:3000`) — Node/Express
backend + vanilla JS frontend, no build step. Also pushes portrait snapshots to two Netgear
Meural frames (`meural-push.js`). Runbook for frame problems: `MEURAL.md`.

## Deploy (no CI — rsync to the Pi)
```bash
rsync -av --exclude=node_modules --exclude=.git \
  ./ m4zzi@192.168.2.164:~/family-display/
ssh m4zzi@192.168.2.164 "pm2 restart family-display"
```
- CSS/JS-only changes: rsync + browser refresh is enough; `server.js` changes need the pm2 restart.
- `config.js` on the Pi holds the real creds; the local copy is a working file. It is
  **gitignored — never commit it**. `config.example.js` is the committed template.

## Secrets
Vault is Infisical at `http://secrets.home` (project `homelab`, env `prod`) — see
`infra/infisical.md`. Runtime creds for this service live in the Pi's gitignored `config.js`.
Never hardcode or commit credentials; placeholders only in committed files.

## Commit policy
Solo Claude-coded repo (`m4zzi/family-dashboard-rpi`) — commit directly to `main` and push.

## Guardrails / gotchas
- **Do not remove `dns.setDefaultResultOrder('ipv4first')`** at the top of `server.js` and
  `meural-push.js` — the LAN has broken ULA-only IPv6 and Node fetch times out without it.
- **Meural cloud work is nightly-gated on purpose** (22:00 run / manual `resync` arg only).
  Plain runs must only do the local postcard push — any cloud item add/delete kicks the frames
  out of the postcard preview. Do not reintroduce per-run cloud uploads or gallery syncs.
- The baby-cam overlay is kiosk-only by design: it exists only in `index.html`, and
  `meural-push.js` screenshots `/portrait.html`. Don't add camera elements to portrait.
- Chromium kiosk flags matter: keep `--ozone-platform=wayland` and `--touch-events=enabled`
  in the autostart (title-bar clipping / dead touch without them).
- Scrolling uses the custom `attachDragScroll` pointer-events handler in `app.js` — native CSS
  overflow scroll is unreliable on the Wayland kiosk; don't "simplify" it away.
- For an authorized deployment: verify the current target, rsync → verify on the Pi →
  commit/push under the repository policy. Documentation-only work does not deploy.
