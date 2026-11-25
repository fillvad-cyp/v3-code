export type LoginSurfaceStatus = "idle" | "submitting" | "error" | "authenticated";

export interface LoginSurfaceState {
  readonly status: LoginSurfaceStatus;
  readonly code: string;
  readonly errorMessage: string;
}

export type LoginSurfaceEvent =
  | { readonly type: "code_changed"; readonly value: string }
  | { readonly type: "validation_failed"; readonly message: string }
  | { readonly type: "submit_started" }
  | { readonly type: "submit_failed"; readonly message: string }
  | { readonly type: "submit_succeeded" };

export function initialLoginSurfaceState(initialErrorMessage?: string): LoginSurfaceState {
  return {
    status: initialErrorMessage ? "error" : "idle",
    code: "",
    errorMessage: initialErrorMessage ?? "",
  };
}

export function transitionLoginSurfaceState(
  state: LoginSurfaceState,
  event: LoginSurfaceEvent,
): LoginSurfaceState {
  switch (event.type) {
    case "code_changed":
      return {
        ...state,
        code: event.value,
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
        errorMessage: "",
      };
  }
}

export function normalizeSubmittedLoginCode(code: string): string | null {
  const trimmed = code.trim();
  return trimmed.length > 0 ? trimmed : null;
}
