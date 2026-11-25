# Multi-user: идентичность, членство, роли и изоляция проектов

**Статус:** проект, не реализовано. Затрагивает `apps/server`, `packages/contracts`, web/desktop/mobile и CLI.
**Цель:** персональный рабочий хаб: сотрудники получают ограниченные права на отдельные проекты, владелец управляет составом и отзывает доступ. Позже — CRM (клиенты/контакты как ресурсы проекта).
**Инвариант:** локальный сервер остаётся источником истины; внешний IdP не требуется.

Исходная точка: доступ сегодня — это скоупы сессии (`orchestration`, `terminal`, `filesystem`, `providers`, `access`, `relay`), проверяемые на каждом RPC ([`RpcAuthorization.ts`](../../apps/server/src/auth/RpcAuthorization.ts)), проекты — только группировка. Сессия не знает, к какому проекту относится вызов. Шаринг — pairing-ссылка на всё окружение либо guest-ссылка на один тред.

## Первый реальный сценарий (эталон для дизайна прав)

Владелец приглашает сотрудника (живого человека) в свой инстанс и даёт ему:

1. доступ **только к одному проекту** — рабочему CRM-проекту **kotcrm**; на сервере его пока нет: проект будет импортирован целиком с локального T3 владельца, грант выдаётся после импорта;
2. возможность создавать **собственные новые проекты**;
3. **нет** доступа к остальным проектам и к настройкам инстанса.

Приглашение — **без почты и без логина**: владелец выдаёт сотруднику одноразовый код (как pairing-код), сотрудник вводит его на странице принятия, задаёт имя/пароль и сразу получает сессию и членство. Email и SMTP не нужны; повторный доступ — новый одноразовый код от владельца.

Из этого следует:

- Приглашение по ссылке (email опционален), вход по логину/паролю; доступ выдаем и отзываем сервером (`accessRevision`), без переустановки клиента.
- Роль сотрудника на вверенном проекте — `developer` (или `admin`, если надо управлять составом); потолок `staff`. Создание своих проектов — не отдельная «роль member», а возможность `project:create` внутри роли: её получают `developer`+.
- Проект, созданный участником, создаётся в управляемом корне (`<stateDir>-adjacent members root`), не по произвольному пути хоста — произвольный путь выбирает только owner. Такой проект получает `visibility = private`, `owner_id = создатель`, и членство создателя `admin`; виден он только создателю и owner-у. Свои проекты участник удалять не может (`project.delete` — только owner).
- «Свои проекты» участника = проекты, где он creator (`owner_id`) или член; всё остальное для него не существует (404). Настройки инстанса (`serverUpdateSettings`, провайдеры, relay) остаются owner-скими; участнику отдаётся отредактированный view (см. §2.3).

## Ключевые решения

1. **Идентичность локальная и явная.** Владелец, участники и внешние клиенты — записи `principals`; доступ — `project_memberships`. OIDC/SAML — не в MVP.
2. **Авторизация трёхслойная:** для ресурса `эффективные_скоупы = запрошенные ∩ потолок_принципала ∩ роль_на_проекте_ресурса`. Скоупы остаются словарём методов; проект — новым измерением ресурса.
3. **Совместимость по умолчанию.** Сессии и pairing-ссылки без принципала получают `binding_kind = environment` и ведут себя ровно как сегодня. Всё новое — deny by default.
4. **Изоляция честная по этапам.** MVP — логическая фильтрация (L0); v2 — OS-пользователь на проект на Linux (L1); v3 — контейнер (L2). В L0 терминал и агент — общая граница, это пишется в UI.
5. **Отзыв серверный.** `accessRevision` растёт при любом изменении состава/роли/потолка; сервер закрывает сокеты и перефильтровывает стримы. Клиент не является границей.
6. **Миграция всех установок — в одного `owner`.** Никто не разлогинивается, старые гранты остаются валидными с пометкой `legacy`.
7. **CRM — расширение модели, не переделка:** ресурсы проекта, роль `manager`, внешний `client` с порталом; guest-ссылки переиспользуются, но привязываются к принципалу.

Не делаем: отдельный сервер/БД на проект, per-thread ACL (кроме существующих guest-ссылок), Kubernetes, обязательный SMTP.

---

## 1. Идентичность и членство

### 1.1 Модель

`principals`: `id`, `kind` (`owner` | `member` | `external` | `service`), `display_name`, `email` (нормализованный, `UNIQUE`), `status` (`invited` | `active` | `suspended` | `removed`), `ceiling_json`, `access_revision`, `created_at`, `updated_at`, `removed_at`.

- `owner` — ровно один в MVP. Обходит проверки проектов, держит все скоупы.
- `member` — сотрудник. Существует только через членство хотя бы в одном проекте.
- `external` — клиент CRM (v3): только проектные ресурсы, без терминала/файлов.
- `service` — CI/машина: принципал без членств, `binding_kind = environment`, потолок ограничен.

