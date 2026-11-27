# Multi-user: идентичность, членство, роли и изоляция проектов

**Статус:** реализован multi-user: идентичность (одноразовые коды, пароли со scrypt, восстановление, передача владения), членство и роли с потолками, гейт доступа (`ProjectAccess` / `ResourceResolver` / `RpcAuthorization`), фильтрация shell и глобальных списков, граница путей (`ProjectPaths`), живой отзыв сокетов, аудит с чтением, ретенцией и hash-chain (`t3 audit verify`), PAT, квоты и лимиты, проектные секреты с отзывом asset-URL, вход по коду в web и mobile, матрица прав и «Мои доступы», изоляция L1 (ОС-пользователь на проект, по флагу проекта), CRM с шифрованием PII, внешние клиенты и портал `/c/:clientId`. Переключатель `settings.multiUser` выключен по умолчанию. Не реализовано: контейнерная изоляция L2, email/SMTP, passkeys, MCP-инструменты CRM — см. раздел «Дальше».

**Цель:** персональный рабочий хаб: сотрудники получают ограниченные права на отдельные проекты, владелец управляет составом и отзывает доступ. Позже — CRM (клиенты/контакты как ресурсы проекта).
**Инвариант:** локальный сервер остаётся источником истины; внешний IdP не требуется.

## Первый реальный сценарий (эталон для дизайна прав)

Владелец приглашает сотрудника в свой инстанс и даёт ему:

1. доступ **только к одному проекту** — например, рабочему проекту **kotcrm**;
2. возможность создавать **собственные новые проекты**;
3. **нет** доступа к остальным проектам и к настройкам инстанса.

Приглашение — **без почты и без пароля**: владелец выдаёт сотруднику одноразовый код, сотрудник открывает `/invite/:code` (или вводит код), задаёт отображаемое имя (`displayName`) и сразу получает сессию и членство. Email и SMTP не нужны; повторный вход — новый одноразовый код входа (TTL 15 минут), который выпускает владелец или сам активный участник.

Из этого следует:

- Приглашение и повторный вход работают по одноразовым кодам; доступ выдаётся и отзывается сервером (`access_revision` + отзыв сессий), без переустановки клиента.
- Роль сотрудника на вверенном проекте — `developer` (или `admin`, если надо управлять составом); потолок — `staff`. Создание своих проектов — возможность `project:create` внутри роли: её получают `developer`+ (при наличии хотя бы одного доступного проекта с `project:create`).
- Проект, созданный участником, размещается в управляемом корне `<baseDir>/projects/` (произвольный путь хоста выбирает только owner). Такой проект получает `visibility = 'private'`, `owner_id = создатель` и членство создателя `admin`; виден он только создателю и owner-у. Удалять проекты участник не может (`project:delete` — только owner).
- «Свои проекты» участника = проекты, где он активный член или создатель (`owner_id`); всё остальное для него скрыто. Настройки инстанса (`serverUpdateSettings`, провайдеры, relay) остаются owner-скими; участнику отдаётся отредактированный view (`redactServerSettingsForMember`).

## Ключевые решения

1. **Идентичность локальная и явная.** Владелец, участники и будущие внешние клиенты — записи `principals`; доступ — `project_memberships`. OIDC/SAML не требуются.
2. **Авторизация трёхслойная:** для ресурса `эффективные_скоупы = скоупы_сессии ∩ потолок_принципала`, а поверх них проверяется `роль_на_проекте_ресурса` (`ProjectAccess` + `ResourceResolver`). Скоупы остаются словарём методов; проект — измерением ресурса.
3. **Совместимость по умолчанию.** Сессии и pairing-ссылки без принципала либо с `binding_kind = 'environment'` проходят проектные проверки без сужения (`passesProjectChecks`). Всё новое — deny by default.
4. **Изоляция честная по этапам.** Сейчас реализована логическая фильтрация (L0); L1 (OS-пользователь на проект) и L2 (контейнер) — дальнейшие этапы. В L0 терминал и агент делят границу хоста.
5. **Отзыв серверный.** `access_revision` растёт при любом изменении роли, статуса или потолка; сервер перефильтровывает стримы и закрывает сокеты (`4401` при отзыве сессии, приостановке или удалении принципала; `4403` при потере всех проектов или проекта активной подписки). Клиент не является границей.
6. **Миграция всех установок — в одного `owner`.** Существующие живые сессии привязываются к `owner` с `binding_kind = 'environment'`, никто не разлогинивается, а изменения существующих таблиц строго аддитивны.
7. **CRM — расширение модели, не переделка:** роли `manager` и `external`-принципалы уже предусмотрены в схеме и контрактах, но сам домен CRM и портал ещё не строились.

