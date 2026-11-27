import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { RecoveryRouteSurface } from "./RecoveryRouteSurface";

it("validates inputs, submits recovery code and new password, and renders confirmation", async () => {
  const onSubmitRecovery = vi
    .fn<(input: { readonly code: string; readonly password: string }) => Promise<void>>()
    .mockRejectedValueOnce(new Error("This recovery code has expired."))
    .mockResolvedValueOnce(undefined);

  await using screen = await render(
    <RecoveryRouteSurface
      initialCode="RECV-CODE-1234"
      host="https://hub.example.com"
      onSubmitRecovery={onSubmitRecovery}
    />,
  );

  await expect.element(screen.getByText("Recover account access")).toBeVisible();
  await expect.element(screen.getByText("https://hub.example.com")).toBeVisible();

  // Short password triggers validation error before calling handler.
  await screen.getByLabelText("New password").fill("short");
  await screen.getByLabelText("Confirm password").fill("short");
  await screen.getByRole("button", { name: "Reset password" }).click();
  await expect.element(screen.getByText("Password must be at least 8 characters.")).toBeVisible();
  expect(onSubmitRecovery).not.toHaveBeenCalled();

  // Mismatched passwords trigger validation error.
  await screen.getByLabelText("New password").fill("new-password-1234");
  await screen.getByLabelText("Confirm password").fill("different-password");
  await screen.getByRole("button", { name: "Reset password" }).click();
  await expect.element(screen.getByText("Passwords do not match.")).toBeVisible();
  expect(onSubmitRecovery).not.toHaveBeenCalled();

  // Server error is displayed on failure.
  await screen.getByLabelText("Confirm password").fill("new-password-1234");
  await screen.getByRole("button", { name: "Reset password" }).click();
  await expect.element(screen.getByText("This recovery code has expired.")).toBeVisible();
  expect(onSubmitRecovery).toHaveBeenCalledWith({
    code: "RECV-CODE-1234",
    password: "new-password-1234",
  });

  // Retrying with a fresh code transitions to the recovered state.
  await screen.getByLabelText("Recovery code").fill("FRSH-CODE-5678");
  await screen.getByRole("button", { name: "Reset password" }).click();
  await expect
    .element(
      screen.getByText(
        "Your password has been updated and all previous sessions, devices, and access tokens have been revoked.",
      ),
    )
    .toBeVisible();
});
