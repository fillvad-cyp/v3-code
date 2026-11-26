import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Schema from "effect/Schema";

import * as PayloadSigner from "../auth/PayloadSigner.ts";
import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export const API_TOKEN_PREFIX = "t3p_";
export const API_TOKEN_SIGNING_SECRET_NAME = "api-token-signing-key";
const API_TOKEN_RANDOM_BYTES = 32;

export class ApiTokenGenerationError extends Schema.TaggedError<ApiTokenGenerationError>()(
  "ApiTokenGenerationError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to generate an API token.";
  }
}

export function isApiTokenFormat(raw: string): boolean {
  if (!raw.startsWith(API_TOKEN_PREFIX)) {
    return false;
  }
  const suffix = raw.slice(API_TOKEN_PREFIX.length);
  return suffix.length > 0 && !/\s/.test(suffix);
}

export interface ApiTokenCodeHasher<E = ServerSecretStore.SecretStoreError> {
  readonly generate: () => Effect.Effect<
    { readonly rawToken: string; readonly tokenHmac: string },
    E | ApiTokenGenerationError
  >;
  readonly hash: (rawToken: string) => Effect.Effect<string, E>;
  readonly verify: (rawToken: string, tokenHmac: string) => Effect.Effect<boolean, E>;
}

/** HMAC-SHA256 hasher and generator for `t3p_` personal access tokens. */
export const make = Effect.fn("ApiTokenCodes.make")(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const signer = yield* PayloadSigner.make(API_TOKEN_SIGNING_SECRET_NAME);

  const hash = (rawToken: string) => signer.sign(rawToken);

  const verify = (rawToken: string, tokenHmac: string) =>
    isApiTokenFormat(rawToken) ? signer.verify(rawToken, tokenHmac) : Effect.succeed(false);

  const generate = Effect.fn("ApiTokenCodes.generate")(function* () {
    const bytes = yield* random
      .randomBytes(API_TOKEN_RANDOM_BYTES)
      .pipe(Effect.mapError((cause) => new ApiTokenGenerationError({ cause })));
    const rawToken = `${API_TOKEN_PREFIX}${Base64Url.encode(bytes)}`;
    const tokenHmac = yield* signer.sign(rawToken);
    return { rawToken, tokenHmac } as const;
  });

  return {
    generate,
    hash,
    verify,
  } satisfies ApiTokenCodeHasher;
});