Не делаем: отдельный сервер/БД на проект, per-thread ACL (кроме существующих guest-ссылок), Kubernetes, обязательный SMTP.

---

## 1. Идентичность, приглашения и сессии

### 1.1 Модель

Определено в [`packages/contracts/src/membership.ts`](../../packages/contracts/src/membership.ts) и миграциях [`112_MultiUser.ts`](../../apps/server/src/persistence/Migrations/112_MultiUser.ts), [`113_InvitationPrincipal.ts`](../../apps/server/src/persistence/Migrations/113_InvitationPrincipal.ts):

- `principals`: `id`, `kind` (`owner` | `member` | `external` | `service`), `display_name`, `email` (nullable, `UNIQUE`), `status` (`invited` | `active` | `suspended` | `removed`), `ceiling_json`, `access_revision`, `created_at`, `updated_at`, `removed_at`.
  - `owner` — ровно один на окружение (`id = 'owner'`), обходит проектные проверки и не ограничен потолком.
  - `member` — сотрудник с `binding_kind = 'principal'`, чьи права следуют за активными `project_memberships` и собственными проектами (`owner_id`).
- `project_memberships`: PK `(project_id, principal_id)`, `role` (`viewer` | `operator` | `developer` | `manager` | `admin`), `state` (`invited` | `active` | `suspended` | `removed`), `invited_by`, `expires_at`, `created_at`, `updated_at`.
- `invitations`: `id`, `token_hash` (HMAC-хеш кода), `email` (nullable), `kind` (`staff` | `client`), `role`, `project_id` (NULL для environment-инвайта или кода входа), `principal_id` (nullable, добавлено в `113_InvitationPrincipal.ts` — не-NULL для одноразового кода входа существующего принципала), `ceiling_json`, `created_by`, `created_at`, `expires_at`, `accepted_at`, `revoked_at`.
- `session_principals`: `session_id`, `principal_id`, `binding_kind` (`environment` | `principal` | `projects`), `binding_json` (обязателен и допустим только для `projects`).
- Заготовки таблиц для следующих этапов (`principal_credentials`, `api_tokens`, `audit_events`, `member_limits`, `project_quotas`, `project_secrets`) также создаются миграцией `112_MultiUser.ts`. В рантайме сейчас используются `audit_events` (запись событий приглашений и членств), `member_limits` (`invites_per_hour`, по умолчанию 10) и `api_tokens` (каскадный отзыв при приостановке/удалении принципала).

### 1.2 Приглашения и вход

Реализовано в [`InvitationService.ts`](../../apps/server/src/identity/InvitationService.ts) и [`auth/http.ts`](../../apps/server/src/auth/http.ts):

- **Приглашение нового участника:** `owner` (в окружение или в проект) либо project `admin` (только в свой проект, роль ≤ своей, скоупы роли ⊆ потолка приглашающего) выпускает одноразовый код (`POST /api/auth/invitations` или `t3 members invite`, TTL по умолчанию 7 дней). Сырой код возвращается только в ответе создания; в БД хранится HMAC-хеш.
- **Принятие приглашения:** `GET /invite/:code` отдаёт минимальную HTML-страницу, которая вызывает `POST /api/auth/invitations/accept` `{ code, displayName }`. Атомарно потребляет код, создаёт принципала и членство `active`, выдаёт `browser-session-cookie` с `binding_kind = 'principal'`.
- **Повторный вход существующего участника:** `owner` или сам активный принципал выпускает одноразовый код входа (`POST /api/auth/members/:principalId/login-code` или `t3 members login-code`, TTL по умолчанию 15 минут). Клиент (web `/login` или внешний клиент) обменивает код через `POST /api/auth/invitations/login` `{ code }` и получает `bearer-access-token` + cookie с `binding_kind = 'principal'`.
- **Desktop/CLI bootstrap, T3 Connect и pairing-ссылки** продолжают работать с `binding_kind = 'environment'` (либо без строки в `session_principals`, что эквивалентно `environment`).
- **Восстановление доступа:** в текущем виде — выпуск нового одноразового кода входа владельцем через UI/API или локально через CLI `t3 members login-code --principal <id>` (работает и при остановленном сервере напрямую по SQLite).

