import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionProfile,
  BearerConnectionTarget,
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionCatalogEntry,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId, PrincipalId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  canSignOutEnvironment,
  initialMobileLoginState,
  normalizeLoginCode,
  normalizeLoginHost,
  resolveAuthBlockedBearerTarget,
  shouldPromptMultiUserLogin,
  transitionMobileLoginState,
} from "./EnvironmentLoginScreen.logic";

describe("EnvironmentLoginScreen state machine", () => {
  it("transitions cleanly across validation, failure, retry, authentication, and reset", () => {
    let state = initialMobileLoginState({ host: "https://team.example.com" });
    expect(state).toEqual({
      host: "https://team.example.com",
      code: "",
      status: "idle",
      errorMessage: null,
    });

    state = transitionMobileLoginState(state, {
      type: "validation_failed",
      message: "Enter a login code to continue.",
    });
    expect(state.status).toBe("error");
    expect(state.errorMessage).toBe("Enter a login code to continue.");

    state = transitionMobileLoginState(state, { type: "code_changed", value: "  LOGIN-CODE  " });
    expect(state.status).toBe("idle");
    expect(state.errorMessage).toBeNull();
    expect(normalizeLoginCode(state.code)).toBe("LOGIN-CODE");
    expect(normalizeLoginHost(state.host)).toBe("https://team.example.com");

    state = transitionMobileLoginState(state, { type: "submit_started" });
    expect(state.status).toBe("submitting");
    expect(state.errorMessage).toBeNull();

    state = transitionMobileLoginState(state, {
      type: "submit_failed",
      message: "The login code has expired.",
    });
    expect(state.status).toBe("error");
    expect(state.errorMessage).toBe("The login code has expired.");

    // Editing host also clears error state.
    state = transitionMobileLoginState(state, {
      type: "host_changed",
      value: "https://other.example.com",
    });
    expect(state.status).toBe("idle");
    expect(state.errorMessage).toBeNull();

    state = transitionMobileLoginState(state, { type: "submit_started" });
    state = transitionMobileLoginState(state, { type: "submit_succeeded" });
    expect(state.status).toBe("authenticated");
    expect(state.code).toBe("");
    expect(state.errorMessage).toBeNull();

    state = transitionMobileLoginState(state, { type: "reset", host: "https://reset.example.com" });
    expect(state).toEqual({
      host: "https://reset.example.com",
      code: "",
      status: "idle",
      errorMessage: null,
    });
  });

  it("normalizes empty or whitespace-only inputs to null", () => {
    expect(normalizeLoginHost("   ")).toBeNull();
    expect(normalizeLoginCode("\n\t ")).toBeNull();
  });
});

describe("multi-user 401 capability gate and sign-out", () => {
  const environmentId = EnvironmentId.make("env-remote");
  const connectionId = "bearer:env-remote:https://team.example.com";
  const bearerTarget = new BearerConnectionTarget({
    environmentId,
    label: "Team Server",
    connectionId,
  });
  const bearerProfile = new BearerConnectionProfile({
    connectionId,
    environmentId,
    label: "Team Server",
    httpBaseUrl: "https://team.example.com",
    wsBaseUrl: "wss://team.example.com",
  });
  const bearerEntry: ConnectionCatalogEntry = {
    target: bearerTarget,
    profile: Option.some(bearerProfile),
    enabled: true,
  };

  it("extracts the bearer host only when blocked by a server credential refusal", () => {
    const authRefusedState = {
      ...AVAILABLE_CONNECTION_STATE,
      phase: "blocked" as const,
      lastFailure: new ConnectionBlockedError({
        reason: "authentication",
        detail: "The environment credential is invalid.",
        hop: "server",
        via: "direct",
      }),
    };
    expect(resolveAuthBlockedBearerTarget({ entry: bearerEntry, state: authRefusedState })).toEqual(
      {
        environmentId,
        label: "Team Server",
        httpBaseUrl: "https://team.example.com",
      },
    );

    // Disabled, transient network error, or relay-only environments do not trigger the gate.
    expect(
      resolveAuthBlockedBearerTarget({
        entry: { ...bearerEntry, enabled: false },
        state: authRefusedState,
      }),
    ).toBeNull();
    expect(
      resolveAuthBlockedBearerTarget({
        entry: bearerEntry,
        state: {
          ...AVAILABLE_CONNECTION_STATE,
          phase: "backoff",
          lastFailure: new ConnectionTransientError({
            reason: "network",
            detail: "Offline",
            hop: "server",
            via: "direct",
          }),
        },
      }),
    ).toBeNull();
    const relayOnly: ConnectionCatalogEntry = {
      target: new RelayConnectionTarget({ environmentId, label: "Relay" }),
      profile: Option.none(),
      enabled: true,
    };
    expect(
      resolveAuthBlockedBearerTarget({ entry: relayOnly, state: authRefusedState }),
    ).toBeNull();
  });

  it("prompts mobile login only when authMode is multi-user, unauthenticated, and not yet prompted", () => {
    const baseAuth = {
      policy: "remote-reachable" as const,
      bootstrapMethods: ["one-time-token" as const],
      sessionMethods: ["bearer-access-token" as const],
      sessionCookieName: "t3_session",
    };

    expect(
      shouldPromptMultiUserLogin({
        session: { authenticated: false, auth: { ...baseAuth, authMode: "multi-user" } },
        alreadyPrompted: false,
      }),
    ).toBe(true);
    expect(
      shouldPromptMultiUserLogin({
        session: { authenticated: false, auth: { ...baseAuth, authMode: "multi-user" } },
        alreadyPrompted: true,
      }),
    ).toBe(false);
    expect(
      shouldPromptMultiUserLogin({
        session: { authenticated: true, auth: { ...baseAuth, authMode: "multi-user" } },
        alreadyPrompted: false,
      }),
    ).toBe(false);
    expect(
      shouldPromptMultiUserLogin({
        session: { authenticated: false, auth: baseAuth },
        alreadyPrompted: false,
      }),
    ).toBe(false);
  });

  it("enables sign-out when authenticated on a multi-user or principal-backed environment", () => {
    const baseAuth = {
      policy: "remote-reachable" as const,
      bootstrapMethods: ["one-time-token" as const],
      sessionMethods: ["bearer-access-token" as const],
      sessionCookieName: "t3_session",
    };
    expect(canSignOutEnvironment({ session: null })).toBe(false);
    expect(
      canSignOutEnvironment({
        session: { authenticated: false, auth: { ...baseAuth, authMode: "multi-user" } },
      }),
    ).toBe(false);
    expect(
      canSignOutEnvironment({
        session: { authenticated: true, auth: baseAuth },
      }),
    ).toBe(false);
    expect(
      canSignOutEnvironment({
        session: { authenticated: true, auth: { ...baseAuth, authMode: "multi-user" } },
      }),
    ).toBe(true);
    expect(
      canSignOutEnvironment({
        session: {
          authenticated: true,
          auth: baseAuth,
          principal: {
            id: PrincipalId.make("member-1"),
            kind: "member",
            displayName: "Alex",
            email: null,
            status: "active",
            ceiling: [],
            accessRevision: 0,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            removedAt: null,
          },
        },
      }),
    ).toBe(true);
  });
});
