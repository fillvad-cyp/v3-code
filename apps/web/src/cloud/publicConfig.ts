import * as Schema from "effect/Schema";

export class CloudPublicConfigMissingError extends Schema.TaggedError<CloudPublicConfigMissingError>()(
  "CloudPublicConfigMissingError",
  {
    key: Schema.Literal("T3CODE_CLERK_JWT_TEMPLATE"),
  },
) {
  override get message(): string {
    return "Cloud relay authentication is disabled in V3 Code.";
  }
}

export interface CloudPublicConfig {
  readonly clerkPublishableKey: string | null;
  readonly clerkJwtTemplate: string | null;
  readonly relayUrl: string | null;
  readonly relayTracing: {
    readonly tracesUrl: string | null;
    readonly tracesDataset: string | null;
    readonly tracesToken: string | null;
  };
}

export function trimNonEmpty(value: string | undefined): string | null {
  return value?.trim() || null;
}

export function resolveCloudPublicConfig(): CloudPublicConfig {
  return {
    clerkPublishableKey: null,
    clerkJwtTemplate: null,
    relayUrl: null,
    relayTracing: {
      tracesUrl: null,
      tracesDataset: null,
      tracesToken: null,
    },
  };
}

export function relayTelemetryEnabled(): boolean | null {
  return false;
}

export function resolveRelayTracingConfig(): null {
  return null;
}

export function hasCloudPublicConfig(): boolean {
  return false;
}

export function resolveRelayClerkTokenOptions(): never {
  throw new CloudPublicConfigMissingError({ key: "T3CODE_CLERK_JWT_TEMPLATE" });
}