### 1.3 Сессии и каскадный отзыв

- `environment` — owner и legacy-сессии; `principal` — живое членство (права перечитываются при росте `access_revision`); `projects` — явный список пар `(projectId, role)` в `binding_json`, который никогда не расширяется до членств принципала.
- Приостановка (`suspendPrincipal`) или удаление (`removePrincipal`) принципала в [`MembershipService.ts`](../../apps/server/src/identity/MembershipService.ts) поднимает `access_revision`, отзывает его сессии в `SessionStore`, API-токены и ожидающие приглашения.

---

## 2. Роли, потолки и скоупы

### 2.1 Потолок

`principals.ceiling_json` задаётся owner-ом из шаблонов в [`packages/contracts/src/roleScopes.ts`](../../packages/contracts/src/roleScopes.ts):

- `staff` — все скоупы роли `admin` + `relay:read`;
- `restricted` — `orchestration:{read,operate}`, `terminal:{read,operate}`, `preview:operate`, `filesystem:read`, `access:read`;
- `client` — `orchestration:read`, `filesystem:read`, `access:read`.

Инварианты:

- Эффективные скоупы не-owner сессии на каждом RPC-вызове пересекаются с потолком (`scopes ∩ ceiling`); понижение потолка действует немедленно.
- Никто не выдаёт больше, чем имеет: приглашение и смена роли проверяют ранг актёра и его потолок.
- `environment:maintain`, `diagnostics:read`, `relay:write`, `relay:configure` и переключение `multiUser` доступны только owner-у.
- `project:create` есть у `developer`+ и проверяется по наличию хотя бы одного доступного проекта с этой возможностью.

### 2.2 Матрица ролей

`viewer` ⊂ `operator` ⊂ `developer` ⊂ `admin`; `manager` — боковая ветка под будущую CRM; `owner` — окружение и удаление проектов. Константы определены в [`roleScopes.ts`](../../packages/contracts/src/roleScopes.ts) (не в БД).

| Возможность                                                         | viewer | operator | developer | manager | admin | owner |
| ------------------------------------------------------------------- | :----: | :------: | :-------: | :-----: | :---: | :---: |
| `project:read` (треды, файлы, список preview)                       |   ✓    |    ✓     |     ✓     |    ✓    |   ✓   |   ✓   |
| `project:thread.operate` (запуск, ответы, стоп)                     |   –    |    ✓     |     ✓     |    ✓    |   ✓   |   ✓   |
| `project:terminal.read` / `project:terminal.operate`                |   –    |   ✓\*    |    ✓\*    |    –    |  ✓\*  |   ✓   |
| `project:preview.operate`                                           |   –    |    ✓     |     ✓     |    –    |   ✓   |   ✓   |
| `project:file.write`                                                |   –    |    –     |     ✓     |    –    |   ✓   |   ✓   |
| `project:source.write` (git, ветки, PR)                             |   –    |    –     |     ✓     |    –    |   ✓   |   ✓   |
| `project:thread.manage` (архив, удаление, fork/merge, теги)         |   –    |    –     |     ✓     |    –    |   ✓   |   ✓   |
| `project:settings` (настройки проекта, скрипты, issue tracker bind) |   –    |    –     |     –     |    –    |   ✓   |   ✓   |
| `project:create` (свой проект в `<baseDir>/projects/`)              |   –    |    –     |     ✓     |    –    |   ✓   |   ✓   |
| состав проекта: видеть (`access:read`)                              |   ✓    |    ✓     |     ✓     |    ✓    |   ✓   |   ✓   |
| `project:members` (управление составом, `guestShareCreate`)         |   –    |    –     |     –     |    –    |   ✓   |   ✓   |
| `project:secrets` (контракт; API — в «Дальше»)                      |   –    |    –     |     –     |    –    |   ✓   |   ✓   |
| `project:webhooks` (вебхук-задачи, ротация токена, логи доставок)   |   –    |    –     |     –     |    –    |   ✓   |   ✓   |
| `project:crm.read` (контракт; домен — в «Дальше»)                   |   ✓    |    ✓     |     ✓     |    ✓    |   ✓   |   ✓   |
| `project:crm.write` / `project:crm.invite_client` (в «Дальше»)      |   –    |    –     |     –     |    ✓    |   ✓   |   ✓   |
| `project:delete`                                                    |   –    |    –     |     –     |    –    |   –   |   ✓   |
| окружение: настройки, провайдеры, `multiUser`, relay, устройства    |   –    |    –     |     –     |    –    |   –   |   ✓   |

