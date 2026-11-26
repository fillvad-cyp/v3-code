import {
  type AuditEvent,
  type AuthSessionState,
  EnvironmentId,
  type MemberWithMemberships,
  PrincipalId,
  ProjectId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  AUDIT_PAGE_SIZE,
  EMPTY_AUDIT_FILTERS,
  auditLogReducer,
  auditOutcomeBadgeVariant,
  buildAuditQueryInput,
  createInitialAuditLogState,
  deriveAuditLogGate,
  formatAuditResource,
  hasActiveAuditFilters,
  validateAuditRetentionDays,
} from "./AuditLogSettings.logic";

const envId = EnvironmentId.make("env-1");
const projectA = ProjectId.make("proj-a");
const projectB = ProjectId.make("proj-b");
const ownerPrincipalId = PrincipalId.make("owner");
const adminPrincipalId = PrincipalId.make("admin-1");
const devPrincipalId = PrincipalId.make("dev-1");

const multiUserAuth: AuthSessionState["auth"] = {
  policy: "loopback-browser",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["browser-session-cookie", "bearer-access-token"],
  sessionCookieName: "t3_session",
  authMode: "multi-user",
};

const makeEvent = (id: number, overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  id,
  at: `2026-11-26T0${id}:00:00.000Z`,
  actorPrincipalId: ownerPrincipalId,
  actorSessionId: null,
  action: "login.succeeded",
  resourceType: "session",
  resourceId: `sess-${id}`,
  projectId: projectA,
  ip: "127.0.0.1",
  userAgent: null,
  outcome: "allow",
  metadata: null,
  ...overrides,
});

const ownerSession = (): AuthSessionState => ({
  authenticated: true,
  auth: multiUserAuth,
  scopes: ["access:read", "access:write", "environment:maintain"],
  principal: {
    id: ownerPrincipalId,
    kind: "owner",
    displayName: "Owner",
    email: null,
    status: "active",
    ceiling: [],
    accessRevision: 1,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    removedAt: null,
  },
  binding: { _tag: "environment" },
  role: "owner",
});

const memberSession = (
  principalId: PrincipalId,
  role: "admin" | "developer",
): AuthSessionState => ({
  authenticated: true,
  auth: multiUserAuth,
  scopes: ["access:read", "orchestration:read"],
  principal: {
    id: principalId,
    kind: "member",
    displayName: role === "admin" ? "Admin" : "Developer",
    email: null,
    status: "active",
    ceiling: ["access:read"],
    accessRevision: 1,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    removedAt: null,
  },
  binding: { _tag: "principal" },
  role,
});

const membersFixture: ReadonlyArray<MemberWithMemberships> = [
  {
    principal: memberSession(adminPrincipalId, "admin").principal!,
    memberships: [
      {
        projectId: projectA,
        principalId: adminPrincipalId,
        role: "admin",
        state: "active",
        invitedBy: ownerPrincipalId,
        expiresAt: null,
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
      },
      {
        projectId: projectB,
        principalId: adminPrincipalId,
        role: "developer",
        state: "active",
        invitedBy: ownerPrincipalId,
        expiresAt: null,
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
      },
    ],
  },
  {
    principal: memberSession(devPrincipalId, "developer").principal!,
    memberships: [
      {
        projectId: projectA,
        principalId: devPrincipalId,
        role: "developer",
        state: "active",
        invitedBy: ownerPrincipalId,
        expiresAt: null,
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
      },
    ],
  },
];

describe("deriveAuditLogGate", () => {
  it("gates visibility on capabilities.audit and owner/admin role", () => {
    expect(
      deriveAuditLogGate({
        environmentId: envId,
        session: ownerSession(),
        sessionPending: false,
        sessionHasError: false,
        auditSupported: false,
        canReadAccess: true,
        members: [],
        membersPending: false,
      }),
    ).toMatchObject({ mode: "unsupported", visible: false });

    expect(
      deriveAuditLogGate({
        environmentId: envId,
        session: ownerSession(),
        sessionPending: false,
        sessionHasError: false,
        auditSupported: true,
        canReadAccess: true,
        members: [],
        membersPending: false,
      }),
    ).toMatchObject({ mode: "ready", visible: true, isOwner: true, adminProjectIds: null });

    expect(
      deriveAuditLogGate({
        environmentId: envId,
        session: memberSession(adminPrincipalId, "admin"),
        sessionPending: false,
        sessionHasError: false,
        auditSupported: true,
        canReadAccess: true,
        members: membersFixture,
        membersPending: false,
      }),
    ).toMatchObject({ mode: "ready", visible: true, isOwner: false, adminProjectIds: [projectA] });

    expect(
      deriveAuditLogGate({
        environmentId: envId,
        session: memberSession(devPrincipalId, "developer"),
        sessionPending: false,
        sessionHasError: false,
        auditSupported: true,
        canReadAccess: true,
        members: membersFixture,
        membersPending: false,
      }),
    ).toMatchObject({ mode: "forbidden", visible: false });

    // While memberships are still loading for a principal session, wait instead of flashing forbidden.
    expect(
      deriveAuditLogGate({
        environmentId: envId,
        session: memberSession(adminPrincipalId, "admin"),
        sessionPending: false,
        sessionHasError: false,
        auditSupported: true,
        canReadAccess: true,
        members: [],
        membersPending: true,
      }),
    ).toMatchObject({ mode: "loading-access", visible: false, shouldFetchMembers: true });
  });
});