`principal_credentials`: `principal_id`, `algo = scrypt`, `salt`, `hash`, `updated_at`. Пароль — `node:crypto.scrypt` (N=16384), без нативной зависимости. Passkeys — v2.

`project_memberships`: `project_id`, `principal_id`, `role`, `state` (`invited` | `active` | `suspended`), `invited_by`, `expires_at` (для внешних), `created_at`, `updated_at`, PK `(project_id, principal_id)`.

Индексы: `principals(email)`, `project_memberships(principal_id, state)`, `project_memberships(project_id, role)`.

### 1.2 Приглашения

`invitations`: `id`, `token_hash` (HMAC серверным ключом; сырой токен только в ответе), `email`, `kind` (`staff` | `client`), `role`, `project_id` (NULL — приглашение в окружение, только owner), `ceiling_json`, `created_by`, `created_at`, `expires_at` (по умолчанию 7 дней), `accepted_at`, `revoked_at`.

Правила:

- Приглашение выдаёт `owner` (в окружение или в проект) либо `project admin` (только в свой проект, роль ≤ своей, скоупы ∩ свой потолок).
- Приглашение — одноразовый код (как pairing-код): человеко-вводимый, HMAC-хеш хранится вместо кода; email опционален и по умолчанию отсутствует (см. «Первый реальный сценарий»). С SMTP письмо; доставка не блокирует создание.
- Одноразовость и атомарное потребление — как в `AuthPairingLinks.consumeAvailable`.
- Повторный инвайт на существующий email добавляет членство тому же принципалу, а не создаёт дубль.
- Инвайт на `external` всегда с `project_id` и `expires_at`.

### 1.3 Вход

- `POST /api/auth/login` `{ email, password }` → обычная browser-session cookie через `SessionStore.issue` с `principalId`.
- DPoP-клиенты: `POST /api/auth/token` (grant `password`) с proof-key; сессия привязывается к ключу, как сейчас.
- Приглашённый принимает ссылку на `/invite/:token`: имя, пароль, сразу сессия и членство.
- Ограничение попыток: 5 неудач / 15 минут на email+IP, dummy-хеш для неизвестных email, одинаковая ошибка.
- Cookie-сессии уже отклоняются при чужом Origin в `authenticateRequest`; login-эндпоинт дополнительно проверяет Origin и лимитируется.
- Desktop/CLI bootstrap, T3 Connect и pairing-ссылки продолжают работать без принципала (owner-эквивалент, `legacy`). Десктоп, подключённый к чужому серверу, входит обычным логином; собственный сервер десктопа остаётся owner-bootstrap.

### 1.4 Восстановление

Четыре уровня, от дешёвого к всегда доступному:

1. **Сам** — `POST /api/auth/recovery` по email: всегда 204, письмо/ссылка на 30 минут, одноразово. Новый пароль отзывает все сессии принципала.
2. **Владелец** — `POST /api/members/:id/recovery`: одноразовый код, отзывает все сессии и устройства, принципал обязан сменить пароль.
3. **Break-glass по ОС** — `t3 members recover --base-dir <state> --email <email>`: печатает одноразовую owner-ссылку. Работает без сети и SMTP; корень доверия — доступ к ОС-пользователю сервера.
4. Потерян единственный owner без email — CLI создаёт `owner` из текущего ОС-пользователя (`t3 members owner-reset`).

Восстановление — событие аудита; все прежние сессии, PAT и MCP-сессии отзываются.

### 1.5 Сессии и устройства

`SessionStore` получает `principalId`, `binding_kind` (`environment` | `principal` | `projects`) и `binding_json` (явные project id — только для `projects`). `environment` — owner, service и легаси; `principal` — живое членство (права следуют за изменениями); `projects` — узкие ссылки/PAT. Узкая ссылка переносит свой `projects`-binding в сессию и не расширяется до принципала. Свой список клиентов и «отозвать остальные» видит принципал; admin проекта — сессии принципалов своего проекта; owner — все. Отзыв принципала каскадно убивает его сессии, устройства (по `proofKeyThumbprint`), PAT, MCP-сессии и pending-инвайты.

Альтернативы: (а) каждый сотрудник = долгоживущая pairing-ссылка — нет имён, мультидевайса и точечного отзыва; (б) OIDC сразу — ломает local-first и офлайн; (в) один общий пароль на сервер — не даёт per-project прав.

---

## 2. Роли и права

### 2.1 Потолок

`principals.ceiling_json` — максимум скоупов принципала, задаётся owner-ом из шаблонов `staff` / `restricted` / `client`. Потолок — глобальный: роль проекта сужает его, но не расширяет. Инварианты:

- Сессия никогда не получает скоуп вне потолка, даже если роль проекта его подразумевает.
- Никто не выдаёт больше, чем имеет: инвайт и смена роли режутся `потолок_приглашающего ∩ роль`.
- Понижение потолка немедленно сужает живые сессии (проверка на каждом вызове, не только при выдаче).
- `access:write` в окружении, `relay:configure`, `environment:maintain` — только у owner. Project admin держит `access:write` только в границах своего проекта.
- Создание проекта: `project:create` есть у `developer`+; owner выбирает произвольный путь хоста, участник получает управляемый корень (см. «Первый реальный сценарий»).

