import { PAIRING_CODE_ALPHABET } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as PayloadSigner from "../auth/PayloadSigner.ts";
import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const INVITATION_CODE_ALPHABET = PAIRING_CODE_ALPHABET;
const INVITATION_CODE_GROUP_LENGTH = 4;
const INVITATION_CODE_GROUP_COUNT = 3;
const INVITATION_CODE_LENGTH = INVITATION_CODE_GROUP_LENGTH * INVITATION_CODE_GROUP_COUNT;
const INVITATION_SIGNING_SECRET_NAME = "invitation-signing-key";

const ALPHABET_SET = new Set(INVITATION_CODE_ALPHABET);
// 32 divides 256 evenly, keeping rejection sampling unbiased without wasting bytes.
const REJECTION_LIMIT =
  Math.floor(256 / INVITATION_CODE_ALPHABET.length) * INVITATION_CODE_ALPHABET.length;

export class InvitationCodeGenerationError extends Schema.TaggedError<InvitationCodeGenerationError>()(
  "InvitationCodeGenerationError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to generate an invitation code.";
  }
}

/** Formats a user-entered code as `XXXX-XXXX-XXXX`, or returns `undefined` if it is not valid. */
export function normalizeInvitationCode(raw: string): string | undefined {
  const cleaned = raw.replace(/[\s-]+/g, "").toUpperCase();
  if (cleaned.length !== INVITATION_CODE_LENGTH) {
    return undefined;
  }
  for (const character of cleaned) {
    if (!ALPHABET_SET.has(character)) {
      return undefined;
    }
  }
  return [
    cleaned.slice(0, INVITATION_CODE_GROUP_LENGTH),
    cleaned.slice(INVITATION_CODE_GROUP_LENGTH, INVITATION_CODE_GROUP_LENGTH * 2),
    cleaned.slice(INVITATION_CODE_GROUP_LENGTH * 2),
  ].join("-");
}

const generateCode = Effect.fn("InvitationCodes.generateCode")(function* () {
  const random = yield* SecureRandom.SecureRandom;
  let chars = "";
  while (chars.length < INVITATION_CODE_LENGTH) {
    const bytes = yield* random
      .randomBytes(INVITATION_CODE_LENGTH)
      .pipe(Effect.mapError((cause) => new InvitationCodeGenerationError({ cause })));
    for (const byte of bytes) {
      if (byte >= REJECTION_LIMIT) {
        continue;
      }
      chars += INVITATION_CODE_ALPHABET[byte % INVITATION_CODE_ALPHABET.length]!;
      if (chars.length === INVITATION_CODE_LENGTH) {
        break;
      }
    }
  }
  return [
    chars.slice(0, INVITATION_CODE_GROUP_LENGTH),
    chars.slice(INVITATION_CODE_GROUP_LENGTH, INVITATION_CODE_GROUP_LENGTH * 2),
    chars.slice(INVITATION_CODE_GROUP_LENGTH * 2),
  ].join("-");
});

export interface InvitationCodeHasher<E = ServerSecretStore.SecretStoreError> {
  readonly generate: () => Effect.Effect<
    { readonly code: string; readonly tokenHash: string },
    E | InvitationCodeGenerationError
  >;
  readonly hash: (code: string) => Effect.Effect<string, E>;
  readonly verify: (code: string, tokenHash: string) => Effect.Effect<boolean, E>;
}

/** HMAC-SHA256 hasher and verifier keyed by the server's dedicated invitation secret. */
export const make = Effect.fn("InvitationCodes.make")(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const signer = yield* PayloadSigner.make(INVITATION_SIGNING_SECRET_NAME);

  const hash = (code: string) => {
    const canonical = normalizeInvitationCode(code) ?? code.trim().toUpperCase();
    return signer.sign(canonical);
  };

  const verify = (code: string, tokenHash: string) => {
    const canonical = normalizeInvitationCode(code);
    if (canonical === undefined) {
      return Effect.succeed(false);
    }
    return signer.verify(canonical, tokenHash);
  };

  const generate = Effect.fn("InvitationCodes.generate")(function* () {
    const code = yield* generateCode().pipe(
      Effect.provideService(SecureRandom.SecureRandom, random),
    );
    const tokenHash = yield* signer.sign(code);
    return { code, tokenHash } as const;
  });

  return {
    generate,
    hash,
    verify,
  } satisfies InvitationCodeHasher;
});