\* В L0 терминал работает от ОС-пользователя сервера и технически видит весь хост; `ProjectPaths` ограничивает только начальный `cwd`.

### 2.3 Гейт доступа и настройки

- `RpcAuthorization.layer` + `makeAccessGate` ([`RpcAuthorization.ts`](../../apps/server/src/auth/RpcAuthorization.ts)) на каждом RPC обновляют актёра по `access_revision`, проверяют `scopes ∩ ceiling`, затем резолвят цель через [`ResourceResolver.ts`](../../apps/server/src/access/ResourceResolver.ts) и проверяют роль через [`ProjectAccess.ts`](../../apps/server/src/access/ProjectAccess.ts).
- Отказы: нехватка скоупа или owner-only настройка → `EnvironmentAuthorizationError`; нехватка проектной возможности → `ProjectForbiddenError` (`_tag: "project_forbidden"`, `projectId`, `requiredPermission: "project:<cap>"`). Чужие треды на HTTP `/api/orchestration/threads/:threadId*` возвращают `EnvironmentResourceNotFoundError` (404); чужие scheduled tasks и workflow runs скрываются доменной ошибкой not-found.
- `serverGetSettings` для не-owner редактируется через `redactServerSettingsForMember` ([`serverSettings.ts`](../../apps/server/src/serverSettings.ts)): вырезаются пути/секреты провайдеров, хостовые настройки и оверрайды чужих проектов. `serverUpdateSettings` для не-owner принимает только `projectSettingsOverrides` и `projectScriptOverrides` по проектам с `project:settings` (без secret references, без `multiUser`, без мутаций `providerInstanceMutation`).
- Тред наследует проект; сабагенты и worktree — тред. Guest-ссылка остаётся анонимным токеном на один тред; её создание (`guestShareCreate`) требует `project:members`.

---

## 3. Жизненный цикл доступа и живой отзыв

Реализовано в [`MembershipService.ts`](../../apps/server/src/identity/MembershipService.ts), [`RpcAuthorization.ts`](../../apps/server/src/auth/RpcAuthorization.ts) и [`ws.ts`](../../apps/server/src/ws.ts):

- **Приглашение / принятие / отзыв инвайта:** пишет аудит в `audit_events` (`invitation.created`, `invitation.accepted`, `invitation.revoked`, `invitation.login.*`).
- **Смена роли / потолка:** поднимает `access_revision`, **не рвёт** живой сокет; следующий RPC и shell-стрим пересчитывают права по новой ревизии.
- **Приостановка в проекте / удаление из проекта:** поднимает `access_revision`. Если у участника не осталось доступных проектов, активный сокет закрывается кодом **`4403`** (`project_access_revoked`); если потерян доступ к проекту открытой подписки на тред — **`4403`** (`resource_access_revoked`).
- **Приостановка (`suspendPrincipal`) или удаление (`removePrincipal`) принципала (только owner):** переводит не-удалённые членства в `suspended`/`removed`, поднимает `access_revision`, отзывает все сессии, API-токены и pending-инвайты. Живые и простаивающие WebSocket-соединения закрываются кодом **`4401`** немедленно через `SessionStore.awaitInvalidation` (а при прямой смене статуса в БД — на ближайшем RPC-refresh). Возврат (`reactivatePrincipal`) требует нового кода входа.
- **Orphan-проекты:** при удалении последнего `admin` проекта `MembershipService` автоматически назначает `owner` администратором проекта (`promotedOwner: true`).
- **Защита owner:** модифицировать или удалить `owner` через `MembershipService` нельзя.

---

## 4. Изоляция (L0 по умолчанию, L1 по флагу проекта)

