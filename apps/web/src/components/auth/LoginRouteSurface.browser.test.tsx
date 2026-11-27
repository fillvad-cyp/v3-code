import { PrincipalId, type PasswordLoginInput } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { LoginRouteSurface } from "./LoginRouteSurface";

it("walks through idle, validation error, submitting, server error, and authenticated states", async () => {
  let resolveLogin!: () => void;
  const onSubmitCode = vi
    .fn<(code: string) => Promise<void>>()
    .mockRejectedValueOnce(new Error("This invitation has expired."))
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveLogin = resolve;
        }),
    );
  const onAuthenticated = vi.fn();

  await using screen = await render(
    <LoginRouteSurface
      environmentLabel="Work Hub"
      host="https://hub.example.com"
      onSubmitCode={onSubmitCode}
      onAuthenticated={onAuthenticated}
    />,
  );

  await expect.element(screen.getByText("Sign in to Work Hub")).toBeVisible();
  await expect.element(screen.getByText("https://hub.example.com")).toBeVisible();

  // Submitting empty code transitions to validation error without calling onSubmitCode.
  await screen.getByRole("button", { name: "Sign in" }).click();
  await expect.element(screen.getByText("Enter a login code to continue.")).toBeVisible();
  expect(onSubmitCode).not.toHaveBeenCalled();

  // Typing clears the error state, then submitting a rejected code surfaces the server error.
  const input = screen.getByLabelText("Login code");
  await input.fill("  EXPI-REDC-ODEE  ");
  await expect.element(screen.getByText("Enter a login code to continue.")).not.toBeInTheDocument();

  await screen.getByRole("button", { name: "Sign in" }).click();
  await expect.element(screen.getByText("This invitation has expired.")).toBeVisible();
  expect(onSubmitCode).toHaveBeenCalledExactlyOnceWith("EXPI-REDC-ODEE");
  expect(onAuthenticated).not.toHaveBeenCalled();

  // Retrying enters submitting state, disables controls, and finishes authenticated.
  await input.fill("VALI-DCOD-E234");
  await screen.getByRole("button", { name: "Sign in" }).click();
  await expect.element(screen.getByRole("button", { name: "Signing in..." })).toBeDisabled();

  resolveLogin();
  await vi.waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1));
  expect(onSubmitCode).toHaveBeenLastCalledWith("VALI-DCOD-E234");
});

it("switches to password mode and submits email or member ID credentials", async () => {
  const onSubmitCode = vi.fn<(code: string) => Promise<void>>().mockResolvedValue(undefined);
  const onSubmitPassword = vi
    .fn<(credentials: PasswordLoginInput) => Promise<void>>()
    .mockRejectedValueOnce(new Error("Invalid credentials."))
    .mockResolvedValueOnce(undefined);
  const onAuthenticated = vi.fn();

  await using screen = await render(
    <LoginRouteSurface
      environmentLabel="Work Hub"
      onSubmitCode={onSubmitCode}
      onSubmitPassword={onSubmitPassword}
      onAuthenticated={onAuthenticated}
    />,
  );

  await screen.getByRole("tab", { name: "Password" }).click();
  await expect.element(screen.getByLabelText("Email or member ID")).toBeVisible();
  await expect.element(screen.getByRole("link", { name: "Recover with a code" })).toBeVisible();

  await screen.getByLabelText("Email or member ID").fill("alice@example.com");
  await screen.getByLabelText("Password").fill("wrong-password");
  await screen.getByRole("button", { name: "Sign in" }).click();

  await expect.element(screen.getByText("Invalid credentials.")).toBeVisible();
  expect(onSubmitPassword).toHaveBeenCalledWith({
    email: "alice@example.com",
    password: "wrong-password",
  });

  await screen.getByLabelText("Email or member ID").fill("alice-id");
  await screen.getByLabelText("Password").fill("correct-password");
  await screen.getByRole("button", { name: "Sign in" }).click();

  await vi.waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1));
  expect(onSubmitPassword).toHaveBeenLastCalledWith({
    principalId: PrincipalId.make("alice-id"),
    password: "correct-password",
  });
});