### 2.2 Матрица ролей

`viewer` ⊂ `operator` ⊂ `developer` ⊂ `admin`; `manager` — боковая ветка для CRM; `owner` — окружение и удаление проектов.

| Возможность                                        | viewer | operator | developer | manager | admin | owner |
| -------------------------------------------------- | :----: | :------: | :-------: | :-----: | :---: | :---: |
| `project.read` (треды, файлы, список preview)      |   ✓    |    ✓     |     ✓     |    ✓    |   ✓   |   ✓   |
| `thread.operate` (запуск, ответы, стоп)            |   –    |    ✓     |     ✓     |    ✓    |   ✓   |   ✓   |
| `terminal.read` / `terminal.operate`               |   –    |    ✓*    |    ✓*     |    –    |  ✓*   |   ✓   |
| `preview.operate`                                  |   –    |    ✓     |     ✓     |    –    |   ✓   |   ✓   |
| `file.write`                                       |   –    |    –     |     ✓     |    –    |   ✓   |   ✓   |
| `source.write` (git, ветки, PR)                    |   –    |    –     |     ✓     |    –    |   ✓   |   ✓   |
| `thread.manage` (архив, удаление, перенос, теги)   |   –    |    –     |     ✓     |    –    |   ✓   |   ✓   |
| `project.settings` (скрипты, модель, папки)        |   –    |    –     |     –     |    –    |   ✓   |   ✓   |
| `project:create` (свой проект, управляемый корень) |   –    |    –     |     ✓     |    –    |   ✓   |   ✓   |
| состав проекта: видеть (`access:read`)             |   ✓    |    ✓     |     ✓     |    ✓    |   ✓   |   ✓   |
| `project.members` (управление, `access:write`)     |   –    |    –     |     –     |    –    |   ✓   |   ✓   |
| `project.secrets` / `project.webhooks`             |   –    |    –     |     –     |    –    |   ✓   |   ✓   |
| `crm.read`                                         |   ✓    |    ✓     |     ✓     |    ✓    |   ✓   |   ✓   |
| `crm.write` / `crm.invite_client`                  |   –    |    –     |     –     |    ✓    |   ✓   |   ✓   |
| `project.delete`                                   |   –    |    –     |     –     |    –    |   –   |   ✓   |
| окружение: настройки, провайдеры, доступ, relay    |   –    |    –     |     –     |    –    |   –   |   ✓   |

\* В L0 терминал фактически видит весь хост (см. §4); UI помечает это. В L1 — только проект.

### 2.3 Скоупы: картирование и совместимость

Роль разворачивается в скоупы для гейтов `RPC_REQUIRED_SCOPES`; проектная проверка идёт отдельно.

| Возможность        | Примеры методов                                                                                   | Скоуп                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `project.read`     | `subscribeShell`, `getThreadProjection`, `projectsListEntries`, `projectsReadFile`, `previewList` | `orchestration:read`, `filesystem:read`                  |
| `thread.operate`   | `launchThread`, `dispatchCommand`, `secretsAnswerRequest`                                         | `orchestration:operate`                                  |
| `terminal.operate` | `terminalOpen`, `terminalWrite`, `previewTunnel`                                                  | `terminal:read` / `terminal:operate`                     |
| `preview.operate`  | `previewOpen`, `previewAdjust`                                                                    | `preview:operate`                                        |
| `file.write`       | `projectsWriteFile`, вложения                                                                     | `filesystem:write`, `orchestration:operate`              |
| `source.write`     | `vcs*`, `pullRequests*` (mutate)                                                                  | `source-control:write`                                   |
| `project.settings` | `projectsMutate(update)`, скрипты                                                                 | `orchestration:operate` (+`settings:write` для скриптов) |
| `project.members`  | `members.*`, `invitations.*`                                                                      | `access:read` / `access:write`                           |
| `project.secrets`  | `/api/projects/:id/secrets/*`                                                                     | `providers:manage`                                       |

Правила совместимости:

- `sessionGrantsScope` и `permissions` в `packages/contracts/src/auth.ts` не меняются; старый клиент продолжает декодировать ответы.
- Старые pairing-ссылки и сессии — `binding_kind = environment`: проектная проверка для них возвращает `allow`.
- Скоупы проекта выдаются уже суженными; ссылка, выпущенная project admin, несёт ровно роль-скоупы и `binding_kind = projects` на проект(ы).
- `access:write` у project admin позволяет выпускать только проектные ссылки и отзывать сессии принципалов, с которыми есть общий проект.
- `access:read` входит в любую проектную роль (видеть состав своего проекта), `access:write` — только admin+; список клиентов/ссылок фильтруется проектом.
- Создание проекта — `project:create` (см. «Первый реальный сценарий»): owner — произвольный путь, участник — управляемый корень.
- `serverGetSettings` для участника отдаётся редактированным: провайдеры и их инстансы — без путей/секретов, оверрайды — только его проектов. `serverUpdateSettings` от участника принимает лишь `projectSettingsOverrides[ownProject]` и `projectScriptOverrides[ownProject]`; глобальные поля — owner.
- Роль-скоупы — константы, не строки БД: апгрейд не оставляет устаревших ролей.