| Уровень                          | Что изолирует                                  | Где           | Статус               |
| -------------------------------- | ---------------------------------------------- | ------------- | -------------------- |
| **L0 логический**                | серверная фильтрация ресурсов, путей и стримов | все ОС        | реализовано          |
| **L1 OS-пользователь на проект** | файлы, процессы, git-креды, env, порты preview | Linux-серверы | реализовано (opt-in) |
| **L2 контейнер на проект**       | ФС, сеть, ресурсы                              | Linux, сервер | дальше               |

### 4.1 L1 (opt-in по проекту)

Реализовано в [`ProjectIsolation.ts`](../../apps/server/src/isolation/ProjectIsolation.ts), миграции [`117_ProjectIsolation.ts`](../../apps/server/src/persistence/Migrations/117_ProjectIsolation.ts) и CLI `t3 project isolation <id> --level 0|1` (через `projectsMutate(project.update)`, требующий `project:settings`):

- **ОС-учётка и ФС:** создаёт `svc-<slug>` и группу `t3-<slug>`, назначает `g+rws` корню проекта и его каталогу worktree (`<worktreesDir>/<projectId>`), а поддерево `<stateDir>/projects/<projectId>` переводит в `0700` с владельцем `svc-<slug>`. Без прав root (`sudo -n true`) или не на Linux безопасно откатывается на L0 с фиксацией `adoption_state = 'fallback'` и причины. `disable()` снимает членство без удаления рабочих файлов; `adoptExisting()` повторно применяет владение после обновлений.
- **Терминал:** запускает shell через `systemd-run --scope --uid=svc-<slug> --gid=t3-<slug>` с жёстким env-allowlist (`PATH`, `HOME=/home/svc-*`, `T3_PROJECT_ID`, `T3_MEMBER_ID`, `LANG`, `TERM`); валидация `cwd` остаётся на `ProjectPaths`.
- **Git и секреты проекта:** для L1-проектов добавляет проектный `safe.directory` и материализует креды в `<stateDir>/projects/<projectId>/git/` (`0600`/`0700`) по конвенции имён в `project_secrets`:
  - `GIT_SSH_KEY` — приватный SSH-ключ для `GIT_SSH_COMMAND` (с `IdentitiesOnly=yes`, `BatchMode=yes` и сбросом `SSH_AUTH_SOCK`);
  - `GIT_SSH_KNOWN_HOSTS` — опциональный `known_hosts`;
  - `GIT_HTTP_TOKEN` — токен/пароль для `GIT_ASKPASS` (`GIT_TERMINAL_PROMPT=0`);
  - `GIT_HTTP_USERNAME` — опциональный логин для `GIT_ASKPASS` (по умолчанию `x-access-token`).
- **Worktree и порты preview:** worktree L1-проекта размещаются в `<worktreesDir>/<projectId>/...` с группой `t3-<slug>`; `PreviewTunnel` проверяет, что порт попадает в выделенный диапазон `ports_from..ports_to` из `project_isolation`.

По поверхностям в L0:

- **Оркестрация и глобальные списки:** `subscribeShell`, HTTP `/api/projects` и `/api/orchestration/*`, `searchThreads`, `pullRequests*`, `issues*`, `issueTrackersList`, `workflows*` и `scheduledTasks*` сужаются до доступных проектов участника. `device*`, `agentSessions*` и `serverGetUsageSummary` остаются owner-only.
- **Файлы, VCS и терминал:** [`ProjectPaths.ts`](../../apps/server/src/access/ProjectPaths.ts) (`assertPath` / `assertCwd`) нормализует путь с рекурсивным `realpath` (и защитой от симлинк-циклов) и матчит самый длинный корень проекта, worktree, `trackedFolders` или `task_folders`. Применяется ко всем файловым, VCS- и `terminalOpen`-методам в `ws.ts`; `workspaceListFolders` и `filesystemBrowse` ограничены корнями проектов участника. В L0 терминал после запуска всё ещё работает от ОС-пользователя сервера (`cd ..` наружу не режется ОС).
- **Preview:** `/api/preview/tunnel` требует `terminal:operate`, а при переданном query-параметре `projectId` проверяет `project:preview.operate` (403 при отказе, 401 при неактивном принципале). Диапазоны портов и отдельные tunnel-токены — в «Дальше».
- **Вложения и ассеты:** [`AssetAccess.ts`](../../apps/server/src/assets/AssetAccess.ts) проверяет `project:read` для проектных ресурсов, записывает `projectId` в подписанные claims и сокращает TTL для не-owner с 1 часа до 15 минут. Проверка выполняется только при выпуске URL; отзыв до истечения TTL не реализован.
- **Вебхуки:** доставка `/api/hooks/:hookId/:token` ([`ScheduledTaskService.ts`](../../apps/server/src/scheduledTasks/ScheduledTaskService.ts)) проверяет состояние проекта задачи (удалённый → 404, архивный → `disabled`). Ротация токена и просмотр журналов доставок (`scheduledTasksListWebhookDeliveries`, `scheduledTasksGetWebhookDelivery`) требуют `project:webhooks` (`admin`+), а задачи чужих проектов скрываются как не найденные.

