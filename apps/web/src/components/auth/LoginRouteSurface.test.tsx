import { PrincipalId } from "@t3tools/contracts";
import { GTProvider, initializeGT } from "gt-react";
import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import { LoginRouteSurface } from "./LoginRouteSurface";
import {
  buildPasswordLoginPayload,
  initialLoginSurfaceState,
  normalizeSubmittedLoginCode,
  transitionLoginSurfaceState,
} from "./LoginRouteSurface.logic";

describe("LoginRouteSurface state machine", () => {
  it("transitions through idle, validation error, submitting, server error, and authenticated", () => {
    let state = initialLoginSurfaceState();
    expect(state).toEqual({
      mode: "code",
      status: "idle",
      code: "",
      identifier: "",
      password: "",
      errorMessage: "",
    });
    expect(normalizeSubmittedLoginCode("   ")).toBeNull();

    state = transitionLoginSurfaceState(state, {
      type: "validation_failed",
      message: "Enter a login code to continue.",
    });
    expect(state).toEqual({
      mode: "code",
      status: "error",
      code: "",
      identifier: "",
      password: "",
      errorMessage: "Enter a login code to continue.",
    });

    state = transitionLoginSurfaceState(state, {
      type: "code_changed",
      value: "  ABCD-EFGH-JKLM  ",
    });
    expect(state).toEqual({
      mode: "code",
      status: "idle",
      code: "  ABCD-EFGH-JKLM  ",
      identifier: "",
      password: "",
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
      mode: "code",
      status: "error",
      code: "  ABCD-EFGH-JKLM  ",
      identifier: "",
      password: "",
      errorMessage: "This invitation has expired.",
    });

    state = transitionLoginSurfaceState(state, { type: "code_changed", value: "NEW1-CODE-2345" });
    expect(state.status).toBe("idle");
    expect(state.errorMessage).toBe("");

    state = transitionLoginSurfaceState(state, { type: "submit_started" });
    expect(state.status).toBe("submitting");

    state = transitionLoginSurfaceState(state, { type: "submit_succeeded" });
    expect(state).toEqual({
      mode: "code",
      status: "authenticated",
      code: "NEW1-CODE-2345",
      identifier: "",
      password: "",
      errorMessage: "",
    });
  });

  it("supports switching to password mode and building email or principalId payloads", () => {
    let state = initialLoginSurfaceState("Invalid code");
    state = transitionLoginSurfaceState(state, { type: "mode_changed", mode: "password" });
    expect(state.mode).toBe("password");
    expect(state.status).toBe("idle");
    expect(state.errorMessage).toBe("");

    state = transitionLoginSurfaceState(state, {
      type: "identifier_changed",
      value: "alice@example.com",
    });
    state = transitionLoginSurfaceState(state, {
      type: "password_changed",
      value: "secret-password",
    });
    expect(buildPasswordLoginPayload(state.identifier, state.password)).toEqual({
      email: "alice@example.com",
      password: "secret-password",
    });
    expect(buildPasswordLoginPayload("  alice-id ", "secret-password")).toEqual({
      principalId: PrincipalId.make("alice-id"),
      password: "secret-password",
    });
    expect(buildPasswordLoginPayload("   ", "secret-password")).toBeNull();
    expect(buildPasswordLoginPayload("alice@example.com", "")).toBeNull();
  });

  it("initializes in error state when given an initial error message", () => {
    expect(initialLoginSurfaceState("Session expired")).toEqual({
      mode: "code",
      status: "error",
      code: "",
      identifier: "",
      password: "",
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
          onSubmitPassword={() => Promise.resolve()}
          onAuthenticated={() => undefined}
        />
      </GTProvider>,
    );

    expect(html).toContain("Sign in to Work Hub");
    expect(html).toContain("https://hub.example.com");
    expect(html).toContain("Invalid code");
    expect(html).toContain('id="member-login-code"');
    expect(html).toContain('autoComplete="one-time-code"');
    expect(html).toContain("One-time code");
    expect(html).toContain("Password");
  });
});
