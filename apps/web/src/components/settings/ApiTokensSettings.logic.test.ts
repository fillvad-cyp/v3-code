import {
  ApiTokenId,
  AuthAccessReadScope,
  AuthEnvironmentMaintainScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  EnvironmentId,
  PrincipalId,
  ProjectId,
  type ApiTokenListItem,
  type AuthSessionState,
  type MemberWithMemberships,
  ceilingScopes,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  assignableRolesForGrantedRole,
  canBindToPrincipal,
  computeExpiresAtIso,
  deriveApiTokenStatus,
  deriveApiTokensGate,
  formatApiTokenErrorMessage,
  resolveBindableProjects,
  resolveEffectiveScopesForToken,
  sortApiTokens,
} from "./ApiTokensSettings.logic";

const ENV_ID = EnvironmentId.make("env-1");
const OWNER_ID = PrincipalId.make("owner");
const DEV_ID = PrincipalId.make("member-dev");
const PROJECT_A = ProjectId.make("project-a");
const PROJECT_B = ProjectId.make("project-b");
const NOW_ISO = "2026-11-26T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

const AUTH_DESCRIPTOR = {
  policy: "remote-reachable" as const,
  bootstrapMethods: ["one-time-token" as const],
  sessionMethods: ["browser-session-cookie" as const],
  sessionCookieName: "t3_session",
  authMode: "multi-user" as const,
};

const ownerSession: AuthSessionState = {
  authenticated: true,
  auth: AUTH_DESCRIPTOR,
  scopes: [...AuthStandardClientScopes],
  permissions: [...AuthStandardClientScopes],
  sessionMethod: "browser-session-cookie",
  principal: {
    id: OWNER_ID,
    kind: "owner",
    displayName: "Owner",
    email: null,
    status: "active",
    ceiling: [],
    accessRevision: 0,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    removedAt: null,
  },
  binding_kind: "environment",
  binding: { _tag: "environment" },
  role: "owner",
};

const devMember: MemberWithMemberships = {
  principal: {
    id: DEV_ID,
    kind: "member",
    displayName: "Alice",
    email: null,
    status: "active",
    ceiling: [...ceilingScopes("restricted")],
    accessRevision: 0,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    removedAt: null,
  },
  memberships: [
    {
      projectId: PROJECT_A,
      principalId: DEV_ID,
      role: "developer",
      state: "active",
      invitedBy: OWNER_ID,
      expiresAt: null,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    },
    {
      projectId: PROJECT_B,
      principalId: DEV_ID,
      role: "admin",
      state: "suspended",
      invitedBy: OWNER_ID,
      expiresAt: null,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    },
  ],
};

const devSession: AuthSessionState = {
  authenticated: true,
  auth: AUTH_DESCRIPTOR,
  scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope, AuthAccessReadScope],
  permissions: [
    AuthOrchestrationReadScope,
    AuthOrchestrationOperateScope,
    AuthFilesystemReadScope,
    AuthFilesystemWriteScope,
    AuthAccessReadScope,
  ],
  sessionMethod: "browser-session-cookie",
  principal: devMember.principal,
  binding_kind: "principal",
  binding: { _tag: "principal" },
  role: "developer",
};