### 2.4 Наследование

Тред наследует проект; сабагенты и worktree — тред. Перенос треда между проектами требует `thread.manage` на источнике и `thread.operate` на цели. Guest-ссылка остаётся вне ролей: анонимный токен на один тред, отзывается вместе с share.

Решение: роли, а не произвольные списки скоупов на проект. Альтернатива — ACL-редактор — гибче, но даёт дыры при отзыве и тяжела в UI.

---

## 3. Жизненный цикл доступа

| Шаг                  | Актор                 | Эффект                                                          | Аудит                     |
| -------------------- | --------------------- | --------------------------------------------------------------- | ------------------------- |
| Создание инвайта     | owner / project admin | запись `invitations`, ссылка                                    | `invitation.created`      |
| Принятие             | приглашённый          | принципал (или существующий), членство `active`, сессия         | `invitation.accepted`     |
| Смена роли           | admin+                | новая роль ⊆ потолок                                            | `membership.role.changed` |
| Suspended в проекте  | admin+                | членство `suspended`, проектные сессии перефильтрованы          | `membership.suspended`    |
| Suspended принципал  | owner                 | членство(а) `suspended`, все сессии и устройства отозваны       | `member.suspended`        |
| Возврат              | admin+ / owner        | членство `active`, нужен новый вход                             | `member.reactivated`      |
| Отзыв из проекта     | admin+                | членство `removed`, `accessRevision++`                          | `membership.removed`      |
| Удаление принципала  | owner                 | отзыв всего, членства `removed`, аудит хранит id и снимок имени | `member.removed`          |
| Истечение (external) | планировщик           | `suspended`, письмо владельцу                                   | `membership.expired`      |
| Передача owner       | owner                 | оба активны, подтверждение, старый owner → `member`/admin       | `owner.transferred`       |

Правила:

- Любое изменение поднимает `access_revision` у принципала и глобальный `accessRevision` окружения. RPC сверяет ревизию перед вызовом; стримы перефильтровываются на лету; при потере доступа — close `4403`, после `suspended`/`removed` — `4401` и повторный вход.
- Смена роли не рвёт сессию: следующий вызов видит новую роль. Понижение роли мгновенно убирает методы и элементы стрима.
- Удаление принципала не удаляет треды: авторство остаётся в `createdBy` снимком.
- **Orphan-проекты.** Удаление последнего admin автоматически делает owner admin-ом проекта и пишет уведомление; проект не остаётся без admin-а. Удаление owner-а требует преемника (CLI допускает forced transfer).
- Удаление проекта: `project.delete` (owner). Треды/worktree удаляются по текущей процедуре, членства и инвайты вычищаются, аудит сохраняется.
- Проект в архиве: членство сохраняется, `project.read` работает, запись — нет.

Альтернатива — каждый шаг через подтверждение owner-а: проще в реализации, но не масштабируется на десятки сотрудников. Выбрано делегирование вниз с потолком, потому что отзыв всё равно остаётся у owner-а.

---

## 4. Изоляция

### 4.1 Решение по уровням

| Уровень                          | Что изолирует                           | Где           | Когда                |
| -------------------------------- | --------------------------------------- | ------------- | -------------------- |
| **L0 логический**                | серверная фильтрация ресурсов и стримов | все ОС        | MVP                  |
| **L1 OS-пользователь на проект** | файлы, процессы, git-креды, env         | Linux-серверы | v2, по флагу проекта |
| **L2 контейнер на проект**       | ФС, сеть, ресурсы                       | Linux, сервер | v3, опция            |

L0 обязателен всегда: он даёт UX и защиту от случайных ошибок, но не от злонамеренного участника с терминалом. В L0 `filesystem:read` по-прежнему «что видит ОС-пользователь» — это документируется, а UI показывает бейдж «доступ к хосту».

L1: запуск через `systemd-run --uid=svc-<project>` (или маленький setuid-хелпер); сервер-супервизор не обязан быть root. Корни проектов и worktree переводятся в группу `t3-<project>` с `g+rws`, `stateDir` — 0700 под сервисным пользователем; порты — из диапазона проекта. L1b (альтернатива) — `bwrap`-песочница без создания юзеров: дешевле, но ломается на pty/Node и не даёт git-кред.

L2: podman-контейнер с bind-mount проекта и worktree, сетевым неймспейсом и лимитами cgroup. Дорого на macOS/десктопе; потому v3.

### 4.2 По поверхностям

