import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const PromptCostMode = Schema.Literals(["off", "suggest", "auto"]);
export type PromptCostMode = typeof PromptCostMode.Type;

export const PromptCostConfidence = Schema.Literals(["none", "low", "medium", "high"]);
export type PromptCostConfidence = typeof PromptCostConfidence.Type;

export const PromptCostVerdict = Schema.Literals(["sameFit", "untested", "risky"]);
export type PromptCostVerdict = typeof PromptCostVerdict.Type;

export const PromptCostBasis = Schema.Literals([
  "compact",
  "ownThread",
  "projectSimilar",
  "globalSimilar",
  "projectModel",
  "globalModel",
  "rates",
]);
export type PromptCostBasis = typeof PromptCostBasis.Type;

export const PromptCostComplexity = Schema.Literals(["simple", "moderate", "complex"]);
export type PromptCostComplexity = typeof PromptCostComplexity.Type;

export const PromptCostNote = Schema.Literals(["noPrice", "classifierUnavailable"]);
export type PromptCostNote = typeof PromptCostNote.Type;

const NonNegativeFiniteNumber = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0),
);
const UnitInterval = Schema.Number.check(
  Schema.isFinite(),
  Schema.isBetween({ minimum: 0, maximum: 1 }),
);

export const PromptCostAttachment = Schema.Struct({
  kind: Schema.Literals(["file", "image"]),
  sizeBytes: NonNegativeInt,
});
export type PromptCostAttachment = typeof PromptCostAttachment.Type;

export const PromptCostInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  threadId: Schema.NullOr(ThreadId),
  promptText: Schema.String.check(Schema.isMaxLength(20_000)),
  attachments: Schema.Array(PromptCostAttachment)
    .check(Schema.isMaxLength(20))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  compactFirst: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  useClassifier: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type PromptCostInput = typeof PromptCostInput.Type;

export const PromptCostTokens = Schema.Struct({
  context: NonNegativeInt,
  prompt: NonNegativeInt,
  attachments: NonNegativeInt,
  output: NonNegativeInt,
});
export type PromptCostTokens = typeof PromptCostTokens.Type;

export const PromptCostEstimate = Schema.Struct({
  medianUsd: NonNegativeFiniteNumber,
  p90Usd: NonNegativeFiniteNumber,
});
export type PromptCostEstimate = typeof PromptCostEstimate.Type;

export const PromptCostEvidence = Schema.Struct({
  similarRuns: NonNegativeInt,
  successRate: UnitInterval,
  medianCostUsd: NonNegativeFiniteNumber,
});
export type PromptCostEvidence = typeof PromptCostEvidence.Type;

export const PromptCostClassifier = Schema.Struct({
  complexity: PromptCostComplexity,
  reason: Schema.String.check(Schema.isMaxLength(300)),
  model: Schema.String,
  cached: Schema.Boolean,
});
export type PromptCostClassifier = typeof PromptCostClassifier.Type;

export const PromptCostAlternative = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  label: Schema.String,
  estimate: PromptCostEstimate,
  saveRatio: UnitInterval,
  verdict: PromptCostVerdict,
  evidence: PromptCostEvidence,
});
export type PromptCostAlternative = typeof PromptCostAlternative.Type;

export const PromptCostAssessment = Schema.Struct({
  inputTokens: PromptCostTokens,
  estimate: PromptCostEstimate,
  confidence: PromptCostConfidence,
  basis: Schema.Array(PromptCostBasis),
  classifier: Schema.NullOr(PromptCostClassifier),
  alternatives: Schema.Array(PromptCostAlternative),
  recommendation: Schema.NullOr(PromptCostAlternative),
  priced: Schema.Boolean,
  note: Schema.NullOr(PromptCostNote),
});
export type PromptCostAssessment = typeof PromptCostAssessment.Type;
