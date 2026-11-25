import { GTProvider, initializeGT } from "gt-react";
import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import { LoginRouteSurface } from "./LoginRouteSurface";
import {
  initialLoginSurfaceState,
  normalizeSubmittedLoginCode,
  transitionLoginSurfaceState,
} from "./LoginRouteSurface.logic";

describe("LoginRouteSurface state machine", () => {
  it("transitions through idle, validation error, submitting, server error, and authenticated", () => {
    let state = initialLoginSurfaceState();
    expect(state).toEqual({ status: "idle", code: "", errorMessage: "" });
    expect(normalizeSubmittedLoginCode("   ")).toBeNull();

    state = transitionLoginSurfaceState(state, {
      type: "validation_failed",
      message: "Enter a login code to continue.",
    });
    expect(state).toEqual({
      status: "error",
      code: "",
      errorMessage: "Enter a login code to continue.",
    });

    state = transitionLoginSurfaceState(state, {
      type: "code_changed",
      value: "  ABCD-EFGH-JKLM  ",
    });
    expect(state).toEqual({
      status: "idle",
      code: "  ABCD-EFGH-JKLM  ",
      errorMessage: "",
    });
    expect(normalizeSubmittedLoginCode(state.code)).toBe("ABCD-EFGH-JKLM");

    state = transitionLoginSurfaceState(state, { type: "submit_started" });
    expect(state.status).toBe("submitting");
    expect(state.errorMessage).toBe("");

    state = transitionLoginSurfaceState(state, {
      type: "submit_failed",
      message: "This invitation has expired.",
    });
    expect(state).toEqual({
      status: "error",
      code: "  ABCD-EFGH-JKLM  ",
      errorMessage: "This invitation has expired.",
    });

    state = transitionLoginSurfaceState(state, { type: "code_changed", value: "NEW1-CODE-2345" });
    expect(state.status).toBe("idle");
    expect(state.errorMessage).toBe("");

    state = transitionLoginSurfaceState(state, { type: "submit_started" });
    expect(state.status).toBe("submitting");

    state = transitionLoginSurfaceState(state, { type: "submit_succeeded" });
    expect(state).toEqual({
      status: "authenticated",
      code: "NEW1-CODE-2345",
      errorMessage: "",
    });
  });

  it("initializes in error state when given an initial error message", () => {
    expect(initialLoginSurfaceState("Session expired")).toEqual({
      status: "error",
      code: "",
      errorMessage: "Session expired",
    });
  });

  it("renders the login form with host, initial error, and code input", () => {
    initializeGT({ defaultLocale: "en", locales: ["en"] });
    const html = renderToStaticMarkup(
      <GTProvider locale="en" translations={{}}>
        <LoginRouteSurface
          environmentLabel="Work Hub"
          host="https://hub.example.com"
          initialErrorMessage="Invalid code"
          onSubmitCode={() => Promise.resolve()}
          onAuthenticated={() => undefined}
        />
      </GTProvider>,
    );

    expect(html).toContain("Sign in to Work Hub");
    expect(html).toContain("https://hub.example.com");
    expect(html).toContain("Invalid code");
    expect(html).toContain('id="member-login-code"');
    expect(html).toContain('autoComplete="one-time-code"');
  });
});