- **Оркестрация.** `projectId` обязателен в `launchThread`, `dispatchCommand`, `projectsMutate` и в переносе треда. `ProjectAccess` проверяется до `Orchestrator`; сабагент наследует проект родителя, кросс-проектный делегат запрещён. Глобальные списки (`pullRequests*`, `issues*`, `workflows*`, `scheduledTasks*`, `serverGetUsageSummary`, `device*`) сужаются по проекту: PR — по `repositoryIdentity`, issues/задачи/прогоны — по `projectId`, устройства и общая телеметрия — owner.
- **Файлы.** `projectsReadFile` принимает абсолютный host-путь в `relativePath` и не проверяет `cwd`; `projectsListEntries`/`searchContents` верят переданному `cwd`; `filesystemBrowse` не ограничен. Внутри выбранного корня `WorkspaceFileSystem` исправно режет `..` и симлинки через `realpath` ([`WorkspaceFileSystem.ts:590`](../../apps/server/src/workspace/WorkspaceFileSystem.ts)), но сам корень сегодня любой. Добавляется `assertProjectPath(path, capability)` с `realpath` и матчингом самого длинного корня проекта/worktree — на все cwd- и path-методы; environment-чтение (`/`, `~`, `/etc`) остаётся owner-у. `workspaceListFolders` отдаёт только корни его проектов и worktree.
- **Терминал.** `terminalOpen` получает `projectId`; `cwd` обязан лежать в корне проекта или его worktree (сейчас проверяется только `stat` — [`Manager.ts:3309`](../../apps/server/src/terminal/Manager.ts)). Env: `T3_PROJECT_ID`, `T3_MEMBER_ID`; allowlist вместо наследования всего env (v2). `cd ..` наружу в L0 разрешён и подписан в UI.
- **Секреты.** Два уровня: `server_secrets` (owner, существующий `ServerSecretStore`) и `project_secrets` (AES-GCM, ключ сервера, только имена и отпечатки наружу). Ссылки вида `secret://project/<id>/<name>` резолвятся в контексте проекта; env-секреты участнику не видны. Провайдерские ключи остаются owner-скими; `providers:manage` у admin даёт выбор инстанса, не значение.
- **Preview.** Сессия preview несёт `projectId`; `previewOpen` принимает только URL, поднятый тредом проекта, либо порт из диапазона проекта (v2). `/api/preview/tunnel` (raw TCP в loopback, требует `terminal:operate`) получает подписанный токен с `projectId` и TTL 15 минут; порт вне диапазона — 403 `x-t3-tunnel-out-of-scope`.
- **Git-креды.** L0 — общие креды хоста, `source-control:write` только UX-граница. L1 — `GIT_SSH_COMMAND`/askpass на проект из `project_secrets`, свой `safe.directory`; force-push и PR-права проверяются на проект.
- **Worktree.** Каталог worktree на проект (`worktrees/<projectId>/...`), проверка владельца при усыновлении существующего пути; managed-пути уже валидируются (`makeIsManagedWorktreePath`).
- **Вложения и ассеты.** Подписанные URL получают claim `pid` (проект) и `sub` (принципал), TTL 15 минут для участников (сейчас 1 час). Проверка — при выпуске; после отзыва URL живёт до TTL, это документируется. Токен загрузки вложения привязывается к принципалу и треду.
- **Устройства/симуляторы, импорт агентских сессий.** `device:*`, `agentSessionsScan/Import` — owner-only в MVP (общий парк машин и домашние каталоги); в v2 — привязка устройства к проекту.

Компромисс local-first: L0 не требует ни root, ни контейнеров, работает на macOS/Windows и в десктопе. Цена — честно названная слабая граница; переход на L1 — флаг проекта, а не смена модели прав.

---

## 5. Аудит, лимиты, квоты

### 5.1 Аудит

`audit_events`: `id`, `at`, `actor_principal_id`, `actor_session_id`, `action`, `resource_type`, `resource_id`, `project_id`, `ip`, `user_agent`, `outcome` (`allow` | `deny` | `error`), `metadata_json` (редактированный).

Пишем: вход/выход, провалы входа, инвайты и их принятие, смены ролей/потолков/статусов, отзывы сессий и устройств, выдачу PAT, открытие терминала, чтение секрета, выпуск asset-URL, открытие preview-туннеля, отказы авторизации (сэмплирование 1/10 на шумные чтения), экспорт и purge CRM.

Не пишем: значения секретов, тела сообщений, содержимое файлов; только id и отпечатки.

Чтение: owner — всё; admin — свой проект. `GET /api/audit?projectId=&actor=&action=&from=&to=`. Ретенция 90 дней (настройка), purge — owner. Экспорт JSONL. В v2 — hash-chain (`prev_hash`) и проверка `t3 audit verify`.

### 5.2 Лимиты

`member_limits`: сессии/принципал (5), конкурентные терминалы (3), preview-вкладки (4), инвайты/час (10), PAT (10), MCP-клиенты (5). Дефолты в коде, owner переопределяет. Превышение — 429 + `Retry-After`; для терминалов — 409 с id открытых.

