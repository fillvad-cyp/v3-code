export type RecoverySurfaceStatus = "idle" | "submitting" | "error" | "recovered";

export interface RecoverySurfaceState {
  readonly status: RecoverySurfaceStatus;
  readonly code: string;
  readonly password: string;
  readonly confirmPassword: string;
  readonly errorMessage: string;
}

export type RecoverySurfaceEvent =
  | { readonly type: "code_changed"; readonly value: string }
  | { readonly type: "password_changed"; readonly value: string }
  | { readonly type: "confirm_password_changed"; readonly value: string }
  | { readonly type: "validation_failed"; readonly message: string }
  | { readonly type: "submit_started" }
  | { readonly type: "submit_failed"; readonly message: string }
  | { readonly type: "submit_succeeded" };

export function initialRecoverySurfaceState(initialCode?: string): RecoverySurfaceState {
  return {
    status: "idle",
    code: initialCode ?? "",
    password: "",
    confirmPassword: "",
    errorMessage: "",
  };
}

export function transitionRecoverySurfaceState(
  state: RecoverySurfaceState,
  event: RecoverySurfaceEvent,
): RecoverySurfaceState {
  switch (event.type) {
    case "code_changed":
      return {
        ...state,
        code: event.value,
        ...(state.status === "error" ? { status: "idle" as const, errorMessage: "" } : {}),
      };
    case "password_changed":
      return {
        ...state,
        password: event.value,
        ...(state.status === "error" ? { status: "idle" as const, errorMessage: "" } : {}),
      };
    case "confirm_password_changed":
      return {
        ...state,
        confirmPassword: event.value,
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
        status: "recovered",
        password: "",
        confirmPassword: "",
        errorMessage: "",
      };
  }
}