describe("ApiTokensSettings.logic", () => {
  it("derives gate mode from session state", () => {
    expect(
      deriveApiTokensGate({
        environmentId: null,
        session: null,
        sessionPending: false,
        sessionHasError: false,
      }).mode,
    ).toBe("no-environment");

    const ownerGate = deriveApiTokensGate({
      environmentId: ENV_ID,
      session: ownerSession,
      sessionPending: false,
      sessionHasError: false,
    });
    expect(ownerGate).toEqual({
      mode: "ready",
      visible: true,
      isOwner: true,
      principalId: OWNER_ID,
    });

    const devGate = deriveApiTokensGate({
      environmentId: ENV_ID,
      session: devSession,
      sessionPending: false,
      sessionHasError: false,
    });
    expect(devGate).toEqual({
      mode: "ready",
      visible: true,
      isOwner: false,
      principalId: DEV_ID,
    });
  });

  it("sorts active tokens ahead of expired and revoked tokens", () => {
    const active: ApiTokenListItem = {
      id: ApiTokenId.make("tok-active"),
      principalId: DEV_ID,
      scopes: [AuthOrchestrationReadScope],
      binding: { _tag: "principal" },
      expiresAt: "2026-12-26T12:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null,
      createdAt: "2026-11-25T12:00:00.000Z",
    };
    const expired: ApiTokenListItem = {
      ...active,
      id: ApiTokenId.make("tok-expired"),
      expiresAt: "2026-11-26T11:00:00.000Z",
      createdAt: "2026-11-26T10:00:00.000Z",
    };
    const revoked: ApiTokenListItem = {
      ...active,
      id: ApiTokenId.make("tok-revoked"),
      revokedAt: "2026-11-26T11:30:00.000Z",
      createdAt: "2026-11-26T11:00:00.000Z",
    };

    expect(deriveApiTokenStatus(active, NOW_MS)).toBe("active");
    expect(deriveApiTokenStatus(expired, NOW_MS)).toBe("expired");
    expect(deriveApiTokenStatus(revoked, NOW_MS)).toBe("revoked");
    expect(sortApiTokens([revoked, expired, active], NOW_MS).map((t) => t.id)).toEqual([
      "tok-active",
      "tok-expired",
      "tok-revoked",
    ]);
  });

  it("computes effective scopes intersected with ceiling and selected project roles", () => {
    // Restricted ceiling excludes filesystem:write even though developer role has it.
    const devPrincipalScopes = resolveEffectiveScopesForToken({
      session: devSession,
      isOwner: false,
      targetPrincipalId: DEV_ID,
      members: [devMember],
      bindingMode: "principal",
      selectedProjectRoles: [],
    });
    expect(devPrincipalScopes).toContain(AuthOrchestrationReadScope);
    expect(devPrincipalScopes).toContain(AuthOrchestrationOperateScope);
    expect(devPrincipalScopes).not.toContain(AuthFilesystemWriteScope);
    expect(devPrincipalScopes).not.toContain(AuthEnvironmentMaintainScope);

    // Narrowing to viewer project role removes orchestration:operate.
    const viewerBoundScopes = resolveEffectiveScopesForToken({
      session: devSession,
      isOwner: false,
      targetPrincipalId: DEV_ID,
      members: [devMember],
      bindingMode: "projects",
      selectedProjectRoles: ["viewer"],
    });
    expect(viewerBoundScopes).toEqual([
      AuthOrchestrationReadScope,
      AuthFilesystemReadScope,
      AuthAccessReadScope,
    ]);
  });

  it("resolves bindable projects and assignable roles without sibling cross-grants", () => {
    expect(assignableRolesForGrantedRole("operator")).toEqual(["viewer", "operator"]);
    expect(assignableRolesForGrantedRole("manager")).toEqual(["viewer", "manager"]);

    const devProjects = resolveBindableProjects({
      session: devSession,
      isOwner: false,
      targetPrincipalId: DEV_ID,
      members: [devMember],
      projects: [
        { id: PROJECT_A, title: "Alpha" },
        { id: PROJECT_B, title: "Beta" },
      ],
    });
    expect(devProjects.map((p) => p.projectId)).toEqual([PROJECT_A]);
    expect(devProjects[0]?.defaultRole).toBe("developer");
    expect(canBindToPrincipal(devSession)).toBe(true);
    expect(
      canBindToPrincipal({
        ...devSession,
        binding_kind: "projects",
        binding: { _tag: "projects", projects: [{ projectId: PROJECT_A, role: "viewer" }] },
      }),
    ).toBe(false);
  });

  it("computes expiration presets and formats 429 limit errors", () => {
    expect(computeExpiresAtIso("never", NOW_MS)).toBeNull();
    expect(computeExpiresAtIso("7d", NOW_MS)).toBe("2026-12-03T12:00:00.000Z");
    expect(formatApiTokenErrorMessage(new Error("Active API token limit reached (10)."))).toContain(
      "API token limit reached",
    );
  });
});