### 5.3 Квоты

`project_quotas`: `max_active_threads` (10), `max_worktrees` (5), `disk_bytes` (5 ГБ, мягко), `attachment_bytes` (200 МБ). Проверка в `ThreadLaunchService`, `terminal.Manager`, `attachmentStore`; 80% — предупреждение, 100% — отказ новым треду/worktree/вложению, текущие turn-ы не убиваются. `GET /api/projects/:id/usage`, страница Usage, событие `quota.exceeded`.

Альтернатива — только глобальные лимиты: дешевле, но один проект съедает диск и останавливает остальные. Поэтому лимиты — на принципала (антиабьюз), квоты — на проект (справедливость).

---

## 6. API, токены, вебхуки, версионирование

### 6.1 HTTP

| Метод           | Путь                                | Право                                          |
| --------------- | ----------------------------------- | ---------------------------------------------- |
| POST            | `/api/auth/login`                   | — (лимит)                                      |
| POST            | `/api/auth/token`                   | — (лимит, DPoP)                                |
| POST            | `/api/auth/recovery`                | — (лимит)                                      |
| POST            | `/api/auth/recovery/confirm`        | токен                                          |
| POST            | `/api/invitations`                  | `access:write` + `project.members`             |
| POST            | `/api/invitations/accept`           | токен                                          |
| GET/DELETE      | `/api/invitations[/:id]`            | `access:read` / `access:write`                 |
| GET             | `/api/members`                      | `access:read` (фильтр по проектам)             |
| PATCH/DELETE    | `/api/members/:id`                  | `access:write` (потолок — owner)               |
| GET/PUT/DELETE  | `/api/projects/:id/members[/:pid]`  | `access:read` / `project.members`              |
| GET/PUT/DELETE  | `/api/projects/:id/secrets[/:name]` | `project.secrets`                              |
| GET/POST/DELETE | `/api/tokens[/:id]`                 | свой принципал `потолок ∩ роли`; чужой — owner |
| GET             | `/api/projects/:id/usage`           | `access:read`                                  |
| GET             | `/api/audit`                        | `access:read`                                  |

Кроме входа, восстановления и принятия инвайта — все через `EnvironmentAuthenticatedAuth`, затем `ResourceResolver`.

### 6.2 WS RPC

Новые методы: `membersList`, `memberInvite`, `memberSetRole`, `memberSetCeiling`, `memberSetState`, `memberRemove`, `memberRecover`, `invitationsList`, `invitationRevoke`, `auditList`, `usageGet`, `tokensList`, `tokenCreate`, `tokenRevoke`. Каждый получает запись в `RPC_REQUIRED_SCOPES` (карта исчерпывающая, компилятор заставит).

`RpcAuthorization` расширяется: `requiredScopesForRpcCall` уже умеет смотреть payload — добавляется `requiredResourcesForRpcCall(method, payload)`, возвращающий `{ projectId } | { threadId } | { path } | { terminalId } | ...`. Гейт: скоуп → `ResourceResolver` → `ProjectAccess` → роль. Ошибки: чужой ресурс — `EnvironmentResourceNotFoundError` (404, не палим существование), свой без роли — `EnvironmentAuthorizationError` c `requiredPermission: "project:<cap>"` (403).

### 6.3 MCP

OAuth-одобрение (`McpOAuth`) получает выбор проектов и потолок; сессия несёт `binding_kind = projects`. `mcpClientScopes` расширяется до роль-эквивалента (`read-only` → viewer-скоупы, включая `filesystem:read`), `McpToolAccess` объявляет проектную возможность рядом с уровнем доступа; `threadAccess.ts` проверяет проект цели, а не только лимиты режима. Списки тредов/проектов фильтруются. Peer-link остаётся environment-binding (owner одобряет ссылку).

### 6.4 Токены участника

PAT: префикс `t3p_`, хранится HMAC-хешем, поля `scopes_json`, `binding_kind` (`principal` или `projects`), `binding_json`, `expires_at`, `last_used_at`, `revoked_at`. Выдаёт себе сам участник в пределах `потолок ∩ роли`; owner — любому. В `Authorization: Bearer`, DPoP не обязателен. Показывается один раз.

Альтернатива — только cookie-сессии: не работает для CI и внешних агентов. PAT выбран потому, что он узкий, именованный, с TTL и отдельным отзывом.

### 6.5 Вебхуки

Путь `/api/hooks/<taskId>/<token>` (`ScheduledTaskService.webhookPath`) уже bearer на задачу, подпись задачи уже настраивается (`webhook_secret`, `signature_verified`). Добавляется: проект задачи проверяется при доставке; rate-limit; секрет по умолчанию — проектный; журнал доставок (`scheduledTasksListWebhookDeliveries`/`GetWebhookDelivery`) — только admin-у проекта. Вебхук не получает сессию и не видит чужие проекты.

### 6.6 Версионирование

