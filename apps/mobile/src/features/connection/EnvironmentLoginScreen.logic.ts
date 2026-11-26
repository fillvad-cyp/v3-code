import {
  type SupervisorConnectionState,
  type ConnectionCatalogEntry,
  connectionRoutes,
  isHostCredentialRefusal,
} from "@t3tools/client-runtime/connection";
import type {
  AuthSessionState,
  EnvironmentId,
  ExecutionEnvironmentCapabilities,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

export type MobileLoginStatus = "idle" | "submitting" | "error" | "authenticated";

export interface MobileLoginState {
  readonly host: string;
  readonly code: string;
  readonly status: MobileLoginStatus;
  readonly errorMessage: string | null;
}

export type MobileLoginEvent =
  | { readonly type: "host_changed"; readonly value: string }
  | { readonly type: "code_changed"; readonly value: string }
  | { readonly type: "validation_failed"; readonly message: string }
  | { readonly type: "submit_started" }
  | { readonly type: "submit_failed"; readonly message: string | null }
  | { readonly type: "submit_succeeded" }
  | { readonly type: "reset"; readonly host?: string };

export function initialMobileLoginState(input?: {
  readonly host?: string;
  readonly initialErrorMessage?: string | null;
}): MobileLoginState {
  const errorMessage = input?.initialErrorMessage ?? null;
  return {
    host: input?.host ?? "",
    code: "",
    status: errorMessage !== null && errorMessage.length > 0 ? "error" : "idle",
    errorMessage,
  };
}

export function transitionMobileLoginState(
  state: MobileLoginState,
  event: MobileLoginEvent,
): MobileLoginState {
  switch (event.type) {
    case "host_changed":
      return {
        ...state,
        host: event.value,
        ...(state.status === "error" ? { status: "idle" as const, errorMessage: null } : {}),
      };
    case "code_changed":
      return {
        ...state,
        code: event.value,
        ...(state.status === "error" ? { status: "idle" as const, errorMessage: null } : {}),
      };
    case "validation_failed":
      return {
        ...state,
        status: "error",
        errorMessage: event.message,
      };
    case "submit_started":
      return {
        ...state,
        status: "submitting",
        errorMessage: null,
      };
    case "submit_failed":
      return {
        ...state,
        status: event.message !== null && event.message.length > 0 ? "error" : "idle",
        errorMessage: event.message,
      };
    case "submit_succeeded":
      return {
        ...state,
        status: "authenticated",
        code: "",
        errorMessage: null,
      };
    case "reset":
      return initialMobileLoginState(event.host === undefined ? undefined : { host: event.host });
  }
}

export function normalizeLoginHost(host: string): string | null {
  const trimmed = host.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeLoginCode(code: string): string | null {
  const trimmed = code.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export interface AuthBlockedBearerTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
}

/**
 * Returns the bearer HTTP base URL for an environment whose connection is blocked by a
 * server-side 401/credential refusal, or `null` when it is not auth-blocked or has no direct route.
 */
export function resolveAuthBlockedBearerTarget(input: {
  readonly entry: ConnectionCatalogEntry;
  readonly state: SupervisorConnectionState;
}): AuthBlockedBearerTarget | null {
  if (
    !input.entry.enabled ||
    input.state.phase !== "blocked" ||
    input.state.lastFailure === null ||
    !isHostCredentialRefusal(input.state.lastFailure)
  ) {
    return null;
  }
  const bearerRoute = connectionRoutes(input.entry).find(
    (route) =>
      Option.isSome(route.profile) && route.profile.value._tag === "BearerConnectionProfile",
  );
  if (
    bearerRoute === undefined ||
    Option.isNone(bearerRoute.profile) ||
    bearerRoute.profile.value._tag !== "BearerConnectionProfile"
  ) {
    return null;
  }
  return {
    environmentId: input.entry.target.environmentId,
    label: input.entry.target.label,
    httpBaseUrl: bearerRoute.profile.value.httpBaseUrl,
  };
}

/**
 * Multi-user capability gate: open the mobile login screen when a 401-blocked remote host
 * advertises `authMode === "multi-user"` and is not authenticated.
 */
export function shouldPromptMultiUserLogin(input: {
  readonly session: Pick<AuthSessionState, "authenticated" | "auth">;
  readonly alreadyPrompted: boolean;
}): boolean {
  return (
    !input.alreadyPrompted &&
    !input.session.authenticated &&
    input.session.auth.authMode === "multi-user"
  );
}

/** Whether Sign out should be offered for the active environment session. */
export function canSignOutEnvironment(input: {
  readonly session: AuthSessionState | null;
  readonly capabilities?: ExecutionEnvironmentCapabilities | undefined;
}): boolean {
  if (input.session === null || !input.session.authenticated) return false;
  return (
    input.capabilities?.members === true ||
    input.session.auth.authMode === "multi-user" ||
    input.session.principal !== undefined
  );
}
