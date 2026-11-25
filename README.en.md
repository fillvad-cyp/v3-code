<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/github/hero-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="./assets/github/hero-light.svg" />
  <img alt="V3 Code — Zero-telemetry, autonomous GUI for local AI coding agents" src="./assets/github/hero-dark.svg" width="100%" />
</picture>

<br />

[![Release](https://img.shields.io/badge/release-v0.2.0-10B981?style=flat-square)](https://github.com/fillvad-cyp/v3-code/releases/tag/v0.2.0)
[![Telemetry](https://img.shields.io/badge/telemetry-0%20bytes-059669?style=flat-square)](#privacy--autonomy-guarantees)
[![Auto--Updates](https://img.shields.io/badge/auto--updates-disabled-059669?style=flat-square)](#privacy--autonomy-guarantees)
[![Platforms](https://img.shields.io/badge/platforms-Linux%20%7C%20Windows%20%7C%20macOS%20%7C%20Android%20%7C%20CLI-0F172A?style=flat-square)](#download)
[![License: MIT](https://img.shields.io/badge/license-MIT-334155?style=flat-square)](./LICENSE)

[Русский](./README.md) · **English**

<p>
  <strong>V3 Code</strong> is an independent, privacy-hardened, zero-telemetry open-source fork derived from the MIT-licensed T3 Code source code.<br />
  No PostHog, no Axiom, no Clerk, no cloud relay, and no background auto-updaters — just your local coding agents over localhost, LAN, Tailscale, or SSH.
</p>

</div>

---

## Download

Prebuilt installers for every platform are published in **[Releases → `v0.2.0`](https://github.com/fillvad-cyp/v3-code/releases/tag/v0.2.0)** with **[SHA256SUMS.txt](https://github.com/fillvad-cyp/v3-code/releases/download/v0.2.0/SHA256SUMS.txt)**.

### Desktop & Mobile

| Platform                  | Architecture                           | Download                                                                                                                           |   Size | Notes                                             |
| :------------------------ | :------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------- | -----: | :------------------------------------------------ |
| **Windows**               | `x64`                                  | **[V3-Code-0.2.0-x64.exe](https://github.com/fillvad-cyp/v3-code/releases/download/v0.2.0/V3-Code-0.2.0-x64.exe)**                 | 200 MB | NSIS installer for Windows 10/11 (x64)            |
| **Windows**               | `arm64`                                | **[V3-Code-0.2.0-arm64.exe](https://github.com/fillvad-cyp/v3-code/releases/download/v0.2.0/V3-Code-0.2.0-arm64.exe)**             | 183 MB | NSIS installer for Windows on ARM                 |
| **macOS**                 | Apple Silicon (`arm64`)                | **[V3-Code-0.2.0-arm64.zip](https://github.com/fillvad-cyp/v3-code/releases/download/v0.2.0/V3-Code-0.2.0-arm64.zip)**             | 212 MB | `V3 Code.app` with Darwin arm64 native addons     |
| **macOS**                 | Intel (`x64`)                          | **[V3-Code-0.2.0-x64.zip](https://github.com/fillvad-cyp/v3-code/releases/download/v0.2.0/V3-Code-0.2.0-x64.zip)**                 | 217 MB | `V3 Code.app` with Darwin x64 native addons       |
| **Linux**                 | `x86_64`                               | **[V3-Code-0.2.0-x86_64.AppImage](https://github.com/fillvad-cyp/v3-code/releases/download/v0.2.0/V3-Code-0.2.0-x86_64.AppImage)** | 239 MB | Portable AppImage with native Linux helpers       |
| **Linux** (Debian/Ubuntu) | `amd64`                                | **[V3-Code-0.2.0-amd64.deb](https://github.com/fillvad-cyp/v3-code/releases/download/v0.2.0/V3-Code-0.2.0-amd64.deb)**             | 195 MB | Debian package (`v3code`), registers `v3code://`  |
| **Android**               | `arm64-v8a` / `armeabi-v7a` / `x86_64` | **[V3-Code-0.2.0-android.apk](https://github.com/fillvad-cyp/v3-code/releases/download/v0.2.0/V3-Code-0.2.0-android.apk)**         | 195 MB | Release APK (`org.v3code.app`), ready to sideload |
| **iPhone / iPad**         | Safari (PWA)                           | Open your V3 Code server in Safari                                                                                                 |   0 MB | Automatic Add to Home Screen popup, fullscreen    |

### Standalone CLI + Server + Web UI (Zero Node.js Required)

Single-executable Node 26 SEA bundles serving the embedded Web UI on port `3873` (`~/.v3/`):

- **[v3-0.2.0-linux-x64.tar.gz](https://github.com/fillvad-cyp/v3-code/releases/download/v0.2.0/v3-0.2.0-linux-x64.tar.gz)** (177 MB)
- **[v3-0.2.0-darwin-arm64.tar.gz](https://github.com/fillvad-cyp/v3-code/releases/download/v0.2.0/v3-0.2.0-darwin-arm64.tar.gz)** (143 MB) / **[v3-0.2.0-darwin-x64.tar.gz](https://github.com/fillvad-cyp/v3-code/releases/download/v0.2.0/v3-0.2.0-darwin-x64.tar.gz)** (146 MB)
- **[v3-0.2.0-win32-x64.zip](https://github.com/fillvad-cyp/v3-code/releases/download/v0.2.0/v3-0.2.0-win32-x64.zip)** (161 MB) / **[v3-0.2.0-win32-arm64.zip](https://github.com/fillvad-cyp/v3-code/releases/download/v0.2.0/v3-0.2.0-win32-arm64.zip)** (134 MB)

<details>
<summary><strong>Installation Notes (macOS, Windows, Linux, Android, iOS)</strong></summary>

- **Linux:** `sudo apt install ./V3-Code-0.2.0-amd64.deb` or `chmod +x V3-Code-0.2.0-x86_64.AppImage && ./V3-Code-0.2.0-x86_64.AppImage`
- **Windows:** Run the `.exe` installer. Because this independent build is unsigned, choose **More info → Run anyway** in Windows SmartScreen.
- **macOS:** Unzip and move `V3 Code.app` into `/Applications`, then run once (required on Apple Silicon for ad-hoc signing):
  ```bash
  xattr -cr "/Applications/V3 Code.app"
  codesign --force --deep --sign - "/Applications/V3 Code.app"
  ```
- **Android:** Sideload `V3-Code-0.2.0-android.apk` directly or run `adb install -r V3-Code-0.2.0-android.apk`.
- **iPhone / iPad (Home Screen Web App, no Xcode required):** Open your V3 Code server URL (over trusted LAN or Tailscale HTTPS) in Safari. An automatic **Add to Home Screen** sheet guides you to pin it via **Share → Add to Home Screen**. Open the pinned icon and pair once — your session stays isolated in an `HttpOnly` cookie with no tokens in the shortcut URL.
- **iOS (native Xcode build):** Requires macOS + Xcode (free Personal Team works):
  ```bash
  V3CODE_IOS_PERSONAL_TEAM=1 V3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=org.v3code.personal \
    pnpm --filter @t3tools/mobile exec expo prebuild --clean --platform ios
  ```
  Open `apps/mobile/ios/*.xcworkspace` in Xcode, pick your Team under **Signing & Capabilities**, and press **Run** or **Product → Archive**.

</details>

---

## Architecture

<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/github/architecture-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="./assets/github/architecture-light.svg" />
  <img alt="V3 Code Architecture — Direct Private Transport" src="./assets/github/architecture-dark.svg" width="100%" />
</picture>
</div>

---

## Privacy & Autonomy Guarantees

- **Zero Telemetry & Zero Analytics:** PostHog (`ingest.t3.codes`), Axiom OTLP relay tracing, Mobile `expo-observe`, `agent.feedback`, and cross-tool credential harvesting (`~/.codex/auth.json`, `~/.claude.json`, `<stateDir>/anonymous-id`, WS fingerprinting) are completely removed.
- **Zero Auto-Updates & Zero Remote Catalogs:** `electron-updater`, `app-update.yml`, Expo EAS OTA, CLI/SSH self-updaters, GitHub `model-manifest.json`, LiteLLM GitHub pricing fetches, ACP CDN registry fetches, and background provider CLI version checks are permanently disabled.
- **Zero Cloud Relay / Auth Dependencies:** T3 Connect, Clerk (`@clerk/*`, Turnstile), `relay.t3.codes`, `t3.chat`, `cloudflared` auto-downloads, and `1.1.1.1` DoH probes are removed.
- **Full Side-by-Side Isolation:** Distinct app ID (`org.v3code.app`), home directory (`~/.v3`), Electron profile (`v3code`), URL scheme (`v3code://`), ports (`3873` / `13873` / `5833`), env prefix (`V3CODE_*`), and CLI binary (`v3`).

---

## Ghost Mode & Privacy Shield

V3 Code adds built-in zero-footprint and anti-fingerprinting hardening across Server, CLI, Desktop, and Web / iPhone PWA:

```bash
# Ghost Mode: RAM-only state (/dev/shm on Linux), zero disk logs, scrubbed host env fingerprints,
# and zero-byte overwrite before removal on exit
v3 --ghost

# Ghost Mode + explicit Tor / SOCKS5 proxy with DNS-leak protection
v3 --ghost --proxy socks5h://127.0.0.1:9050

# Composable flags (or V3CODE_GHOST=1, V3CODE_NO_LOGS=1, V3CODE_STRICT_PRIVACY=1, V3CODE_PROXY)
v3 --no-logs --strict-privacy --proxy http://127.0.0.1:8080
```

- **Ephemeral Ghost Mode (`--ghost` / `--ephemeral`)**: Stores runtime state in `0700` RAM-backed `/dev/shm/v3-ghost-*` (fallback temp dir), disables server traces, provider event logs, terminal disk logs, and OTLP exports, and overwrites regular files with zeros before unlinking on exit.
- **Always-On Provider Telemetry Firewall**: Injects 20 official opt-out environment variables (`DISABLE_TELEMETRY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `CODEX_TELEMETRY_DISABLED`, `OPENCODE_DISABLE_TELEMETRY`, `OTEL_SDK_DISABLED`, `DO_NOT_TRACK`, `SENTRY_DSN=""`, etc.) for all spawned agent CLIs and PTY shells.
- **Host Environment Scrubbing (`--strict-privacy`)**: Strips `SSH_*`, `TERM_SESSION_ID`, `ITERM_*`, `VSCODE_*`, `TMUX*`, `XDG_SESSION_ID`, `COMPUTERNAME`, `USERDOMAIN`, and `V3CODE_*` from child processes.
- **Fail-Closed Outbound Proxy (`--proxy`)**: Routes HTTP(S)/SOCKS5(h) traffic while keeping loopback in `NO_PROXY`; on Desktop, enforces Chromium `--proxy-server` + dynamic `--host-resolver-rules` DNS-leak guard and strips high-entropy `Sec-CH-UA-*` Client Hints and `X-Requested-With`.
- **EXIF & GPS Image Scrubbing (on by default)**: Losslessly strips GPS coordinates, camera/Apple MakerNotes, XMP, IPTC, and PNG `eXIf`/`tEXt`/`tIME` metadata before upload while preserving portrait EXIF orientation.
- **App Switcher Curtain, Auto-Lock, Boss Key & Panic Wipe**: In **Settings → General → Privacy Shield & Ghost Mode** and the Command Palette (`Alt+Shift+L`), enable the iOS App Switcher privacy curtain, inactivity auto-lock with PBKDF2-SHA256 passcode + retry backoff, **Boss Key** (lock & hide all windows), or instant **Panic Wipe** (revokes server sessions & pairing links, expires `HttpOnly` cookies, wipes `localStorage`, `sessionStorage`, `IndexedDB`, and Service Worker caches).
- **Privacy Vault & Anti-Detect Harness (6 modules)**:
  - **Proxy Vault & Kill-Switch**: SOCKS5h/Tor/HTTP(S) vault with bulk import, live TCP/SOCKS5 probes, DNS-leak badges, and fail-closed Kill-Switch.
  - **Server & SSH / Tailscale Vault**: Reachability ping and injection-safe SSH launch commands (`v3 --ghost --no-logs` with `-i`, `-J`, and SOCKS5 `ProxyCommand`).
  - **Identity Compartments & Burner RAM**: Isolated proxy, Kill-Switch, Git author/SSH key, timezone, browser partition, project bindings, and 1-click RAM Burner profiles.
  - **Outbound Prompt Secret & Path DLP Guard**: Local prompt scanner (`Warn` / `Auto-redact` / `Strict block`) for API keys, private keys, JWTs, `.env`/DB URLs, `/home`/`/Users` paths, and IPv4s.
  - **Network Egress Monitor & Strict Allowlist**: Live domain log and allowlist/blocklist firewall for Desktop Chromium (`onBeforeRequest`) and server probes with LLM provider presets.
  - **AES-256-GCM Vault Encryption, Burn-after-TTL & Pop-out PiP Windows**: PBKDF2-SHA256 (310k) at-rest vault encryption, auto-burning chat threads (`15m / 1h / 6h / 24h / on-exit`), and Telegram-style pop-out chat windows (`Ctrl/Cmd+Click`) with Always-on-Top PiP pinning.

---

## Build from Source

Requires **Node.js `26.13.1`** and **`pnpm@12.14.0`**:

```bash
pnpm install
pnpm run typecheck
pnpm run build
pnpm run build:desktop
```

## License

MIT License — see [LICENSE](./LICENSE). Derived from the MIT-licensed T3 Code source code (`Copyright (c) 2026 T3 Tools Inc.`). Not affiliated with, endorsed by, or maintained by T3 Tools, Inc.
