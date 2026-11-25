import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { AuthBrowserSessionResult, AuthPairingCredentialResult, AuthPairingLink } from "./auth.ts";
import { EnvironmentResourceNotFoundError } from "./environmentHttp.ts";
import {
  boundProjectIds,
  boundProjectRole,
  passesProjectChecks,
  Principal,
  ProjectCapability,
  ProjectForbiddenError,
  ProjectRole,
  SessionBinding,
} from "./membership.ts";
import { PrincipalId, ProjectId } from "./baseSchemas.ts";

const decodeRole = Schema.decodeUnknownSync(ProjectRole);
const decodeBinding = Schema.decodeUnknownSync(SessionBinding);
const decodeCapability = Schema.decodeUnknownSync(ProjectCapability);

describe("project roles", () => {
  it("accepts the roles and nothing else", () => {
    for (const role of ["viewer", "operator", "developer", "manager", "admin", "owner"]) {
      expect(decodeRole(role)).toBe(role);
    }
    expect(() => decodeRole("")).toThrow();
    expect(() => decodeRole("member")).toThrow();
  });

  it("names a capability in the required permission form", () => {
    expect(decodeCapability("project:read")).toBe("project:read");
    expect(decodeCapability("project:thread.operate")).toBe("project:thread.operate");
    expect(() => decodeCapability("read")).toThrow();
  });
});

describe("session binding", () => {
  it("carries no projects for the environment-wide and principal bindings", () => {
    expect(decodeBinding({ _tag: "environment" })).toEqual({ _tag: "environment" });
    expect(decodeBinding({ _tag: "principal" })).toEqual({ _tag: "principal" });
  });

  it("carries a role for every project a narrow binding reaches", () => {
    const binding = decodeBinding({
      _tag: "projects",
      projects: [
        { projectId: ProjectId.make("project-a"), role: "developer" },
        { projectId: ProjectId.make("project-b"), role: "viewer" },
      ],
    });
    expect(boundProjectIds(binding)).toEqual(new Set(["project-a", "project-b"]));
    expect(boundProjectRole(binding, "project-a")).toBe("developer");
    expect(boundProjectRole(binding, "project-c")).toBeUndefined();
  });

  it("rejects a project without a role and an unknown tag", () => {
    expect(() => decodeBinding({ _tag: "projects", projects: [{ projectId: "a" }] })).toThrow();
    expect(() => decodeBinding({ _tag: "organization" })).toThrow();
  });

  it("treats an absent binding as the environment, which passes project checks", () => {
    expect(passesProjectChecks(undefined)).toBe(true);
    expect(passesProjectChecks({ _tag: "environment" })).toBe(true);
    expect(passesProjectChecks({ _tag: "principal" })).toBe(false);
    expect(passesProjectChecks({ _tag: "projects", projects: [] })).toBe(false);
    expect(boundProjectIds({ _tag: "principal" })).toBeUndefined();
  });
});

describe("membership errors", () => {
  const encodeNotFound = Schema.encodeSync(EnvironmentResourceNotFoundError);
  const decodeNotFound = Schema.decodeUnknownSync(EnvironmentResourceNotFoundError);
  const encodeForbidden = Schema.encodeSync(ProjectForbiddenError);
  const decodeForbidden = Schema.decodeUnknownSync(ProjectForbiddenError);

  it("hides a foreign resource behind a 404-shaped error", () => {
    const error = new EnvironmentResourceNotFoundError({
      code: "not_found",
      reason: "resource_not_found",
      traceId: "trace-1",
    });
    expect(decodeNotFound(encodeNotFound(error))).toMatchObject({
      _tag: "EnvironmentResourceNotFoundError",
      reason: "resource_not_found",
    });
  });

  it("names the missing capability for a resource of the session's own project", () => {
    const error = new ProjectForbiddenError({
      message: "developer is required",
      projectId: ProjectId.make("project-a"),
      requiredPermission: "project:file.write",
    });
    expect(decodeForbidden(encodeForbidden(error))).toMatchObject({
      _tag: "project_forbidden",
      projectId: ProjectId.make("project-a"),
      requiredPermission: "project:file.write",
    });
  });
});

// New binding fields are optional, so a server or client from before them keeps decoding.
describe("binding fields on auth payloads", () => {
  const decodePairingLink = Schema.decodeUnknownSync(AuthPairingLink);
  const legacyPairingLink = {
    id: "link-1",
    scopes: ["orchestration:read"] as const,
    subject: "desktop",
    createdAt: DateTime.makeUnsafe(0),
    expiresAt: DateTime.makeUnsafe(1000),
  };

  it("decodes a pairing link from an older server without a binding", () => {
    expect(decodePairingLink(legacyPairingLink)).not.toHaveProperty("binding_kind");
  });

  it("keeps the binding on a pairing link through a round trip", () => {
    const binding: SessionBinding = {
      _tag: "projects",
      projects: [{ projectId: ProjectId.make("project-a"), role: "viewer" }],
    };
    const encoded = encodePairingLink({
      ...legacyPairingLink,
      binding_kind: "projects",
      binding,
      role: "viewer",
    });
    expect(encoded).toMatchObject({ binding_kind: "projects", binding, role: "viewer" });
    expect(decodePairingLink(encoded)).toMatchObject({ binding_kind: "projects", binding });
  });

  it("keeps the binding on a browser session result", () => {
    const decode = Schema.decodeUnknownSync(AuthBrowserSessionResult);
    const result = decode({
      authenticated: true,
      scopes: [],
      sessionMethod: "browser-session-cookie",
      expiresAt: DateTime.makeUnsafe(1000),
      binding_kind: "principal",
      binding: { _tag: "principal" },
    });
    expect(result.binding_kind).toBe("principal");
    expect(
      decode({
        authenticated: true,
        scopes: [],
        sessionMethod: "browser-session-cookie",
        expiresAt: DateTime.makeUnsafe(1000),
      }),
    ).not.toHaveProperty("binding_kind");
  });

  it("keeps the binding on a pairing credential result", () => {
    const decode = Schema.decodeUnknownSync(AuthPairingCredentialResult);
    const result = decode({
      id: "link-1",
      credential: "code",
      expiresAt: DateTime.makeUnsafe(1000),
      binding_kind: "projects",
      binding: {
        _tag: "projects",
        projects: [{ projectId: ProjectId.make("project-a"), role: "operator" }],
      },
      role: "operator",
    });
    expect(result.binding).toMatchObject({ _tag: "projects" });
  });
});

const encodePairingLink = Schema.encodeSync(AuthPairingLink);

const decodePrincipalRecord = Schema.decodeSync(Principal);

describe("principal records", () => {
  it("keeps the ceiling and revision a role check reads", () => {
    const principal = decodePrincipalRecord({
      id: PrincipalId.make("member-1"),
      kind: "member",
      displayName: "Ada",
      email: null,
      status: "active",
      ceiling: ["orchestration:read"],
      accessRevision: 3,
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
      removedAt: null,
    });
    expect(principal.ceiling).toEqual(["orchestration:read"]);
    expect(principal.accessRevision).toBe(3);
  });
});
