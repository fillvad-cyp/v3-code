import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute, redirect, useNavigate, useRouter } from "@tanstack/react-router";

import { LoginRouteSurface } from "../components/auth/LoginRouteSurface";
import { connectLoginCode } from "../connection/onboarding";
import { submitMemberLoginCode } from "../environments/primary";
import { m } from "../i18n/messages";
import { useAtomCommand } from "../state/use-atom-command";

interface LoginRouteSearch {
  readonly host?: string;
  readonly environmentId?: EnvironmentId;
  readonly label?: string;
}

function parseOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): LoginRouteSearch => {
    const host = parseOptionalString(search.host);
    const environmentId = parseOptionalString(search.environmentId);
    const label = parseOptionalString(search.label);
    return {
      ...(host !== undefined ? { host } : {}),
      ...(environmentId !== undefined ? { environmentId: EnvironmentId.make(environmentId) } : {}),
      ...(label !== undefined ? { label } : {}),
    };
  },
  beforeLoad: async ({ context, search }) => {
    if (search.host) {
      return { authGateState: context.authGateState };
    }
    if (
      context.authGateState.status === "authenticated" ||
      context.authGateState.status === "guest"
    ) {
      throw redirect({ to: "/", replace: true });
    }
    return { authGateState: context.authGateState };
  },
  component: LoginRouteView,
});

function LoginRouteView() {
  const router = useRouter();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const { authGateState } = Route.useRouteContext();
  const connectRemoteLogin = useAtomCommand(connectLoginCode, { reportFailure: false });

  const initialErrorMessage =
    !search.host && authGateState.status === "requires-auth"
      ? authGateState.errorMessage
      : undefined;

  const handleSubmitCode = async (code: string) => {
    if (search.host) {
      const result = await connectRemoteLogin({
        host: search.host,
        code,
        ...(search.environmentId ? { expectedEnvironmentId: search.environmentId } : {}),
      });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        const message =
          failure instanceof Error
            ? (thrownErrorMessage(failure, m) ?? failure.message)
            : String(failure);
        throw new Error(message);
      }
      return;
    }

    await submitMemberLoginCode(code);
  };

  const handleAuthenticated = () => {
    if (search.host) {
      void navigate({ to: "/", replace: true });
      return;
    }
    // Recreate the connection so WebSocket and cached scopes use the new member session.
    router.history.replace("/");
    router.history.flush();
    window.location.reload();
  };

  return (
    <LoginRouteSurface
      {...(search.label ? { environmentLabel: search.label } : {})}
      {...(search.host ? { host: search.host } : {})}
      {...(initialErrorMessage ? { initialErrorMessage } : {})}
      onSubmitCode={handleSubmitCode}
      onAuthenticated={handleAuthenticated}
    />
  );
}
