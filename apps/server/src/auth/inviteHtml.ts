import type { InvitationPreview, InvitationPreviewReason, ProjectRole } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );

const ROLE_DISPLAY_NAMES: Readonly<Record<ProjectRole, string>> = {
  viewer: "Viewer",
  operator: "Operator",
  developer: "Developer",
  manager: "Manager",
  admin: "Admin",
  owner: "Owner",
};

const ROLE_DESCRIPTIONS: Readonly<Record<ProjectRole, string>> = {
  viewer: "Read-only access to threads and files",
  operator: "Run agents, terminal commands, and previews",
  developer: "Edit code, run terminals, and work with agents",
  manager: "Operate threads and manage CRM clients",
  admin: "Manage project members and settings",
  owner: "Full environment access",
};

function invalidReasonHeading(reason: InvitationPreviewReason | undefined): string {
  switch (reason) {
    case "expired":
      return "Invitation expired";
    case "used":
      return "Invitation already used";
    case "revoked":
      return "Invitation revoked";
    case "not_found":
    case undefined:
      return "Invitation not found";
  }
}

function invalidReasonDetail(reason: InvitationPreviewReason | undefined): string {
  switch (reason) {
    case "expired":
      return "This invitation link has expired. Ask the project admin or owner to create a new link.";
    case "used":
      return "This invitation link has already been accepted and cannot be used again.";
    case "revoked":
      return "This invitation link was revoked before it could be accepted.";
    case "not_found":
    case undefined:
      return "This invitation link is invalid or could not be found. Check the link and try again.";
  }
}

function formatUtcTimestamp(iso: string): string {
  const parsed = DateTime.make(iso);
  if (Option.isNone(parsed)) {
    return iso;
  }
  return DateTime.formatIso(parsed.value)
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
}

const STYLES = `
  :root { color-scheme: light dark; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 32px 16px; background: #f6f7f9; color: #17191f; }
  main { width: min(100%, 440px); background: #ffffff; border: 1px solid #e2e5ec; border-radius: 12px; padding: 24px; box-sizing: border-box; }
  .brand { font-size: 12px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: #5f6678; margin: 0 0 8px; }
  h1 { margin: 0 0 8px; font-size: 20px; }
  p { margin: 0 0 16px; line-height: 1.5; color: #4b5060; }
  .summary { border: 1px solid #e2e5ec; background: #f9fafc; border-radius: 10px; padding: 12px 14px; margin: 0 0 18px; display: grid; gap: 8px; }
  .summary-row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; font-size: 13px; }
  .summary-label { color: #5f6678; }
  .summary-value { font-weight: 600; text-align: right; color: #17191f; }
  .summary-hint { font-size: 12px; color: #5f6678; margin: 0; }
  label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; margin-bottom: 14px; border-radius: 8px; border: 1px solid #cfd5e2; background: inherit; color: inherit; font-size: 15px; }
  input[name="code"] { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.08em; text-transform: uppercase; }
  button, a.button { display: inline-block; width: 100%; box-sizing: border-box; text-align: center; text-decoration: none; padding: 10px 14px; border-radius: 8px; border: 0; background: #17191f; color: #ffffff; font-size: 15px; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: default; }
  #error { color: #b42318; font-size: 14px; min-height: 20px; margin: 0 0 12px; }
  #ready { display: none; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f1115; color: #e6e8ee; }
    main { background: #171a21; border-color: #2a2f3d; }
    .brand, .summary-label, .summary-hint { color: #8c93a5; }
    .summary { background: #12151b; border-color: #262c3a; }
    .summary-value { color: #e6e8ee; }
    p { color: #a0a6b4; }
    input { border-color: #343b4c; }
    button, a.button { background: #e6e8ee; color: #0f1115; }
    #error { color: #fda29b; }
  }
`;