---

## 5. API, CLI, UI и совместимость

### 5.1 HTTP-эндпоинты

Определены в [`packages/contracts/src/environmentHttp.ts`](../../packages/contracts/src/environmentHttp.ts) и [`apps/server/src/auth/http.ts`](../../apps/server/src/auth/http.ts):

| Метод  | Путь                                             | Право                                                                         |
| ------ | ------------------------------------------------ | ----------------------------------------------------------------------------- |
| GET    | `/invite/:code`                                  | публичный (HTML-страница принятия кода)                                       |
| POST   | `/api/auth/invitations/accept`                   | одноразовый код приглашения (`{ code, displayName }`)                         |
| POST   | `/api/auth/invitations/login`                    | одноразовый код входа (`{ code }`)                                            |
| POST   | `/api/auth/invitations`                          | `access:write` + `project:members` (или owner)                                |
| GET    | `/api/auth/invitations[?projectId=...]`          | `access:read` (фильтрация по проектам актёра)                                 |
| DELETE | `/api/auth/invitations/:id`                      | `access:write` (в границах проектов актёра)                                   |
| GET    | `/api/auth/members`                              | `access:read` (фильтрация по общим проектам)                                  |
| PATCH  | `/api/auth/members/:principalId`                 | `access:write` (потолок и статус принципала — owner)                          |
| DELETE | `/api/auth/members/:principalId[?projectId=...]` | `access:write` (с `projectId` — из проекта; без — удаление принципала, owner) |
| POST   | `/api/auth/members/:principalId/login-code`      | аутентифицированный `owner` или сам активный принципал                        |

### 5.2 CLI и UI

- **CLI** ([`apps/server/src/cli/members.ts`](../../apps/server/src/cli/members.ts)): `t3 members invite`, `t3 members list`, `t3 members login-code`, `t3 members enable`, `t3 members disable`. Все команды работают через запущенный сервер либо напрямую по SQLite, если сервер остановлен.
- **Web UI:** экран входа `/login` (`LoginRouteSurface`), настройки участников и приглашений (`MembersSettings`, `ProjectMembersSettings`, `MemberInviteDialog`, `MemberLoginCodeDialog`), индикация сессии и переключение `multiUser` в `ConnectionsSettings` / `SessionPermissions`.

### 5.3 Совместимость контрактов

- `ServerAuthDescriptor.authMode` и `ExecutionEnvironmentDescriptor.authMode` принимают `"multi-user"` при `settings.multiUser === true` и опускаются в режиме single-owner (старые клиенты игнорируют поле).
- Ответы `/api/auth/session` и приглашений добавляют опциональные `principal`, `binding_kind`, `binding`, `role`; существующие поля `scopes` и `permissions` не меняются.
- В `ExecutionEnvironmentCapabilities` объявлены опциональные флаги `members`, `audit`, `projectSecrets` (пока не выставляются сервером; клиенты проверяют `authMode`).

---

## 6. Миграция установок и аддитивные гарантии

Миграции [`112_MultiUser.ts`](../../apps/server/src/persistence/Migrations/112_MultiUser.ts) и [`113_InvitationPrincipal.ts`](../../apps/server/src/persistence/Migrations/113_InvitationPrincipal.ts) идемпотентны:

1. Создают новые таблицы (`principals`, `principal_credentials`, `project_memberships`, `invitations` + `principal_id`, `session_principals`, `api_tokens`, `audit_events`, `member_limits`, `project_quotas`, `project_secrets`).
2. Добавляют в `projection_projects` колонки `owner_id TEXT` и `visibility TEXT NOT NULL DEFAULT 'shared'`.
3. Создают единственного `owner` (`id = 'owner'`, `access_revision = 0`, `display_name` = имя ОС, `email = NULL`), если его ещё нет.
4. Привязывают все живые (`revoked_at IS NULL`) записи `auth_sessions` в `session_principals` к `owner` с `binding_kind = 'environment'`. Отозванные сессии не привязываются; существующие pairing-ссылки без binding продолжают работать как `environment`.
5. `settings.multiUser` остаётся `false` до явного включения (`t3 members enable` или настройка owner-а).

