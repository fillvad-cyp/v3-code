// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synchronous SHA-256 hashing for cache keys.
import * as NodeCrypto from "node:crypto";

import {
  DEFAULT_SERVER_SETTINGS,
  isProviderTextGenerationCapable,
  type ModelSelection,
  type ProjectId,
  type PromptCostAssessment,
  type PromptCostBasis,
  type PromptCostClassifier,
  type PromptCostEstimate,
  type PromptCostInput,
  type PromptCostNote,
  type ServerProvider,
  type ServerSettings as ServerSettingsValue,
  type UsageProviderKind,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { BUILT_IN_USAGE_DRIVERS } from "../provider/builtInDrivers.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as UsageService from "../usage/UsageService.ts";
import {
  blendedPerToken,
  chooseRecommendation,
  confidenceFor,
  estimateAttachmentTokens,
  estimateTokens,
  jaccard,
  percentile,
  pickAlternatives,
  type PickAlternativeCandidate,
  type PromptCostTokenRate,
  trigrams,
  verdictFor,
} from "./promptCost.logic.ts";

const HISTORY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const ASSESSMENT_CACHE_TTL_MS = 60_000;
const ASSESSMENT_CACHE_MAX_ENTRIES = 200;
const CLASSIFIER_CACHE_TTL_MS = 10 * 60_000;
const CLASSIFIER_CACHE_MAX_ENTRIES = 200;
const SIMILARITY_THRESHOLD = 0.35;
const MIN_SIMILAR_RUNS = 3;
const MIN_MODEL_RUNS = 5;
const FALLBACK_P50_OUTPUT_TOKENS = 2_500;
const FALLBACK_P90_OUTPUT_TOKENS = 7_500;
const COMPACT_MIN_CONTEXT_TOKENS = 3_000;
const COMPACT_CONTEXT_RATIO = 0.15;
const MAX_OUTPUT_TOKENS = 400_000;
const CLASSIFIER_PROMPT_MAX_CHARS = 1_200;
const CLASSIFIER_MAX_CANDIDATES = 8;

const ProviderTurnUsagePayload = Schema.Struct({
  tokenUsage: Schema.optional(
    Schema.Struct({
      usedTokens: Schema.optional(Schema.Number),
    }),
  ),
});
const decodeProviderTurnUsage = Schema.decodeUnknownOption(
  Schema.fromJsonString(ProviderTurnUsagePayload),
);
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const USAGE_PROVIDER_BY_DRIVER = new Map<string, UsageProviderKind>(
  BUILT_IN_USAGE_DRIVERS.flatMap((driver) =>
    driver.usage === undefined ? [] : [[driver.driverKind, driver.usage.provider] as const],
  ),
);

interface ThreadRow {
  readonly project_id: string | null;
  readonly active_provider_thread_id: string | null;
}

interface TurnPayloadRow {
  readonly payload_json: string | null;
}

interface CompletedRunRow {
  readonly run_id: string;
  readonly thread_id: string;
  readonly project_id: string;
  readonly model: string | null;
  readonly provider_instance_id: string | null;
  readonly input_tokens: number | null;
  readonly cached_input_tokens: number | null;
  readonly cache_creation_tokens: number | null;
  readonly output_tokens: number | null;
  readonly prompt_text: string | null;
}

interface ModelSuccessRow {
  readonly model: string | null;
  readonly completed_count: number | null;
  readonly total_count: number | null;
}

interface PricedHistoryRun {
  readonly runId: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly promptTrigrams: ReadonlySet<string>;
}

interface CachedClassifierValue {
  readonly complexity: PromptCostClassifier["complexity"];
  readonly reason: string;
  readonly model: string;
}

class LruTtlCache<V> {
  readonly #entries = new Map<string, { readonly value: V; readonly expiresAtMs: number }>();
  readonly #maxEntries: number;
  readonly #ttlMs: number;

  constructor(maxEntries: number, ttlMs: number) {
    this.#maxEntries = maxEntries;
    this.#ttlMs = ttlMs;
  }

  get(key: string, nowMs: number): V | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAtMs <= nowMs) {
      this.#entries.delete(key);
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, nowMs: number): void {
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAtMs: nowMs + this.#ttlMs });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}

function sha256Hex(value: string): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

function attachmentSignature(attachments: PromptCostInput["attachments"]): string {
  return attachments.map((attachment) => `${attachment.kind}:${attachment.sizeBytes}`).join(",");
}

function parseUsedTokens(payloadJson: string | null | undefined): number {
  if (!payloadJson) return 0;
  const decoded = decodeProviderTurnUsage(payloadJson);
  if (Option.isNone(decoded)) return 0;
  const used = decoded.value.tokenUsage?.usedTokens;
  return typeof used === "number" && Number.isFinite(used) && used > 0 ? Math.round(used) : 0;
}

function computeBucketOutputTokens(
  runs: ReadonlyArray<PricedHistoryRun>,
  totalInputTokens: number,
  quantile = 0.5,
): number {
  const rawOutputs = runs.map((run) => run.outputTokens);
  if (totalInputTokens <= 0) {
    return Math.min(MAX_OUTPUT_TOKENS, Math.max(0, Math.round(percentile(rawOutputs, quantile))));
  }
  const ratios = runs
    .filter((run) => run.inputTokens > 0)
    .map((run) => run.outputTokens / run.inputTokens);
  if (ratios.length === 0) {
    return Math.min(MAX_OUTPUT_TOKENS, Math.max(0, Math.round(percentile(rawOutputs, quantile))));
  }
  return Math.min(
    MAX_OUTPUT_TOKENS,
    Math.max(0, Math.round(totalInputTokens * percentile(ratios, quantile))),
  );
}

function resolveClassifierSelection(
  settings: ServerSettingsValue,
  provider: ServerProvider | undefined,
  rates: ReadonlyMap<string, PromptCostTokenRate>,
): ModelSelection | null {
  if (settings.promptCostClassifier !== null) {
    return settings.promptCostClassifier;
  }
  if (provider === undefined || !provider.enabled || !isProviderTextGenerationCapable(provider)) {
    return null;
  }
  let cheapest: { readonly slug: string; readonly blended: number } | null = null;
  for (const model of provider.models) {
    if (model.supportsTextGeneration === false) continue;
    const rate = rates.get(model.slug);
    if (rate === undefined) continue;
    const blended = blendedPerToken(rate);
    if (cheapest === null || blended < cheapest.blended) {
      cheapest = { slug: model.slug, blended };
    }
  }
  return cheapest === null ? null : { instanceId: provider.instanceId, model: cheapest.slug };
}

export class PromptCostService extends Context.Service<
  PromptCostService,
  {
    readonly predict: (input: PromptCostInput) => Effect.Effect<PromptCostAssessment>;
  }
>()("v3code/promptCost/PromptCostService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const usageService = yield* UsageService.UsageService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const serverConfig = yield* Effect.serviceOption(ServerConfig.ServerConfig);

  const assessmentCache = new LruTtlCache<PromptCostAssessment>(
    ASSESSMENT_CACHE_MAX_ENTRIES,
    ASSESSMENT_CACHE_TTL_MS,
  );
  const classifierCache = new LruTtlCache<CachedClassifierValue>(
    CLASSIFIER_CACHE_MAX_ENTRIES,
    CLASSIFIER_CACHE_TTL_MS,
  );

  const readThreadContext = Effect.fn("PromptCostService.readThreadContext")(function* (
    threadId: string,
  ) {
    const threadRows = yield* sql<ThreadRow>`
      SELECT project_id, active_provider_thread_id
      FROM orchestration_v2_projection_threads
      WHERE thread_id = ${threadId}
      LIMIT 1
    `.pipe(Effect.catchCause(() => Effect.succeed<ReadonlyArray<ThreadRow>>([])));
    const projectId = (threadRows[0]?.project_id ?? null) as ProjectId | null;
    const activeProviderThreadId = threadRows[0]?.active_provider_thread_id ?? null;
    if (activeProviderThreadId === null) {
      return { projectId, usedTokens: 0 };
    }
    const turnRows = yield* sql<TurnPayloadRow>`
      SELECT t.payload_json
      FROM orchestration_v2_projection_provider_turns t
      WHERE t.thread_id = ${threadId}
        AND t.provider_thread_id = ${activeProviderThreadId}
        AND json_extract(t.payload_json, '$.tokenUsage') IS NOT NULL
      ORDER BY julianday(json_extract(t.payload_json, '$.tokenUsage.updatedAt')) DESC
      LIMIT 1
    `.pipe(Effect.catchCause(() => Effect.succeed<ReadonlyArray<TurnPayloadRow>>([])));
    const usedTokens = parseUsedTokens(turnRows[0]?.payload_json);
    return { projectId, usedTokens };
  });

  const readHistory = Effect.fn("PromptCostService.readHistory")(function* (sinceIso: string) {
    return yield* Effect.all(
      {
        runs: sql<CompletedRunRow>`
          WITH recent_runs AS (
            SELECT
              r.run_id,
              r.thread_id,
              th.project_id,
              json_extract(r.payload_json, '$.modelSelection.model') AS model,
              r.provider_instance_id,
              r.requested_at,
              r.payload_json
            FROM orchestration_v2_projection_runs r
            JOIN orchestration_v2_projection_threads th ON th.thread_id = r.thread_id
            WHERE r.status = 'completed'
              AND r.requested_at >= ${sinceIso}
              AND th.deleted_at IS NULL
            ORDER BY r.requested_at DESC
            LIMIT 500
          )
          SELECT
            rr.run_id,
            rr.thread_id,
            rr.project_id,
            rr.model,
            rr.provider_instance_id,
            coalesce(sum(cast(json_extract(t.payload_json, '$.turnTokenUsage.inputTokens') AS integer)), 0) AS input_tokens,
            coalesce(sum(cast(json_extract(t.payload_json, '$.turnTokenUsage.cachedInputTokens') AS integer)), 0) AS cached_input_tokens,
            coalesce(sum(cast(json_extract(t.payload_json, '$.turnTokenUsage.cacheCreationTokens') AS integer)), 0) AS cache_creation_tokens,
            coalesce(sum(cast(json_extract(t.payload_json, '$.turnTokenUsage.outputTokens') AS integer)), 0) AS output_tokens,
            (
              SELECT substr(coalesce(m.search_text, json_extract(m.payload_json, '$.text')), 1, 4000)
              FROM orchestration_v2_projection_messages m
              WHERE m.message_id = json_extract(rr.payload_json, '$.userMessageId')
              LIMIT 1
            ) AS prompt_text
          FROM recent_runs rr
          LEFT JOIN orchestration_v2_projection_nodes n
            ON n.thread_id = rr.thread_id
            AND n.run_id = rr.run_id
            AND n.node_id = json_extract(rr.payload_json, '$.rootNodeId')
          LEFT JOIN orchestration_v2_projection_provider_turns t
            ON t.thread_id = rr.thread_id
            AND t.node_id = n.node_id
            AND t.run_attempt_id = json_extract(rr.payload_json, '$.activeAttemptId')
          GROUP BY rr.run_id
          HAVING sum(cast(json_extract(t.payload_json, '$.turnTokenUsage.inputTokens') AS integer)) > 0
          ORDER BY rr.requested_at DESC
        `.pipe(Effect.catchCause(() => Effect.succeed<ReadonlyArray<CompletedRunRow>>([]))),
        successRows: sql<ModelSuccessRow>`
          SELECT
            json_extract(r.payload_json, '$.modelSelection.model') AS model,
            sum(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
            count(*) AS total_count
          FROM orchestration_v2_projection_runs r
          WHERE r.status IN ('completed', 'failed', 'interrupted')
            AND r.requested_at >= ${sinceIso}
          GROUP BY model
          LIMIT 500
        `.pipe(Effect.catchCause(() => Effect.succeed<ReadonlyArray<ModelSuccessRow>>([]))),
      },
      { concurrency: 2 },
    );
  });

  const predict = Effect.fn("PromptCostService.predict")(function* (input: PromptCostInput) {
    const nowMs = yield* Clock.currentTimeMillis;
    const settings = yield* settingsService.getSettings.pipe(
      Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS),
    );
    const settingsFingerprint = sha256Hex(
      encodeUnknownJson({
        promptCostClassifier: settings.promptCostClassifier,
        usagePriceOverrides: settings.usagePriceOverrides,
        usageModelAliases: settings.usageModelAliases,
      }),
    );
    const promptHash = sha256Hex(input.promptText);
    const cacheKey = `${input.providerInstanceId}|${input.model}|${input.threadId ?? ""}|${input.compactFirst}|${input.useClassifier}|${settingsFingerprint}|${attachmentSignature(input.attachments)}|${promptHash}`;

    const cachedAssessment = assessmentCache.get(cacheKey, nowMs);
    if (cachedAssessment !== undefined) {
      return cachedAssessment;
    }

    const promptTokens = estimateTokens(input.promptText);
    const attachmentTokens = estimateAttachmentTokens(input.attachments);

    const sinceIso = DateTime.formatIso(DateTime.makeUnsafe(nowMs - HISTORY_WINDOW_MS));
    const [providers, threadContext, history] = yield* Effect.all(
      [
        providerRegistry.getProviders,
        input.threadId === null
          ? Effect.succeed({ projectId: null as ProjectId | null, usedTokens: 0 })
          : readThreadContext(input.threadId),
        readHistory(sinceIso),
      ],
      { concurrency: "unbounded" },
    );

    const provider = providers.find(
      (candidate) => candidate.instanceId === input.providerInstanceId,
    );
    const usageProvider =
      provider === undefined ? undefined : USAGE_PROVIDER_BY_DRIVER.get(provider.driver);
    const modelsToPrice = new Set<string>([input.model]);
    for (const model of provider?.models ?? []) {
      modelsToPrice.add(model.slug);
    }
    for (const run of history.runs) {
      if (run.model) modelsToPrice.add(run.model);
    }
    const rates = yield* usageService.lookupRates(usageProvider, [...modelsToPrice]);
    const targetRate = rates.get(input.model);
    if (targetRate === undefined) {
      return {
        inputTokens: {
          context: 0,
          prompt: promptTokens,
          attachments: attachmentTokens,
          output: 0,
        },
        estimate: { medianUsd: 0, p90Usd: 0 },
        confidence: "none",
        basis: [],
        classifier: null,
        alternatives: [],
        recommendation: null,
        priced: false,
        note: "noPrice",
      } satisfies PromptCostAssessment;
    }

    const contextTokens = input.compactFirst
      ? Math.min(
          threadContext.usedTokens,
          Math.max(
            COMPACT_MIN_CONTEXT_TOKENS,
            Math.floor(threadContext.usedTokens * COMPACT_CONTEXT_RATIO),
          ),
        )
      : threadContext.usedTokens;
    const totalInputTokens = contextTokens + promptTokens + attachmentTokens;

    const queryTrigrams = trigrams(input.promptText);
    const pricedRuns: PricedHistoryRun[] = [];
    for (const row of history.runs) {
      if (!row.model) continue;
      const runRate = rates.get(row.model);
      if (runRate === undefined) continue;
      const inputTokensCount = Math.max(0, Number(row.input_tokens ?? 0));
      const outputTokensCount = Math.max(0, Number(row.output_tokens ?? 0));
      if (inputTokensCount === 0 && outputTokensCount === 0) continue;
      const cachedInputCount = Math.max(
        0,
        Math.min(inputTokensCount, Number(row.cached_input_tokens ?? 0)),
      );
      const cacheCreationCount = Math.max(
        0,
        Math.min(inputTokensCount - cachedInputCount, Number(row.cache_creation_tokens ?? 0)),
      );
      const uncachedInput = Math.max(0, inputTokensCount - cachedInputCount - cacheCreationCount);
      const costUsd =
        uncachedInput * runRate.inputPerToken +
        cachedInputCount * runRate.cacheReadPerToken +
        cacheCreationCount * runRate.cacheWritePerToken +
        outputTokensCount * runRate.outputPerToken;
      pricedRuns.push({
        runId: row.run_id,
        threadId: row.thread_id,
        projectId: row.project_id,
        model: row.model,
        inputTokens: inputTokensCount,
        outputTokens: outputTokensCount,
        costUsd,
        promptTrigrams: row.prompt_text ? trigrams(row.prompt_text) : new Set(),
      });
    }

    const targetRuns = pricedRuns.filter((run) => run.model === input.model);
    const ownThreadRuns =
      input.threadId === null ? [] : targetRuns.filter((run) => run.threadId === input.threadId);
    const projectRuns =
      threadContext.projectId === null
        ? []
        : targetRuns.filter((run) => run.projectId === threadContext.projectId);
    const projectSimilarRuns = projectRuns.filter(
      (run) => jaccard(queryTrigrams, run.promptTrigrams) >= SIMILARITY_THRESHOLD,
    );
    const globalSimilarRuns = targetRuns.filter(
      (run) => jaccard(queryTrigrams, run.promptTrigrams) >= SIMILARITY_THRESHOLD,
    );

    let chosenBasis: PromptCostBasis = "rates";
    let chosenRuns: ReadonlyArray<PricedHistoryRun> = [];
    if (ownThreadRuns.length >= MIN_SIMILAR_RUNS) {
      chosenBasis = "ownThread";
      chosenRuns = ownThreadRuns;
    } else if (projectSimilarRuns.length >= MIN_SIMILAR_RUNS) {
      chosenBasis = "projectSimilar";
      chosenRuns = projectSimilarRuns;
    } else if (globalSimilarRuns.length >= MIN_SIMILAR_RUNS) {
      chosenBasis = "globalSimilar";
      chosenRuns = globalSimilarRuns;
    } else if (projectRuns.length >= MIN_MODEL_RUNS) {
      chosenBasis = "projectModel";
      chosenRuns = projectRuns;
    } else if (targetRuns.length >= MIN_MODEL_RUNS) {
      chosenBasis = "globalModel";
      chosenRuns = targetRuns;
    }

    const basis: PromptCostBasis[] = input.compactFirst ? ["compact", chosenBasis] : [chosenBasis];

    let outputTokens: number;
    let targetEstimate: PromptCostEstimate;
    const estimateFor = (
      rate: PromptCostTokenRate,
      runs: ReadonlyArray<PricedHistoryRun>,
    ): PromptCostEstimate => {
      const p50OutputTokens = computeBucketOutputTokens(runs, totalInputTokens, 0.5);
      const p90OutputTokens = Math.max(
        p50OutputTokens,
        computeBucketOutputTokens(runs, totalInputTokens, 0.9),
      );
      const inputCostUsd =
        contextTokens * rate.cacheReadPerToken +
        (promptTokens + attachmentTokens) * rate.inputPerToken;
      const medianUsd = inputCostUsd + p50OutputTokens * rate.outputPerToken;
      return {
        medianUsd,
        p90Usd: Math.max(medianUsd, inputCostUsd + p90OutputTokens * rate.outputPerToken),
      };
    };
    if (chosenRuns.length > 0 && !input.compactFirst) {
      outputTokens = computeBucketOutputTokens(chosenRuns, totalInputTokens, 0.5);
      const costs = chosenRuns.map((run) => run.costUsd);
      const medianUsd = percentile(costs, 0.5);
      const p90Usd = Math.max(medianUsd, percentile(costs, 0.9));
      targetEstimate = { medianUsd, p90Usd };
    } else if (chosenRuns.length > 0) {
      outputTokens = computeBucketOutputTokens(chosenRuns, totalInputTokens, 0.5);
      targetEstimate = estimateFor(targetRate, chosenRuns);
    } else {
      outputTokens = FALLBACK_P50_OUTPUT_TOKENS;
      const inputCostUsd =
        contextTokens * targetRate.cacheReadPerToken +
        (promptTokens + attachmentTokens) * targetRate.inputPerToken;
      targetEstimate = {
        medianUsd: inputCostUsd + FALLBACK_P50_OUTPUT_TOKENS * targetRate.outputPerToken,
        p90Usd: inputCostUsd + FALLBACK_P90_OUTPUT_TOKENS * targetRate.outputPerToken,
      };
    }

    const confidence = confidenceFor({ similarRuns: chosenRuns.length });

    const successRateByModel = new Map<string, number>();
    for (const row of history.successRows) {
      if (!row.model) continue;
      const completed = Math.max(0, Number(row.completed_count ?? 0));
      const total = Math.max(0, Number(row.total_count ?? 0));
      if (total === 0) continue;
      successRateByModel.set(row.model, Math.max(0, Math.min(1, completed / total)));
    }

    const targetBlended = blendedPerToken(targetRate);
    const candidateEntries: PickAlternativeCandidate[] = [];
    for (const candidateModel of provider?.models ?? []) {
      if (candidateModel.slug === input.model) continue;
      const candidateRate = rates.get(candidateModel.slug);
      if (candidateRate === undefined) continue;
      const allCandidateSimilar = pricedRuns.filter(
        (run) =>
          run.model === candidateModel.slug &&
          jaccard(queryTrigrams, run.promptTrigrams) >= SIMILARITY_THRESHOLD,
      );
      const projectCandidateSimilar =
        threadContext.projectId === null
          ? []
          : allCandidateSimilar.filter((run) => run.projectId === threadContext.projectId);
      const candidateSimilar =
        projectCandidateSimilar.length >= MIN_SIMILAR_RUNS
          ? projectCandidateSimilar
          : allCandidateSimilar;
      const similarRuns = candidateSimilar.length;
      const successRate = successRateByModel.get(candidateModel.slug) ?? 0;
      const similarCosts = candidateSimilar.map((run) => run.costUsd);
      const medianCostUsd = similarRuns > 0 ? percentile(similarCosts, 0.5) : 0;

      let candidateEstimate: PromptCostEstimate;
      let verdict: PickAlternativeCandidate["verdict"];
      if (similarRuns >= MIN_SIMILAR_RUNS) {
        candidateEstimate = input.compactFirst
          ? estimateFor(candidateRate, candidateSimilar)
          : {
              medianUsd: medianCostUsd,
              p90Usd: Math.max(medianCostUsd, percentile(similarCosts, 0.9)),
            };
        verdict = verdictFor({ similarRuns, successRate });
      } else {
        const ratio = targetBlended > 0 ? blendedPerToken(candidateRate) / targetBlended : 0;
        candidateEstimate = {
          medianUsd: targetEstimate.medianUsd * ratio,
          p90Usd: targetEstimate.p90Usd * ratio,
        };
        verdict = "untested";
      }

      candidateEntries.push({
        instanceId: input.providerInstanceId,
        model: candidateModel.slug,
        label: candidateModel.name,
        rate: candidateRate,
        estimate: candidateEstimate,
        verdict,
        evidence: {
          similarRuns,
          successRate,
          medianCostUsd,
        },
      });
    }

    const alternatives = pickAlternatives({
      candidates: candidateEntries,
      targetRate,
      targetEstimate,
      minSaveRatio: 0,
    });

    let classifier: PromptCostClassifier | null = null;
    let note: PromptCostNote | null = null;
    const trimmedPrompt = input.promptText.trim();
    if (input.useClassifier && trimmedPrompt.length > 0) {
      const classifierSelection = resolveClassifierSelection(settings, provider, rates);
      if (classifierSelection !== null) {
        const classifierKey = sha256Hex(
          `${classifierSelection.instanceId}\0${classifierSelection.model}\0${input.model}\0${trimmedPrompt}`,
        );
        const cachedClassifier = classifierCache.get(classifierKey, nowMs);
        if (cachedClassifier !== undefined) {
          classifier = { ...cachedClassifier, cached: true };
        } else {
          const targetLabel =
            provider?.models.find((model) => model.slug === input.model)?.name ?? input.model;
          const classifierCandidates = [...candidateEntries]
            .toSorted((a, b) => a.estimate.medianUsd - b.estimate.medianUsd)
            .slice(0, CLASSIFIER_MAX_CANDIDATES)
            .map((candidate) => ({
              label: candidate.label,
              medianUsd: candidate.estimate.medianUsd,
            }));
          const cwd = Option.match(serverConfig, {
            onNone: () => process.cwd(),
            onSome: (config) => config.cwd,
          });
          const classified = yield* textGeneration
            .generatePromptCostAssessment({
              cwd,
              prompt: trimmedPrompt.slice(0, CLASSIFIER_PROMPT_MAX_CHARS),
              candidates: classifierCandidates,
              targetLabel,
              targetMedianUsd: targetEstimate.medianUsd,
              modelSelection: classifierSelection,
              projectId: threadContext.projectId,
            })
            .pipe(
              Effect.map((result): CachedClassifierValue => ({
                complexity: result.complexity,
                reason: result.reason,
                model: classifierSelection.model,
              })),
              Effect.catchCause(() => Effect.succeed<CachedClassifierValue | null>(null)),
            );
          if (classified !== null) {
            classifierCache.set(classifierKey, classified, nowMs);
            classifier = { ...classified, cached: false };
          } else {
            classifier = null;
            note = "classifierUnavailable";
          }
        }
      }
    }

    const recommendation = chooseRecommendation({
      alternatives,
      confidence,
      classifierComplexity: classifier?.complexity ?? null,
    });

    const assessment: PromptCostAssessment = {
      inputTokens: {
        context: contextTokens,
        prompt: promptTokens,
        attachments: attachmentTokens,
        output: outputTokens,
      },
      estimate: targetEstimate,
      confidence,
      basis,
      classifier,
      alternatives: [...alternatives],
      recommendation,
      priced: true,
      note,
    };

    if (confidence !== "none" && note !== "classifierUnavailable") {
      assessmentCache.set(cacheKey, assessment, nowMs);
    }

    return assessment;
  });

  return PromptCostService.of({ predict });
});

export const layer = Layer.effect(PromptCostService, make);