const SCRIPT = `
  (function () {
    var timeEl = document.getElementById("expires-at");
    if (timeEl && timeEl.dateTime) {
      var parsed = new Date(timeEl.dateTime);
      if (!isNaN(parsed.getTime())) {
        try {
          timeEl.textContent = new Intl.DateTimeFormat(undefined, {
            dateStyle: "medium",
            timeStyle: "short"
          }).format(parsed);
        } catch (_err) {}
      }
    }
    var form = document.getElementById("invite-form");
    if (!form) return;
    var codeInput = document.getElementById("code");
    var nameInput = document.getElementById("displayName");
    var submitBtn = document.getElementById("submit");
    var errorEl = document.getElementById("error");
    var readyEl = document.getElementById("ready");
    var openAppLink = document.getElementById("open-app");
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      errorEl.textContent = "";
      submitBtn.disabled = true;
      var payload = { code: codeInput.value.trim() };
      if (nameInput) {
        payload.displayName = nameInput.value.trim();
      }
      fetch("/api/auth/invitations/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      }).then(function (response) {
        if (response.ok) {
          return response.json().catch(function () { return {}; }).then(function (body) {
            var targetUrl = body && typeof body.projectId === "string" && body.projectId.length > 0
              ? "/?project=" + encodeURIComponent(body.projectId)
              : "/";
            if (openAppLink) {
              openAppLink.setAttribute("href", targetUrl);
            }
            form.style.display = "none";
            readyEl.style.display = "block";
            window.location.assign(targetUrl);
          });
        }
        return response.json().catch(function () { return {}; }).then(function (body) {
          errorEl.textContent = (body && body.message) || "Could not accept invitation.";
          submitBtn.disabled = false;
        });
      }).catch(function () {
        errorEl.textContent = "Network error. Please try again.";
        submitBtn.disabled = false;
      });
    });
  })();
`;

export interface InvitePageRenderInput {
  readonly code: string;
  readonly preview: InvitationPreview;
  readonly existingMemberName?: string | null;
}

export function renderInvitePage({
  code,
  preview,
  existingMemberName = null,
}: InvitePageRenderInput): string {
  if (!preview.valid) {
    const heading = invalidReasonHeading(preview.reason);
    const detail = invalidReasonDetail(preview.reason);
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>${escapeHtml(heading)} · V3 Code</title>
    <style>${STYLES}</style>
  </head>
  <body>
    <main>
      <p class="brand">V3 Code</p>
      <h1>${escapeHtml(heading)}</h1>
      <p>${escapeHtml(detail)}</p>
      <a class="button" href="/">Open V3 Code</a>
    </main>
  </body>
</html>`;
  }

  const roleName = preview.role ? ROLE_DISPLAY_NAMES[preview.role] : "Member";
  const roleHint = preview.role ? ROLE_DESCRIPTIONS[preview.role] : null;
  const projectLabel = preview.projectTitle ?? "Environment-wide access";
  const expiresAt = preview.expiresAt ?? "";
  const isExistingMember = existingMemberName !== null && existingMemberName.trim().length > 0;
  const joinButtonLabel = isExistingMember
    ? "Accept invitation"
    : preview.projectTitle
      ? "Join project"
      : "Join environment";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>Accept invitation · V3 Code</title>
    <style>${STYLES}</style>
  </head>
  <body>
    <main>
      <p class="brand">V3 Code</p>
      <h1>Accept invitation</h1>
      <div class="summary">
        <div class="summary-row">
          <span class="summary-label">Project</span>
          <span class="summary-value">${escapeHtml(projectLabel)}</span>
        </div>
        <div class="summary-row">
          <span class="summary-label">Role</span>
          <span class="summary-value">${escapeHtml(roleName)}</span>
        </div>
        ${roleHint ? `<p class="summary-hint">${escapeHtml(roleHint)}</p>` : ""}
        ${
          expiresAt
            ? `<div class="summary-row">
          <span class="summary-label">Expires</span>
          <time id="expires-at" class="summary-value" datetime="${escapeHtml(expiresAt)}">${escapeHtml(formatUtcTimestamp(expiresAt))}</time>
        </div>`
            : ""
        }
      </div>
      <form id="invite-form">
        ${
          isExistingMember
            ? `<p>Signed in as <strong>${escapeHtml(existingMemberName)}</strong>. Accept this invitation to add this access to your V3 Code account.</p>
        <input id="code" name="code" type="hidden" value="${escapeHtml(code)}" />`
            : `<p>Enter your display name to join this V3 Code ${preview.projectTitle ? "project" : "environment"}.</p>
        <label for="code">Invitation code</label>
        <input id="code" name="code" type="text" required autocomplete="one-time-code" value="${escapeHtml(code)}" />
        <label for="displayName">Your name</label>
        <input id="displayName" name="displayName" type="text" required autofocus placeholder="Jane Doe" />`
        }
        <p id="error" role="alert"></p>
        <button id="submit" type="submit">${escapeHtml(joinButtonLabel)}</button>
      </form>
      <section id="ready">
        <p>Ready - open the app</p>
        <a id="open-app" class="button" href="/">Open app</a>
      </section>
    </main>
    <script>${SCRIPT}</script>
  </body>
</html>`;
}
