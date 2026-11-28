import { PrincipalId, type PasswordLoginInput } from "@t3tools/contracts";

export type LoginSurfaceMode = "code" | "password";
export type LoginSurfaceStatus = "idle" | "submitting" | "error" | "authenticated";

export interface LoginSurfaceState {
  readonly mode: LoginSurfaceMode;
  readonly status: LoginSurfaceStatus;
  readonly code: string;
  readonly identifier: string;
  readonly password: string;
  readonly errorMessage: string;
}

export type LoginSurfaceEvent =
  | { readonly type: "mode_changed"; readonly mode: LoginSurfaceMode }
  | { readonly type: "code_changed"; readonly value: string }
  | { readonly type: "identifier_changed"; readonly value: string }
  | { readonly type: "password_changed"; readonly value: string }
  | { readonly type: "validation_failed"; readonly message: string }
  | { readonly type: "submit_started" }
  | { readonly type: "submit_failed"; readonly message: string }
  | { readonly type: "submit_succeeded" };

export function initialLoginSurfaceState(initialErrorMessage?: string): LoginSurfaceState {
  return {
    mode: "code",
    status: initialErrorMessage ? "error" : "idle",
    code: "",
    identifier: "",
    password: "",
    errorMessage: initialErrorMessage ?? "",
  };
}

export function transitionLoginSurfaceState(
  state: LoginSurfaceState,
  event: LoginSurfaceEvent,
): LoginSurfaceState {
  switch (event.type) {
    case "mode_changed":
      return {
        ...state,
        mode: event.mode,
        ...(state.status === "error" ? { status: "idle" as const, errorMessage: "" } : {}),
      };
    case "code_changed":
      return {
        ...state,
        code: event.value,
        ...(state.status === "error" ? { status: "idle" as const, errorMessage: "" } : {}),
      };
    case "identifier_changed":
      return {
        ...state,
        identifier: event.value,
        ...(state.status === "error" ? { status: "idle" as const, errorMessage: "" } : {}),
      };
    case "password_changed":
      return {
        ...state,
        password: event.value,
        ...(state.status === "error" ? { status: "idle" as const, errorMessage: "" } : {}),
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
        errorMessage: "",
      };
    case "submit_failed":
      return {
        ...state,
        status: "error",
        errorMessage: event.message,
      };
    case "submit_succeeded":
      return {
        ...state,
        status: "authenticated",
        password: "",
        errorMessage: "",
      };
  }
}

export function normalizeSubmittedLoginCode(code: string): string | null {
  const trimmed = code.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildPasswordLoginPayload(
  identifier: string,
  password: string,
): PasswordLoginInput | null {
  const trimmed = identifier.trim();
  if (trimmed.length === 0 || password.length === 0) {
    return null;
  }
  if (trimmed.includes("@")) {
    return { email: trimmed, password };
  }
  return { principalId: PrincipalId.make(trimmed), password };
}
