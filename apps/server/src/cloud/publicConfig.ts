// V3 Code removes hosted cloud relay, Clerk auth, and Axiom relay tracing.
import { connectLoopbackRedirectUri, CONNECT_OAUTH_SCOPES } from "@t3tools/shared/connectAuth";
import * as Config from "effect/Config";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

const CLOUD_CLI_OAUTH_LOOPBACK_PORT = 34338;
const CLOUD_CLI_OAUTH_SCOPES = CONNECT_OAUTH_SCOPES;

function cloudDisabledError(message: string) {
  return new Schema.SchemaError(
    new SchemaIssue.InvalidValue({
      message,
    }),
  );
}

export function resolveRelayClientTracingConfig(
  _env?: Readonly<Record<string, string | undefined>>,
  _fallback?: Readonly<{
    readonly tracesUrl: string;
    readonly tracesDataset: string;
    readonly tracesToken: string;
  }>,
): null {
  return null;
}

export function makeRelayUrlConfig(_fallback?: string): Config.Config<string> {
  return Config.fail(cloudDisabledError("Cloud relay is disabled in V3 Code."));
}

export const relayUrlConfig: Config.Config<string> = makeRelayUrlConfig();

export const hostedAppUrlConfig: Config.Config<string> = Config.fail(
  cloudDisabledError("Hosted app URL is disabled in V3 Code."),
);

export const agentApprovalAppUrlConfig: Config.Config<string> = Config.fail(
  cloudDisabledError("Hosted agent approval URL is disabled in V3 Code."),
);

export interface CloudCliOAuthConfig {
  readonly tokenEndpoint: string;
  readonly deviceAuthorizationEndpoint: string;
  readonly clientId: string;
  readonly loopbackPort: number;
  readonly redirectUri: string;
  readonly scopes: typeof CLOUD_CLI_OAUTH_SCOPES;
}

export function makeCloudCliOAuthConfig(_options?: {
  readonly clerkPublishableKeyFallback?: string;
  readonly clerkCliOAuthClientIdFallback?: string;
}): Config.Config<CloudCliOAuthConfig> {
  return Config.fail(
    cloudDisabledError(
      `Cloud OAuth is disabled in V3 Code (${connectLoopbackRedirectUri(CLOUD_CLI_OAUTH_LOOPBACK_PORT)}).`,
    ),
  );
}

export const cloudCliOAuthConfig = makeCloudCliOAuthConfig();

export const hasCloudPublicConfig = false;