- `ExecutionEnvironmentCapabilities` (`packages/contracts/src/environment.ts:86`): `members`, `audit`, `projectSecrets`; `ServerAuthDescriptor`: `authMode: "single-owner" | "multi-user"`; `principal`, `binding_kind` и `binding` в состоянии сессии — все новые поля опциональны.
- `AuthAccessSnapshot` дополняется `members`, `invitations`, `revision`; старые клиенты лишние поля игнорируют (Effect Schema), менять существующие — нельзя.
- HTTP: минорный заголовок `T3-Minor`; несовместимость — только через новый major и `426`.
- Депрекация: `legacy`-гранты помечаются в UI, отключаются не раньше чем через два минора.

---

## 7. Миграция установок

Порядок (миграция `112_MultiUser.ts`, идемпотентно):

1. Создать таблицы (`principals`, `principal_credentials`, `project_memberships`, `invitations`, `session_principals(binding_kind, binding_json)`, `project_secrets`, `audit_events`, `member_limits`, `project_quotas`, `api_tokens`).
2. Создать `owner` из текущего subject: desktop-пользователь, subject административного CLI или ОС-пользователь; `display_name` = имя ОС, `email` пуст.
3. Проставить всем живым сессиям `principalId = owner`, `binding_kind = 'environment'`.
4. Всем активным pairing-ссылкам — `binding_kind = 'environment'`, `legacy = 1`; поведение не меняется.
5. `settings.multiUser = false`; включение — `t3 members enable` (после создания owner-пароля/email).
6. Начать писать `audit_events`; старые записи не восстанавливаются.

Совместимость грантов: `sessionGrantsScope`, `permissions`, `access:write`-семантика не меняются. Environment-binding проходит проектные проверки без запросов. Старый клиент на новом сервере видит только разрешённые проекты, потому что фильтрация серверная; отсутствие UI членства ничего не ломает.

Откат: новые таблицы и колонки аддитивны, `principalId` nullable; v1-код их игнорирует и продолжает проверять только скоупы. Сессии, выпущенные новым сервером, валидны на старом (подпись и формат прежние).

Проверка: фикстура `apps/server/src/persistence/testkit/legacyState.ts` — БД до миграции, прогон `upgrade → login старой cookie → RPC` и обратного даунгрейда.

---

## 8. Расширение под CRM

- Ресурсы: `crm_clients`, `crm_contacts`, `crm_notes`, `crm_client_threads` — все с `project_id`; доступ через тот же `ResourceResolver`, что и треды.
- Роль `manager`: `crm.*`, `crm.invite_client`, `thread.operate` только по тредам, связанным с клиентами; без файлов/терминала.
- Внешний `client`: `kind=external`, вход по приглашению, портал `/c/:clientId` — только свои записи и связанные треды. Guest-share остаётся, но токен привязывается к принципалу и отзывается вместе с ним.
- PII: телефоны/email контактов шифруются полем, в событиях — маска; экспорт и DSR (`DELETE ...?purge=true`) — аудит, поле `redacted_at`.
- Метаданные CRM в MCP: `t3_crm_client_search`, `t3_crm_note_add` (v3), в пределах проекта.
- Отдельная БД не нужна: объём на SQLite достаточен до сотен тысяч записей; при росте — вынос CRM в схему-сателлит.

---

## 9. Риски и контрмеры

| #   | Риск                            | Вектор                                                                                                                 | Контрмера                                                                                       | Остаток      |
| --- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------ |
| R1  | Выход из проекта через терминал | `cd /`, абсолютные пути, env                                                                                           | L0 — бейдж и документация; L1 — юзер на проект; тест «побега»                                   | L0 высокий   |
| R2  | Утечка событиями                | shell отдаёт все проекты, глобальные `searchThreads`/`pullRequests*`/`issues*`/`workflows*`, HTTP-snapshot             | фильтр на сервере в `subscribeShell`, HTTP, поиске, PR/issues и MCP; тест на каждый тип события | низкий       |
| R3  | IDOR по id                      | `threadId`, `getTurnItem`, diff, `runId`, `taskId`, `deliveryId`, `deviceId`, `terminalId`, `tabId`, attachment, asset | единый `ResourceResolver`, 404 для чужого, тест-матрица «чужой id на каждый метод»              | низкий       |
| R4  | Секреты в env/на диске          | агент и терминал читают `stateDir/secrets`                                                                             | L1 + отдельный env-allowlist; project_secrets; owner-only reveal                                | средний в L0 |
| R5  | Подписанный asset-URL           | bearer до TTL                                                                                                          | claim `pid`, TTL 15 мин, перевыпуск                                                             | низкий       |
| R6  | Preview-туннель                 | raw TCP в любой loopback-порт                                                                                          | требует `terminal:operate`; порты проекта в v2; бейдж                                           | средний      |
| R7  | MCP                             | OAuth-сессия без привязки                                                                                              | проект и потолок в одобрении; проверка в `threadAccess.ts`; peer-link только owner              | низкий       |
| R8  | Вебхук                          | токен задачи — bearer                                                                                                  | проект при доставке, подпись/секрет проекта, лимит, журнал                                      | низкий       |
| R9  | Git                             | общие креды, push в чужие репо                                                                                         | `source-control:write` на проект; L1 — креды на проект                                          | средний в L0 |
| R10 | Перебор входа                   | слабые пароли, enum email                                                                                              | scrypt, лимиты, одинаковые ошибки, dummy-хеш                                                    | низкий       |
| R11 | Блокировка owner                | потеря пароля/email                                                                                                    | CLI break-glass, обязательный преемник                                                          | низкий       |
| R12 | Исчерпание                      | циклы агента, диск                                                                                                     | лимиты принципала, квоты проекта, 429/409                                                       | средний      |
| R13 | Утечка через гостевые ссылки    | анонимный bearer на тред                                                                                               | TTL, отзыв с share и с членством, «только тред»                                                 | низкий       |

