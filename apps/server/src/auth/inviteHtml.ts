const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );

const STYLES = `
  :root { color-scheme: light dark; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 32px 16px; background: #f6f7f9; color: #17191f; }
  main { width: min(100%, 420px); background: #ffffff; border: 1px solid #e2e5ec; border-radius: 12px; padding: 24px; box-sizing: border-box; }
  h1 { margin: 0 0 8px; font-size: 20px; }
  p { margin: 0 0 16px; line-height: 1.5; color: #4b5060; }
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
    p { color: #a0a6b4; }
    input { border-color: #343b4c; }
    button, a.button { background: #e6e8ee; color: #0f1115; }
    #error { color: #fda29b; }
  }
`;

const SCRIPT = `
  (function () {
    var form = document.getElementById("invite-form");
    var codeInput = document.getElementById("code");
    var nameInput = document.getElementById("displayName");
    var submitBtn = document.getElementById("submit");
    var errorEl = document.getElementById("error");
    var readyEl = document.getElementById("ready");
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      errorEl.textContent = "";
      submitBtn.disabled = true;
      fetch("/api/auth/invitations/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: codeInput.value.trim(),
          displayName: nameInput.value.trim()
        })
      }).then(function (response) {
        if (response.ok) {
          form.style.display = "none";
          readyEl.style.display = "block";
          return;
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

export function renderInvitePage(code: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>Accept invitation</title>
    <style>${STYLES}</style>
  </head>
  <body>
    <main>
      <h1>Accept invitation</h1>
      <form id="invite-form">
        <p>Enter your display name to join this T3 Code environment.</p>
        <label for="code">Invitation code</label>
        <input id="code" name="code" type="text" required autocomplete="one-time-code" value="${escapeHtml(code)}" />
        <label for="displayName">Your name</label>
        <input id="displayName" name="displayName" type="text" required autofocus placeholder="Jane Doe" />
        <p id="error" role="alert"></p>
        <button id="submit" type="submit">Join environment</button>
      </form>
      <section id="ready">
        <p>Ready - open the app</p>
        <a class="button" href="/">Open app</a>
      </section>
    </main>
    <script>${SCRIPT}</script>
  </body>
</html>`;
}
