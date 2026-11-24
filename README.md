<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/github/hero-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="./assets/github/hero-light.svg" />
  <img alt="V3 Code — Zero-telemetry, autonomous GUI for local AI coding agents" src="./assets/github/hero-dark.svg" width="100%" />
</picture>

<br />

[![Release](https://img.shields.io/badge/release-v0.1.11-10B981?style=flat-square)](https://github.com/fillvad-cyp/v3-code/releases/tag/v0.1.11)
[![Telemetry](https://img.shields.io/badge/telemetry-0%20bytes-059669?style=flat-square)](#что-вырезано-и-усилено)
[![Auto--Updates](https://img.shields.io/badge/auto--updates-disabled-059669?style=flat-square)](#что-вырезано-и-усилено)
[![Platforms](https://img.shields.io/badge/platforms-Linux%20%7C%20Windows%20%7C%20macOS%20%7C%20Android%20%7C%20CLI-0F172A?style=flat-square)](#скачать-для-вашего-устройства)
[![License: MIT](https://img.shields.io/badge/license-MIT-334155?style=flat-square)](./LICENSE)

**Русский** · [English](./README.en.md)

<p>
  <strong>V3 Code</strong> — независимый, полностью автономный open-source форк на базе MIT-кода T3 Code<br />
  с вырезанной телеметрией, облачными релеями, Clerk-авторизацией и фоновыми автообновлениями.<br />
  Работает строго локально, по LAN, Tailscale или SSH — на компьютере, сервере и смартфоне.
</p>

<p>
  <a href="#скачать-для-вашего-устройства"><strong>Скачать установщик</strong></a> &nbsp;·&nbsp;
  <a href="#архитектура">Архитектура</a> &nbsp;·&nbsp;
  <a href="#что-вырезано-и-усилено">Сравнение с T3 Code</a> &nbsp;·&nbsp;
  <a href="#сборка-из-исходников">Сборка из исходников</a>
</p>

</div>

---

## Скачать для вашего устройства

Все готовые сборки опубликованы в **[Releases → `v0.1.11`](https://github.com/fillvad-cyp/v3-code/releases/tag/v0.1.11)** с контрольными суммами **[SHA256SUMS.txt](https://github.com/fillvad-cyp/v3-code/releases/download/v0.1.11/SHA256SUMS.txt)**. Нажмите на нужный файл — скачивание начнётся сразу.

### Desktop и Mobile

| Устройство                  | Архитектура                            | Скачать                                                                                                                               | Размер | Примечание                                                 |
| :-------------------------- | :------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------ | -----: | :--------------------------------------------------------- |
| **Windows**                 | `x64` (Intel / AMD)                    | **[V3-Code-0.1.11-x64.exe](https://github.com/fillvad-cyp/v3-code/releases/download/v0.1.11/V3-Code-0.1.11-x64.exe)**                 | 375 MB | NSIS-установщик + встроенный Linux x64 WSL-рантайм `v3`    |
| **Windows**                 | `arm64` (Snapdragon / ARM)             | **[V3-Code-0.1.11-arm64.exe](https://github.com/fillvad-cyp/v3-code/releases/download/v0.1.11/V3-Code-0.1.11-arm64.exe)**             | 183 MB | NSIS-установщик для Windows on ARM                         |
| **macOS**                   | Apple Silicon (`M1–M4`)                | **[V3-Code-0.1.11-arm64.zip](https://github.com/fillvad-cyp/v3-code/releases/download/v0.1.11/V3-Code-0.1.11-arm64.zip)**             | 212 MB | Готовый `V3 Code.app` с нативными аддонами Darwin arm64    |
| **macOS**                   | Intel (`x64`)                          | **[V3-Code-0.1.11-x64.zip](https://github.com/fillvad-cyp/v3-code/releases/download/v0.1.11/V3-Code-0.1.11-x64.zip)**                 | 217 MB | Готовый `V3 Code.app` с нативными аддонами Darwin x64      |
| **Linux** (универсальный)   | `x86_64`                               | **[V3-Code-0.1.11-x86_64.AppImage](https://github.com/fillvad-cyp/v3-code/releases/download/v0.1.11/V3-Code-0.1.11-x86_64.AppImage)** | 238 MB | Запуск без установки (`chmod +x`), нативные утилиты внутри |
| **Linux** (Debian / Ubuntu) | `amd64`                                | **[V3-Code-0.1.11-amd64.deb](https://github.com/fillvad-cyp/v3-code/releases/download/v0.1.11/V3-Code-0.1.11-amd64.deb)**             | 195 MB | Системный пакет `v3code`, схема `v3code://`                |
| **Android**                 | `arm64-v8a` / `armeabi-v7a` / `x86_64` | **[V3-Code-0.1.11-android.apk](https://github.com/fillvad-cyp/v3-code/releases/download/v0.1.11/V3-Code-0.1.11-android.apk)**         | 195 MB | Release APK (`org.v3code.app`), готов к установке          |

### Автономный CLI + Server + Web UI (Node.js не требуется)

Единый standalone-архив (Node 26 SEA): запускает локальный сервер + встроенный Web UI на порту `3873` (`~/.v3/`).

| Платформа                           | Архитектура             | Скачать                                                                                                                             | Размер |
| :---------------------------------- | :---------------------- | :---------------------------------------------------------------------------------------------------------------------------------- | -----: |
| **Linux** (VPS / сервер / локально) | `x64`                   | **[v3-0.1.11-linux-x64.tar.gz](https://github.com/fillvad-cyp/v3-code/releases/download/v0.1.11/v3-0.1.11-linux-x64.tar.gz)**       | 177 MB |
| **macOS**                           | Apple Silicon (`arm64`) | **[v3-0.1.11-darwin-arm64.tar.gz](https://github.com/fillvad-cyp/v3-code/releases/download/v0.1.11/v3-0.1.11-darwin-arm64.tar.gz)** | 143 MB |
| **macOS**                           | Intel (`x64`)           | **[v3-0.1.11-darwin-x64.tar.gz](https://github.com/fillvad-cyp/v3-code/releases/download/v0.1.11/v3-0.1.11-darwin-x64.tar.gz)**     | 146 MB |
| **Windows**                         | `x64`                   | **[v3-0.1.11-win32-x64.zip](https://github.com/fillvad-cyp/v3-code/releases/download/v0.1.11/v3-0.1.11-win32-x64.zip)**             | 161 MB |
| **Windows**                         | `arm64`                 | **[v3-0.1.11-win32-arm64.zip](https://github.com/fillvad-cyp/v3-code/releases/download/v0.1.11/v3-0.1.11-win32-arm64.zip)**         | 134 MB |

<details>
<summary><strong>Инструкции по установке для каждой платформы (macOS, Windows, Linux, Android, iOS)</strong></summary>

#### Linux

```bash
# Debian / Ubuntu (.deb)
sudo apt install ./V3-Code-0.1.11-amd64.deb

# Любой дистрибутив (.AppImage)
chmod +x V3-Code-0.1.11-x86_64.AppImage
./V3-Code-0.1.11-x86_64.AppImage
```

#### Windows

Запустите `V3-Code-0.1.11-x64.exe` (или `arm64`). Так как независимая сборка не подписана платным сертификатом Authenticode, в окне Windows SmartScreen нажмите **«Подробнее» → «Выполнить в любом случае»**.

#### macOS

Распакуйте `.zip` и перенесите `V3 Code.app` в `/Applications`. Так как сборка не нотаризована через платный Apple Developer ID, один раз выполните в терминале перед первым запуском (на Apple Silicon локальная ad-hoc подпись обязательна):

```bash
xattr -cr "/Applications/V3 Code.app"
codesign --force --deep --sign - "/Applications/V3 Code.app"
```

#### Android

Скачайте `V3-Code-0.1.11-android.apk` на телефон и установите (разрешив установку из неизвестных источников), либо через ADB:

```bash
adb install -r V3-Code-0.1.11-android.apk
```

#### Автономный CLI + Web UI (`v3`)

```bash
tar -xzf v3-0.1.11-linux-x64.tar.gz
./v3-0.1.11-linux-x64/v3
# Откройте http://127.0.0.1:3873 в браузере
```

_(На macOS Apple Silicon предварительно выполните `xattr -cr v3-0.1.11-darwin-arm64 && codesign --force --sign - v3-0.1.11-darwin-arm64/v3`.)_

#### iOS (сборка на Mac через Xcode)

Сборка `.ipa` требует macOS и Xcode (достаточно бесплатного Apple ID / Personal Team):

```bash
V3CODE_IOS_PERSONAL_TEAM=1 V3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=org.v3code.personal \
  pnpm --filter @t3tools/mobile exec expo prebuild --clean --platform ios
```

Откройте `apps/mobile/ios/*.xcworkspace` в Xcode, выберите свой Team в **Signing & Capabilities** и нажмите **Run** или **Product → Archive**.

#### Проверка контрольных сумм

```bash
sha256sum -c SHA256SUMS.txt
```

</details>

---

## Архитектура

<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/github/architecture-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="./assets/github/architecture-light.svg" />
  <img alt="V3 Code Architecture — Direct Private Transport" src="./assets/github/architecture-dark.svg" width="100%" />
</picture>
</div>

Все поверхности (**Desktop**, **Android**, **Web UI**, **CLI**) общаются напрямую с вашим локальным или удалённым сервером `v3` через `localhost`, домашнюю сеть **LAN**, **Tailscale** или **SSH-туннель** — без сторонних облачных релеев, аккаунтов и посредников.

---

## Что вырезано и усилено

| Область                       | Официальный T3 Code                                                                                                       | **V3 Code**                                                                            |
| :---------------------------- | :------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------- |
| **Аналитика и телеметрия**    | PostHog (`ingest.t3.codes`), `expo-observe`, `agent.feedback`                                                             | **Полностью удалены** (`0` байт, `0` сетевых вызовов)                                  |
| **OTLP / Axiom трейсинг**     | Отправка трейсов через `relay.t3.codes` / Axiom                                                                           | **Отключён на уровне кода** (жёсткий no-op)                                            |
| **Сбор идентификаторов**      | Чтение `~/.codex/auth.json`, `~/.claude.json`, `<stateDir>/anonymous-id`, WS fingerprinting                               | **Полностью удалён**                                                                   |
| **Облачный доступ и auth**    | T3 Connect, Clerk (`@clerk/*`, Turnstile), `relay.t3.codes`, `t3.chat`, автоскачка `cloudflared`                          | **Полностью удалены** — только `localhost` / LAN / Tailscale / SSH                     |
| **Автообновления и каталоги** | `electron-updater`, `app-update.yml`, Expo EAS OTA, GitHub `model-manifest.json`, LiteLLM pricing, ACP CDN, `1.1.1.1` DoH | **Навсегда отключены** — никаких фоновых запросов                                      |
| **Браузерная приватность**    | Google `s2/favicons`, стандартные сетевые флаги Chromium, утечка hostname через `/.well-known`                            | `s2/favicons` удалён, `referrerPolicy="no-referrer"`, жёсткие privacy-флаги Chromium   |
| **Изоляция от T3 Code**       | `~/.t3`, порт `3773`, `com.t3tools.*`, `t3://`, `t3`                                                                      | **`~/.v3`**, порт **`3873`**, **`org.v3code.app`**, **`v3code://`**, бинарник **`v3`** |

> **Подтверждено проверкой:** при холодном старте сервера V3 Code зафиксировано **`0` исходящих сетевых соединений**; в собранных JS-бандлах Web/CLI (1012 файлов) и Android APK (`index.android.bundle`) — **`0` упоминаний** `posthog.com`, `us.i.posthog`, `telemetry.t3`, `clerk.accounts.dev`, `relay.t3.codes`, `app.t3.codes` и `pingdotgg/t3code`.

---

## Поддерживаемые агенты и интеграции

- **Локальные AI-агенты:** Claude Code, Codex, OpenCode, Cursor, Grok, Kiro, Pi, Muse Code, локальные ACP-агенты.
- **Git и трекеры:** локальный Git (worktrees, diff-просмотр, ветки, коммиты) + интеграции с GitHub, GitLab, Bitbucket, Forgejo, Azure DevOps и Linear (работают только при явной настройке пользователем).
- **Windows + WSL:** установщик `V3-Code-0.1.11-x64.exe` включает изолированный Linux-рантайм `v3` (`~/.v3/wsl-runtime`) для нативной работы внутри WSL.

---

## Сборка из исходников

Требуются **Node.js `26.13.1`** и **`pnpm@12.14.0`**:

```bash
pnpm install
pnpm run typecheck
pnpm run build
pnpm run build:desktop
```

Запустить локальный сервер + Web UI напрямую из исходников:

```bash
pnpm --filter @t3tools/server start
```

---

## Лицензия и атрибуция

Распространяется под лицензией **MIT** — см. [LICENSE](./LICENSE).

**V3 Code** — независимый неофициальный форк, созданный на основе исходного кода T3 Code под лицензией MIT (`Copyright (c) 2026 T3 Tools Inc.`). Проект не аффилирован с T3 Tools, Inc., не поддерживается и не одобрен ей.
