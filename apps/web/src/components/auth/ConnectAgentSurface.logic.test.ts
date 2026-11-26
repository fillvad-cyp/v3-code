import { expect, it } from "vite-plus/test";
import { AuthMcpClientAccess, ProjectId, RuntimeMode } from "@t3tools/contracts";

import {
  agentRedirectUrl,
  resolveApprovalDecision,
  resolveMcpAccess,
} from "./ConnectAgentSurface.logic";

it.each(RuntimeMode.literals)("keeps MCP access within the %s policy ceiling", (maxRuntimeMode) => {
  const ceiling = { organization: "Example", maxRuntimeMode };
  expect(resolveMcpAccess("auto", ceiling, false)).toBe(
    maxRuntimeMode === "full-access" ? "auto" : maxRuntimeMode,
  );
  expect(resolveMcpAccess("read-only", ceiling, false)).toBe("read-only");
  expect(resolveMcpAccess("approval-required", ceiling, false)).toBe("approval-required");
});

it("checks a typed code even in a signed-in browser, and approves without one at Read only", () => {
  const signedOut = {
    clientName: "Poke",
    redirectHost: "poke.com",
    environmentHost: "prod-a1.t3coderelay.com",
  };
  const details = { ...signedOut, csrfToken: "csrf", oneClickAccess: AuthMcpClientAccess.literals };
  const access = resolveMcpAccess(null, undefined, false);

  // A typed code starts at Auto, and an expired one must fail rather than fall back to this session.
  expect(
    resolveApprovalDecision({
      code: " 7K2P9QXR4MZT ",
      access: resolveMcpAccess(null, undefined, true),
      details,
    }),
  ).toEqual({ _tag: "pairing-code", access: "auto", code: "7K2P9QXR4MZT" });
  expect(resolveApprovalDecision({ code: "auto-q8rz3nwd5ktc", access, details })).toEqual({
    _tag: "pairing-code",
    access: "auto",
    code: "auto-q8rz3nwd5ktc",
  });
  expect(resolveApprovalDecision({ code: "", access, details })).toEqual({
    _tag: "browser-session",
    access: "read-only",
    csrfToken: "csrf",
  });
  expect(resolveApprovalDecision({ code: "", access, details: signedOut })).toBeNull();
});

it("follows only https or loopback http redirects to an agent", () => {
  expect(agentRedirectUrl("https://www.cursor.com/cb?code=x")).toBe(
    "https://www.cursor.com/cb?code=x",
  );
  expect(agentRedirectUrl("http://localhost:51234/callback?code=x")).toBe(
    "http://localhost:51234/callback?code=x",
  );
  for (const url of [
    "javascript:alert(document.domain)",
    "data:text/html,hi",
    "http://evil.example/cb",
    "not a url",
  ]) {
    expect(agentRedirectUrl(url), url).toBeNull();
  }
});

it("carries project scoping and ceiling for MCP clients, requires projects for members, and strips them for peer links", () => {
  const projectA = ProjectId.make("project:a");
  const baseDetails = {
    clientName: "Claude Code",
    redirectHost: "localhost",
    environmentHost: "hub.example.test",
    csrfToken: "csrf",
    oneClickAccess: AuthMcpClientAccess.literals,
  };

  expect(
    resolveApprovalDecision({
      code: "",
      access: "auto",
      details: { ...baseDetails, approverIsOwner: true },
      projectIds: [projectA],
      ceiling: "restricted",
    }),
  ).toEqual({
    _tag: "browser-session",
    access: "auto",
    csrfToken: "csrf",
    projectIds: [projectA],
    ceiling: "restricted",
  });

  // Members must select at least one project.
  expect(
    resolveApprovalDecision({
      code: "",
      access: "approval-required",
      details: { ...baseDetails, approverIsOwner: false },
      projectIds: [],
      ceiling: "restricted",
    }),
  ).toBeNull();
  expect(
    resolveApprovalDecision({
      code: "",
      access: "approval-required",
      details: { ...baseDetails, approverIsOwner: false },
      projectIds: [projectA],
      ceiling: "restricted",
    }),
  ).toEqual({
    _tag: "browser-session",
    access: "approval-required",
    csrfToken: "csrf",
    projectIds: [projectA],
    ceiling: "restricted",
  });

  // Peer links remain environment-bound.
  expect(
    resolveApprovalDecision({
      code: "",
      access: "auto",
      details: { ...baseDetails, approverIsOwner: true, isPeerLink: true },
      projectIds: [projectA],
      ceiling: "restricted",
    }),
  ).toEqual({
    _tag: "browser-session",
    access: "auto",
    csrfToken: "csrf",
  });
});
