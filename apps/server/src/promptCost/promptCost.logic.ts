import type {
  PromptCostAlternative,
  PromptCostAttachment,
  PromptCostComplexity,
  PromptCostConfidence,
  PromptCostEstimate,
  PromptCostEvidence,
  PromptCostVerdict,
  ProviderInstanceId,
} from "@t3tools/contracts";

export interface PromptCostTokenRate {
  readonly inputPerToken: number;
  readonly cacheReadPerToken: number;
  readonly outputPerToken: number;
}

export interface PickAlternativeCandidate {
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly label: string;
  readonly rate: PromptCostTokenRate | null | undefined;
  readonly estimate: PromptCostEstimate;
  readonly verdict: PromptCostVerdict;
  readonly evidence: PromptCostEvidence;
}

const MAX_PROMPT_TOKENS = 400_000;
const CHARS_PER_TOKEN = 3.6;
const FILE_BYTES_PER_TOKEN = 4.5;
const MAX_SINGLE_FILE_TOKENS = 25_000;
const IMAGE_ATTACHMENT_TOKENS = 1_500;
const MAX_TOTAL_ATTACHMENT_TOKENS = 120_000;
const MAX_ALTERNATIVES = 3;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.min(MAX_PROMPT_TOKENS, Math.ceil(text.length / CHARS_PER_TOKEN));
}

export function estimateAttachmentTokens(attachments: ReadonlyArray<PromptCostAttachment>): number {
  let total = 0;
  for (const attachment of attachments) {
    if (attachment.kind === "image") {
      total += IMAGE_ATTACHMENT_TOKENS;
    } else {
      total += Math.min(
        MAX_SINGLE_FILE_TOKENS,
        attachment.sizeBytes <= 0 ? 0 : Math.ceil(attachment.sizeBytes / FILE_BYTES_PER_TOKEN),
      );
    }
    if (total >= MAX_TOTAL_ATTACHMENT_TOKENS) {
      return MAX_TOTAL_ATTACHMENT_TOKENS;
    }
  }
  return total;
}

export function trigrams(text: string): ReadonlySet<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (words === null || words.length === 0) return new Set();
  if (words.length < 3) return new Set([words.join(" ")]);
  const set = new Set<string>();
  for (let index = 0; index <= words.length - 3; index++) {
    set.add(`${words[index]} ${words[index + 1]} ${words[index + 2]}`);
  }
  return set;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const item of smaller) {
    if (larger.has(item)) intersection += 1;
  }
  if (intersection === 0) return 0;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function blendedPerToken(
  rate: Pick<PromptCostTokenRate, "inputPerToken" | "outputPerToken">,
): number {
  return rate.inputPerToken * 0.75 + rate.outputPerToken * 0.25;
}

export function percentile(values: ReadonlyArray<number>, p: number): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0]!;
  const sorted = [...values].toSorted((a, b) => a - b);
  const clampedP = Math.max(0, Math.min(1, p));
  const index = clampedP * (sorted.length - 1);
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low]!;
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (index - low);
}

export function pickAlternatives(input: {
  readonly candidates: ReadonlyArray<PickAlternativeCandidate>;
  readonly targetRate: PromptCostTokenRate;
  readonly targetEstimate: PromptCostEstimate;
  readonly minSaveRatio?: number;
}): ReadonlyArray<PromptCostAlternative> {
  const targetBlended = blendedPerToken(input.targetRate);
  if (targetBlended <= 0) return [];
  const minSaveRatio = input.minSaveRatio ?? 0;

  const eligible: Array<{
    readonly alt: PromptCostAlternative;
    readonly blended: number;
  }> = [];

  for (const candidate of input.candidates) {
    if (candidate.rate === null || candidate.rate === undefined) continue;
    const candidateBlended = blendedPerToken(candidate.rate);
    if (candidateBlended > 0.5 * targetBlended) continue;
    if (
      input.targetEstimate.medianUsd > 0
        ? candidate.estimate.medianUsd >= input.targetEstimate.medianUsd
        : candidateBlended >= targetBlended
    ) {
      continue;
    }
    const rawSaveRatio =
      input.targetEstimate.medianUsd > 0
        ? (input.targetEstimate.medianUsd - candidate.estimate.medianUsd) /
          input.targetEstimate.medianUsd
        : (targetBlended - candidateBlended) / targetBlended;
    const saveRatio = Math.max(0, Math.min(1, rawSaveRatio));
    if (saveRatio < minSaveRatio) continue;
    eligible.push({
      alt: {
        instanceId: candidate.instanceId,
        model: candidate.model,
        label: candidate.label,
        estimate: candidate.estimate,
        saveRatio,
        verdict: candidate.verdict,
        evidence: candidate.evidence,
      },
      blended: candidateBlended,
    });
  }

  eligible.sort(
    (a, b) =>
      a.alt.estimate.medianUsd - b.alt.estimate.medianUsd ||
      a.blended - b.blended ||
      a.alt.model.localeCompare(b.alt.model),
  );

  const deduped: PromptCostAlternative[] = [];
  const seen = new Set<string>();
  for (const { alt } of eligible) {
    const key = `${alt.instanceId}\0${alt.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(alt);
    if (deduped.length >= MAX_ALTERNATIVES) break;
  }
  return deduped;
}

export function verdictFor(input: {
  readonly similarRuns: number;
  readonly successRate: number;
}): PromptCostVerdict {
  if (input.similarRuns >= 3 && input.successRate >= 0.7) return "sameFit";
  if (input.similarRuns >= 3 && input.successRate < 0.7) return "risky";
  return "untested";
}

export function confidenceFor(input: { readonly similarRuns: number }): PromptCostConfidence {
  if (input.similarRuns >= 8) return "high";
  if (input.similarRuns >= 3) return "medium";
  if (input.similarRuns >= 1) return "low";
  return "none";
}

export function chooseRecommendation(input: {
  readonly alternatives: ReadonlyArray<PromptCostAlternative>;
  readonly confidence: PromptCostConfidence;
  readonly classifierComplexity: PromptCostComplexity | null;
}): PromptCostAlternative | null {
  if (input.alternatives.length === 0) return null;
  const sorted = [...input.alternatives].toSorted(
    (a, b) => a.estimate.medianUsd - b.estimate.medianUsd,
  );
  const isComplex = input.classifierComplexity === "complex";
  const sameFitThreshold = isComplex ? 0.6 : 0.5;
  const sameFit = sorted.find(
    (alt) => alt.verdict === "sameFit" && alt.saveRatio >= sameFitThreshold,
  );
  if (sameFit !== undefined) return sameFit;

  if (!isComplex && (input.confidence === "medium" || input.confidence === "high")) {
    return sorted.find((alt) => alt.verdict === "untested" && alt.saveRatio >= 0.6) ?? null;
  }
  return null;
}