describe("auditLogReducer filter & pagination state machine", () => {
  it("transitions cleanly through initial load, load-more pagination with dedup, filter change, stale drop, and reset", () => {
    let state = createInitialAuditLogState();
    expect(state.status).toBe("idle");
    expect(state.requestId).toBe(1);

    // Initial fetch starts and succeeds with nextCursor.
    state = auditLogReducer(state, { type: "fetchStart", requestId: 1, append: false });
    expect(state.status).toBe("loading");

    const page1 = [makeEvent(5), makeEvent(4)];
    state = auditLogReducer(state, {
      type: "fetchSuccess",
      requestId: 1,
      append: false,
      events: page1,
      nextCursor: 4,
    });
    expect(state.status).toBe("ready");
    expect(state.events.map((e) => e.id)).toEqual([5, 4]);
    expect(state.nextCursor).toBe(4);

    // Load more appends and deduplicates overlapping ids.
    state = auditLogReducer(state, { type: "fetchStart", requestId: 1, append: true });
    expect(state.status).toBe("loading-more");

    state = auditLogReducer(state, {
      type: "fetchSuccess",
      requestId: 1,
      append: true,
      events: [makeEvent(4), makeEvent(3), makeEvent(2)],
      nextCursor: null,
    });
    expect(state.status).toBe("ready");
    expect(state.events.map((e) => e.id)).toEqual([5, 4, 3, 2]);
    expect(state.nextCursor).toBeNull();

    // Changing a filter clears events, clears cursor, and bumps requestId.
    state = auditLogReducer(state, { type: "setFilter", field: "action", value: "login.failed" });
    expect(state.filters.action).toBe("login.failed");
    expect(state.events).toEqual([]);
    expect(state.nextCursor).toBeNull();
    expect(state.requestId).toBe(2);
    expect(hasActiveAuditFilters(state.filters)).toBe(true);

    // Setting the same filter value is a no-op.
    const sameState = auditLogReducer(state, {
      type: "setFilter",
      field: "action",
      value: "login.failed",
    });
    expect(sameState).toBe(state);

    // Stale response from requestId 1 is ignored.
    const afterStale = auditLogReducer(state, {
      type: "fetchSuccess",
      requestId: 1,
      append: false,
      events: [makeEvent(99)],
      nextCursor: 99,
    });
    expect(afterStale).toBe(state);

    // Error for active requestId sets error state; reset clears filters and error.
    state = auditLogReducer(state, { type: "fetchError", requestId: 2, message: "Network error" });
    expect(state.status).toBe("error");
    expect(state.error).toBe("Network error");

    state = auditLogReducer(state, { type: "resetFilters" });
    expect(state.filters).toEqual(EMPTY_AUDIT_FILTERS);
    expect(state.error).toBeNull();
    expect(state.requestId).toBe(3);
  });
});

describe("buildAuditQueryInput & helpers", () => {
  it("builds valid query inputs and rejects invalid dates or reversed ranges", () => {
    expect(buildAuditQueryInput(EMPTY_AUDIT_FILTERS)).toEqual({
      ok: true,
      input: { limit: AUDIT_PAGE_SIZE },
    });

    const filtered = buildAuditQueryInput(
      {
        projectId: projectA,
        actorPrincipalId: adminPrincipalId,
        action: "authorization.denied",
        from: "2026-11-25T10:00:00.000Z",
        to: "2026-11-26T10:00:00.000Z",
      },
      { cursor: 42, limit: 25 },
    );
    expect(filtered).toEqual({
      ok: true,
      input: {
        projectId: projectA,
        actorPrincipalId: adminPrincipalId,
        action: "authorization.denied",
        from: "2026-11-25T10:00:00.000Z",
        to: "2026-11-26T10:00:00.000Z",
        cursor: 42,
        limit: 25,
      },
    });

    expect(buildAuditQueryInput({ ...EMPTY_AUDIT_FILTERS, from: "not-a-date" }).ok).toBe(false);
    expect(
      buildAuditQueryInput({
        ...EMPTY_AUDIT_FILTERS,
        from: "2026-11-26T12:00:00.000Z",
        to: "2026-11-25T12:00:00.000Z",
      }).ok,
    ).toBe(false);
  });

  it("validates retention days and formats outcomes and resources", () => {
    expect(validateAuditRetentionDays("90")).toEqual({ ok: true, days: 90 });
    expect(validateAuditRetentionDays("1")).toEqual({ ok: true, days: 1 });
    expect(validateAuditRetentionDays("3650")).toEqual({ ok: true, days: 3650 });
    expect(validateAuditRetentionDays("0").ok).toBe(false);
    expect(validateAuditRetentionDays("-5").ok).toBe(false);
    expect(validateAuditRetentionDays("3651").ok).toBe(false);
    expect(validateAuditRetentionDays("12.5").ok).toBe(false);

    expect(auditOutcomeBadgeVariant("allow")).toBe("success");
    expect(auditOutcomeBadgeVariant("deny")).toBe("warning");
    expect(auditOutcomeBadgeVariant("error")).toBe("error");
    expect(formatAuditResource({ resourceType: "membership", resourceId: "proj:u1" })).toBe(
      "Membership · proj:u1",
    );
    expect(formatAuditResource({ resourceType: null, resourceId: null })).toBeNull();
  });
});