**Аддитивные гарантии (совместимость при откате):** удалять новые таблицы и колонки не требуется. Каждая колонка, добавленная в существующие таблицы, либо nullable, либо имеет `DEFAULT` (`projection_projects.owner_id` — nullable, `projection_projects.visibility` — `DEFAULT 'shared'`). Старый single-owner код продолжает вставлять и читать строки без этих колонок, а ранее выданные cookie-сессии сохраняют формат и подпись и проходят оркестрационные вызовы без повторного входа.

Доказательство апгрейда и аддитивности: фикстура [`legacyState.ts`](../../apps/server/src/persistence/testkit/legacyState.ts) и тест [`112_MultiUser.legacy.test.ts`](../../apps/server/src/persistence/Migrations/112_MultiUser.legacy.test.ts).

---

## 7. Риски и тесты безопасности (L0)

| Риск                            | Контрмера в L0                                                                                | Остаток      |
| ------------------------------- | --------------------------------------------------------------------------------------------- | ------------ |
| Выход из проекта через терминал | `ProjectPaths.assertCwd` проверяет начальный `cwd`; процесс делит ОС-пользователя до L1       | высокий в L0 |
| Утечка событиями и списками     | Серверная фильтрация shell, HTTP-снимков, поиска, PR, issues, workflows, scheduled tasks      | низкий       |
| IDOR по id и путям              | `ResourceResolver` + `ProjectAccess` + `ProjectPaths` (realpath, длиннейший корень)           | низкий       |
| Секреты хоста                   | Редакция `serverGetSettings`, запрет secret references не-owner; полная изоляция env — в L1   | средний в L0 |
| Подписанный asset-URL           | Проверка `project:read` при выпуске, claim `projectId`, TTL 15 мин для не-owner               | низкий       |
| Preview-туннель                 | `terminal:operate` + `project:preview.operate` при указании `projectId`; порты проекта — в L1 | средний в L0 |
| Отзыв доступа                   | `access_revision` + `SessionStore.awaitInvalidation` (`4401`/`4403`)                          | низкий       |

Ключевые тесты: [`ProjectAccess.test.ts`](../../apps/server/src/access/ProjectAccess.test.ts), [`ResourceResolver.test.ts`](../../apps/server/src/access/ResourceResolver.test.ts), [`ProjectPaths.test.ts`](../../apps/server/src/access/ProjectPaths.test.ts), [`MultiUserNarrowing.test.ts`](../../apps/server/src/access/MultiUserNarrowing.test.ts), [`ws.shellFilter.test.ts`](../../apps/server/src/ws.shellFilter.test.ts), [`ws.revocation.test.ts`](../../apps/server/src/ws.revocation.test.ts), [`112_MultiUser.legacy.test.ts`](../../apps/server/src/persistence/Migrations/112_MultiUser.legacy.test.ts).

---

## 8. Дальше (не реализовано)

- **Контейнерная изоляция L2:** podman-контейнер на проект с bind-mount, сетевым неймспейсом и лимитами cgroup; опция поверх работающего L1.
- **Email / SMTP:** письма с приглашениями и уведомлениями; сейчас коды передаются вручную.
- **Passkeys:** вход ключом доступа рядом с паролем.
- **Планировщик истечения внешних членств:** авто-`suspended` для `external` по `expires_at` с уведомлением владельцу.
- **MCP-инструменты CRM:** `t3_crm_client_search`, `t3_crm_note_add` в границах проекта.
- **Привязка guest-ссылок к принципалу:** отзыв гостевой ссылки вместе с членством.
- **Независимость от персонального адреса:** вход сотрудника идёт через HTTPS-домен на egress-узле (Caddy + reverse SSH), автопереключения при переезде нет.
- **Мелочи:** WS RPC методы управления участниками вместо только-HTTP; лимит неудачных входов в БД (сейчас in-memory); уведомления владельцу о превышении квот.
