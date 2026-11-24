# V3 Code

**V3 Code** is an independent, unofficial, privacy-hardened, zero-telemetry fork derived from the MIT-licensed T3 Code source code. It is not affiliated with, endorsed by, or maintained by T3 Tools, Inc.

## Privacy & Autonomy Guarantees

V3 Code strips out all upstream telemetry, tracking, cloud services, and automatic update mechanisms:

- **Zero Telemetry & Zero Analytics:** PostHog / `ingest.t3.codes`, Axiom OTLP relay tracing, Mobile `expo-observe`, `agent.feedback`, and cross-tool credential harvesting (`~/.codex/auth.json`, `~/.claude.json`, `<stateDir>/anonymous-id`, client WS fingerprinting) are completely removed.
- **Zero Auto-Updates & Zero Remote Catalogs:** `electron-updater`, `app-update.yml`, Expo EAS OTA (`expo-updates`), CLI/SSH self-updaters, GitHub `model-manifest.json` fetches, LiteLLM GitHub pricing fetches, ACP CDN registry fetches, and background provider CLI version checks are permanently disabled.
- **Zero Cloud Relay / Auth Dependencies:** T3 Connect, Clerk (`@clerk/*`, Cloudflare Turnstile), `relay.t3.codes`, `t3.chat`, `cloudflared` auto-downloads, and Cloudflare `1.1.1.1` DoH probes are removed.
- **Desktop & Web Privacy Hardening:** Google `s2/favicons` lookups are removed, external Markdown media uses `referrerPolicy="no-referrer"`, Electron launches with Chromium privacy/no-background-networking/no-spellcheck-download/WebRTC-IP flags and strict permission handling, and host computer names/hardware models are not leaked via `/.well-known`.
- **Full Isolation from Official T3 Code:** Uses distinct identifiers (`org.v3code.app`), home directory (`~/.v3`), Electron profile (`v3code`), URL scheme (`v3code://`), ports (`3873` / `13873` / `5833`), IPC sockets, env vars (`V3CODE_*`), and CLI binary (`v3`).

## Supported Capabilities

- Local AI coding agents (Claude Code, Codex, OpenCode, Cursor, Grok, Pi, Muse, etc.)
- Local Git & VCS integrations (GitHub, GitLab, Bitbucket, Forgejo, Azure DevOps, Linear)
- Multi-surface architecture: **Server + CLI (`v3`)**, **Web UI**, **Desktop (Electron)**, and **Mobile (Expo / React Native)** connecting over localhost, LAN, Tailscale, or SSH (with local binaries only).

## Development & Build

Requires Node `26.13.1` and `pnpm@12.14.0`:

```bash
pnpm install
pnpm run typecheck
pnpm run build
pnpm run build:desktop
```

## License

MIT License — see [LICENSE](./LICENSE). Derived from the MIT-licensed T3 Code source code (`Copyright (c) 2026 T3 Tools Inc.`).