Обязательные тесты безопасности: `apps/server/src/access/ProjectAccess.test.ts`, `.../ResourceResolver.test.ts` (таблица id × метод), `apps/server/src/ws.shellFilter.test.ts` (перечисление всех `OrchestrationV2DomainEvent`), `apps/server/src/http.idor.test.ts`, `apps/server/src/terminal/isolation.test.ts`.

---

## 10. Этапы

Этапы дают обратную связь до того, как усложнять изоляцию. Альтернатива — один большой релиз: короче по календарю, но дольше без проверки модели прав и выше риск переделок.

### MVP — внутренняя команда, L0

Объём: таблицы и контракты; owner из миграции; инвайты/вход/восстановление; потолок, роли, `ProjectAccess`, гейт в `RpcAuthorization`; фильтрация shell/threads/projects/settings; проверки файлов, терминала (`cwd`), preview, assets, вебхуков, MCP; UI участников и аудита; серверный отзыв через `accessRevision`.

Готово, когда: зелёная матрица «роль × метод»; чужой id на каждом ресурсе → 404; ни один тип события не проходит мимо фильтра (тест-перечисление); старый клиент и фикстура старой БД работают; owner не разлогинен; runbook восстановления проверен на копии.

### v2 — внешние сотрудники и Linux-изоляция

Объём: L1 (юзер на проект, `setuid`, порты, git-креды, project_secrets), PAT, email-инвайты, квоты, привязка MCP, hash-chain аудита, проектные секреты вебхуков, passkeys.

Готово, когда: побег из терминала (`cd /`, `stateDir`, чужой проект, env) не удаётся; worktree переустановлены на `svc-*`; у участника нет owner-секретов; квоты и лимиты дают 429/409 без убийства turn-ов.

### v3 — CRM

Объём: ресурсы CRM, роли `manager`/`client`, портал, привязка guest-ссылок к принципалу, маскирование PII, DSR, L2-контейнеры как опция.

Готово, когда: клиент видит только свои записи и треды; экспорт/удаление PII проходят аудит; контейнер-побег по чек-листу закрыт; бюджет задержки UI < 100 мс на списках.

---

## Карта изменений

**Новое:** `packages/contracts/src/membership.ts`, `packages/contracts/src/crm.ts`; `apps/server/src/persistence/Migrations/112_MultiUser.ts`, `.../Principals.ts`, `.../Memberships.ts`, `.../Invitations.ts`, `.../ProjectSecrets.ts`, `.../AuditEvents.ts`, `.../ApiTokens.ts`; `apps/server/src/identity/*`; `apps/server/src/access/{ProjectAccess,ResourceResolver,AccessAudit,MemberLimits,ProjectQuotas}.ts`, `access/http.ts`; `apps/server/src/cli/members.ts`; web: `settings/MembersSettings.tsx`, `settings/ProjectMembersDialog.tsx`, `auth/LoginPage.tsx`, `auth/InviteAcceptPage.tsx`, `auth/RecoveryPage.tsx`, `audit/AuditPage.tsx`; тесты из §9.

**Правки:** `contracts/{auth,rpc,environmentHttp,settings,preview,environment}.ts`; `apps/server/src/auth/{SessionStore,EnvironmentAuth,RpcAuthorization,http}.ts`; `apps/server/src/{ws,http}.ts`; `orchestration-v2/{ShellStream,ThreadStream,ProjectionStore,ProjectStore,ThreadSearch,ThreadLaunchService}.ts`; `workspace/{WorkspaceFileSystem,WorkspaceEntries,KnownWorkspaces}.ts`; `terminal/Manager.ts`; `preview/PreviewTunnel.ts`; `assets/AssetAccess.ts`; `scheduledTasks/ScheduledTaskService.ts`; `mcp/{McpToolAccess,threadAccess,McpOAuth}.ts`; `web/src/components/settings/ConnectionsSettings.tsx`; mobile: `auth/LoginScreen`, `auth/InviteScreen`, `state/session`; i18n `apps/{web,mobile}/src/i18n/translations`; этот документ и [`04_environment-auth.md`](04_environment-auth.md).
