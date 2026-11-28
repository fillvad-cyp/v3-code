import type {
  EnvironmentId,
  ModelSelection,
  PromptCostAssessment,
  PromptCostAttachment,
  PromptCostInput,
  PromptCostMode,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";

export const MIN_PROMPT_COST_LENGTH = 8;
export const MAX_PROMPT_COST_TEXT_LENGTH = 20_000;
export const PROMPT_COST_DEBOUNCE_MS = 500;
export const MAX_PROMPT_COST_ATTACHMENTS = 20;
export const MAX_PROMPT_COST_ALTERNATIVES = 3;

export type PromptCostChipState =
  | "hidden"
  | "loading"
  | "priced"
  | "unpriced"
  | "error"
  | "recommendation";

export function fnv1aHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function promptCostAttachmentSignature(
  attachments: ReadonlyArray<PromptCostAttachment>,
): string {
  return attachments.map((attachment) => `${attachment.kind}:${attachment.sizeBytes}`).join(",");
}

export function buildPromptCostAttachments(
  files: ReadonlyArray<{ readonly sizeBytes: number }>,
  images: ReadonlyArray<{ readonly sizeBytes: number }>,
): ReadonlyArray<PromptCostAttachment> {
  const result: PromptCostAttachment[] = [];
  for (const file of files) {
    if (result.length >= MAX_PROMPT_COST_ATTACHMENTS) break;
    result.push({ kind: "file", sizeBytes: file.sizeBytes });
  }
  for (const image of images) {
    if (result.length >= MAX_PROMPT_COST_ATTACHMENTS) break;
    result.push({ kind: "image", sizeBytes: image.sizeBytes });
  }
  return result;
}

export function buildPromptCostPromptHash(
  promptText: string,
  attachments: ReadonlyArray<PromptCostAttachment>,
): string {
  return fnv1aHash(`${promptText}|${promptCostAttachmentSignature(attachments)}`);
}

export function buildPromptCostKey(
  environmentId: EnvironmentId,
  input: Pick<
    PromptCostInput,
    | "providerInstanceId"
    | "model"
    | "threadId"
    | "compactFirst"
    | "useClassifier"
    | "promptText"
    | "attachments"
  >,
): string {
  return [
    environmentId,
    input.providerInstanceId,
    input.model,
    input.threadId ?? "",
    String(input.compactFirst),
    String(input.useClassifier),
    fnv1aHash(input.promptText),
    promptCostAttachmentSignature(input.attachments),
  ].join("|");
}

export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0 || usd < 0.0001) {
    return "<$0.0001";
  }
  if (usd >= 0.1) {
    return `$${usd.toFixed(2)}`;
  }
  const rounded = Number(usd.toPrecision(2));
  if (rounded >= 0.1) {
    return `$${rounded.toFixed(2)}`;
  }
  const decimals = Math.max(2, -Math.floor(Math.log10(rounded)) + 1);
  return `$${rounded.toFixed(decimals)}`;
}

export function savePercent(saveRatio: number): number {
  if (!Number.isFinite(saveRatio) || saveRatio <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round(saveRatio * 100)));
}

export function chipState(input: {
  readonly enabled: boolean;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly assessment: PromptCostAssessment | null;
}): PromptCostChipState {
  if (!input.enabled) return "hidden";
  if (input.assessment !== null) {
    if (!input.assessment.priced) return "unpriced";
    if (input.assessment.recommendation !== null) return "recommendation";
    return "priced";
  }
  if (input.error !== null) return "error";
  if (input.isPending) return "loading";
  return "hidden";
}

export function shouldAutoSwitchPromptCost(input: {
  readonly mode: PromptCostMode;
  readonly assessment: PromptCostAssessment | null;
  readonly selectedInstanceId: ProviderInstanceId;
  readonly selectedModel: string;
  readonly lockedProvider: ProviderDriverKind | null;
  readonly multipleModelSelections: ReadonlyArray<ModelSelection> | null;
  readonly promptHash: string | null;
  readonly hasAppliedHash: boolean;
}): boolean {
  if (input.mode !== "auto") return false;
  if (input.lockedProvider !== null || input.multipleModelSelections !== null) return false;
  if (input.promptHash === null || input.hasAppliedHash) return false;
  if (input.assessment === null || !input.assessment.priced) return false;
  if (input.assessment.confidence !== "medium" && input.assessment.confidence !== "high") {
    return false;
  }
  const recommendation = input.assessment.recommendation;
  if (recommendation === null || recommendation.verdict !== "sameFit") return false;
  return (
    recommendation.instanceId !== input.selectedInstanceId ||
    recommendation.model !== input.selectedModel
  );
}

export interface AppliedHashRecorder {
  readonly has: (hash: string) => boolean;
  readonly mark: (hash: string) => void;
  readonly clear: () => void;
  readonly size: () => number;
}

export function createAppliedHashRecorder(maxEntries = 64): AppliedHashRecorder {
  const hashes = new Set<string>();
  return {
    has: (hash) => hashes.has(hash),
    mark: (hash) => {
      if (hashes.has(hash)) return;
      hashes.add(hash);
      if (hashes.size > maxEntries) {
        const oldest = hashes.values().next().value;
        if (oldest !== undefined) hashes.delete(oldest);
      }
    },
    clear: () => {
      hashes.clear();
    },
    size: () => hashes.size,
  };
}
