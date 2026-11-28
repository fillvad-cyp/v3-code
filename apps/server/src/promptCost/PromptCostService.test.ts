import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  TextGenerationError,
  ThreadId,
  type PromptCostInput,
  type ServerProvider,
  type ServerSettings as ServerSettingsValue,
  type UsageProviderKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as PromptCostService from "./PromptCostService.ts";

const INSTANCE = ProviderInstanceId.make("claudeAgent");
const NOW_ISO = "2026-11-28T05:00:00.000Z";

const RATES: Record<string, UsageService.UsageModelRate> = {
  "claude-opus-4-5": {
    inputPerToken: 15e-6,
    cacheReadPerToken: 1.5e-6,
    cacheWritePerToken: 18.75e-6,
    outputPerToken: 75e-6,
  },
  "claude-sonnet-4-5": {
    inputPerToken: 3e-6,
    cacheReadPerToken: 0.3e-6,
    cacheWritePerToken: 3.75e-6,
    outputPerToken: 15e-6,
  },
  "claude-haiku-4-5": {
    inputPerToken: 0.8e-6,
    cacheReadPerToken: 0.08e-6,
    cacheWritePerToken: 1e-6,
    outputPerToken: 4e-6,
  },
};

const PROVIDER: ServerProvider = {
  instanceId: INSTANCE,
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: NOW_ISO,
  models: [
    { slug: "claude-opus-4-5", name: "Claude Opus 4.5", isCustom: false, capabilities: null },
    { slug: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", isCustom: false, capabilities: null },
    { slug: "claude-haiku-4-5", name: "Claude Haiku 4.5", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
};

function makeInput(overrides: Partial<PromptCostInput> = {}): PromptCostInput {
  return {
    providerInstanceId: INSTANCE,
    model: "claude-opus-4-5",
    threadId: null,
    promptText: "refactor the authentication middleware session token validator cleanly",
    attachments: [],
    compactFirst: false,
    useClassifier: false,
    ...overrides,
  };
}

const seedThread = (
  threadId: string,
  projectId: string,
  options?: {
    readonly activeProviderThreadId?: string | null;
    readonly deletedAt?: string | null;
  },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const activeProviderThreadId =
      options && "activeProviderThreadId" in options
        ? options.activeProviderThreadId
        : `pt-${threadId}`;
    yield* sql`INSERT OR IGNORE INTO orchestration_v2_projection_threads ${sql.insert({
      thread_id: threadId,
      project_id: projectId,
      title: "Test Thread",
      default_provider: "claudeAgent",
      runtime_mode: "full-access",
      interaction_mode: "default",
      active_provider_thread_id: activeProviderThreadId,
      created_at: NOW_ISO,
      updated_at: NOW_ISO,
      archived_at: null,
      deleted_at: options?.deletedAt ?? null,
      payload_json: "{}",
      provider_instance_id: INSTANCE,
    })}`;
  });

const seedRun = (input: {
  readonly runId: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly ordinal: number;
  readonly model: string;
  readonly status?: "completed" | "failed" | "interrupted";
  readonly requestedAt?: string;
  readonly inputTokens: number;
  readonly cachedInputTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly outputTokens: number;
  readonly usedTokens?: number;
  readonly tokenUsageUpdatedAt?: string;
  readonly promptText: string;
  readonly omitTurnTokenUsage?: boolean;
  readonly activeProviderThreadId?: string | null;
  readonly deletedAt?: string | null;
  readonly providerThreadId?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedThread(input.threadId, input.projectId, {
      ...(input.activeProviderThreadId !== undefined
        ? { activeProviderThreadId: input.activeProviderThreadId }
        : {}),
      ...(input.deletedAt !== undefined ? { deletedAt: input.deletedAt } : {}),
    });
    const requestedAt = input.requestedAt ?? DateTime.formatIso(yield* DateTime.now);
    const nodeId = `node-${input.runId}`;
    const attemptId = `attempt-${input.runId}`;
    const messageId = `msg-${input.runId}`;
    const providerThreadId = input.providerThreadId ?? `pt-${input.threadId}`;
    yield* sql`INSERT INTO orchestration_v2_projection_runs ${sql.insert({
      run_id: input.runId,
      thread_id: input.threadId,
      ordinal: input.ordinal,
      provider: "claudeAgent",
      provider_thread_id: providerThreadId,
      status: input.status ?? "completed",
      requested_at: requestedAt,
      completed_at: requestedAt,
      payload_json: JSON.stringify({
        modelSelection: { instanceId: INSTANCE, model: input.model },
        rootNodeId: nodeId,
        activeAttemptId: attemptId,
        userMessageId: messageId,
      }),
      provider_instance_id: INSTANCE,
    })}`;
    yield* sql`INSERT INTO orchestration_v2_projection_nodes ${sql.insert({
      node_id: nodeId,
      thread_id: input.threadId,
      run_id: input.runId,
      parent_node_id: null,
      root_node_id: nodeId,
      kind: "root",
      status: input.status ?? "completed",
      provider_thread_id: providerThreadId,
      provider_turn_id: `turn-${input.runId}`,
      runtime_request_id: null,
      checkpoint_scope_id: null,
      started_at: requestedAt,
      completed_at: requestedAt,
      payload_json: "{}",
    })}`;
    yield* sql`INSERT INTO orchestration_v2_projection_provider_turns ${sql.insert({
      provider_turn_id: `turn-${input.runId}`,
      thread_id: input.threadId,
      provider_thread_id: providerThreadId,
      node_id: nodeId,
      run_attempt_id: attemptId,
      ordinal: input.ordinal,
      status: input.status ?? "completed",
      started_at: requestedAt,
      completed_at: requestedAt,
      payload_json: JSON.stringify({
        ...(input.usedTokens !== undefined
          ? {
              tokenUsage: {
                usedTokens: input.usedTokens,
                updatedAt: input.tokenUsageUpdatedAt ?? requestedAt,
              },
            }
          : {}),
        ...(input.omitTurnTokenUsage
          ? {}
          : {
              turnTokenUsage: {
                inputTokens: input.inputTokens,
                cachedInputTokens: input.cachedInputTokens ?? 0,
                ...(input.cacheCreationTokens !== undefined
                  ? { cacheCreationTokens: input.cacheCreationTokens }
                  : {}),
                outputTokens: input.outputTokens,
              },
            }),
      }),
    })}`;
    yield* sql`INSERT INTO orchestration_v2_projection_messages ${sql.insert({
      message_id: messageId,
      thread_id: input.threadId,
      run_id: input.runId,
      node_id: nodeId,
      role: "user",
      streaming: 0,
      created_at: requestedAt,
      updated_at: requestedAt,
      payload_json: JSON.stringify({ text: input.promptText }),
      search_text: input.promptText,
    })}`;
  });

function makeTestLayer(options?: {
  readonly rates?: Record<string, UsageService.UsageModelRate>;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
  readonly getSettings?: () => ServerSettingsValue;
  readonly classify?: TextGeneration.TextGeneration["Service"]["generatePromptCostAssessment"];
  readonly onLookupRates?: (
    provider: UsageProviderKind | undefined,
    models: ReadonlyArray<string>,
  ) => void;
}) {
  const ratesMap = options?.rates ?? RATES;
  const providers = options?.providers ?? [PROVIDER];
  const settingsLayer =
    options?.getSettings !== undefined
      ? Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.sync(options.getSettings),
        })
      : ServerSettings.layerTest(options?.settings ?? {});
  return PromptCostService.layer.pipe(
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provide(
      Layer.mock(UsageService.UsageService)({
        lookupRates: (provider, models) =>
          Effect.sync(() => {
            options?.onLookupRates?.(provider, models);
            const result = new Map<string, UsageService.UsageModelRate>();
            for (const model of models) {
              const found = ratesMap[model];
              if (found !== undefined) result.set(model, found);
            }
            return result;
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed(providers),
      }),
    ),
    Layer.provide(settingsLayer),
    Layer.provide(
      Layer.mock(TextGeneration.TextGeneration)({
        generatePromptCostAssessment:
          options?.classify ??
          (() => Effect.succeed({ complexity: "simple" as const, reason: "Small edit." })),
      }),
    ),
  );
}

describe("PromptCostService", () => {
  it.effect("returns priced=false with noPrice note when target model has no rate", () =>
    Effect.gen(function* () {
      const service = yield* PromptCostService.PromptCostService;
      const result = yield* service.predict(makeInput({ model: "unknown-model" }));
      assert.strictEqual(result.priced, false);
      assert.strictEqual(result.note, "noPrice");
      assert.deepStrictEqual(result.estimate, { medianUsd: 0, p90Usd: 0 });
      assert.strictEqual(result.confidence, "none");
      assert.deepStrictEqual(result.basis, []);
      assert.deepStrictEqual(result.alternatives, []);
      assert.isNull(result.recommendation);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("batches rate lookups once per request with the mapped usage provider kind", () =>
    Effect.gen(function* () {
      const lookupCalls: Array<{
        provider: UsageProviderKind | undefined;
        models: ReadonlyArray<string>;
      }> = [];
      const layer = makeTestLayer({
        onLookupRates: (provider, models) => {
          lookupCalls.push({ provider, models });
        },
      });
      yield* Effect.gen(function* () {
        const service = yield* PromptCostService.PromptCostService;
        const result = yield* service.predict(makeInput());
        assert.strictEqual(result.priced, true);
        assert.strictEqual(lookupCalls.length, 1);
        assert.strictEqual(lookupCalls[0]?.provider, "claude");
        assert.includeMembers(
          [...(lookupCalls[0]?.models ?? [])],
          ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"],
        );
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "reads latest active provider thread context by tokenUsage.updatedAt and returns 0 with no active thread",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW_ISO));
        const sql = yield* SqlClient.SqlClient;
        yield* seedRun({
          runId: "r-old",
          threadId: "thread-ctx",
          projectId: "proj-1",
          ordinal: 1,
          model: "claude-opus-4-5",
          requestedAt: "2026-11-27T01:00:00.000Z",
          inputTokens: 10_000,
          outputTokens: 500,
          usedTokens: 12_000,
          promptText: "unrelated earlier prompt",
        });
        yield* seedRun({
          runId: "r-new",
          threadId: "thread-ctx",
          projectId: "proj-1",
          ordinal: 2,
          model: "claude-opus-4-5",
          requestedAt: "2026-11-28T01:00:00.000Z",
          inputTokens: 20_000,
          outputTokens: 800,
          usedTokens: 100_000,
          promptText: "unrelated later prompt",
        });
        // A newer turn on an inactive provider_thread_id must be ignored.
        yield* sql`INSERT INTO orchestration_v2_projection_provider_turns ${sql.insert({
          provider_turn_id: "turn-inactive-pt",
          thread_id: "thread-ctx",
          provider_thread_id: "pt-stale-other",
          node_id: "node-r-new",
          run_attempt_id: "attempt-stale-other",
          ordinal: 3,
          status: "completed",
          started_at: "2026-11-28T04:00:00.000Z",
          completed_at: "2026-11-28T04:00:00.000Z",
          payload_json: JSON.stringify({
            tokenUsage: { usedTokens: 250_000, updatedAt: "2026-11-28T04:00:00.000Z" },
          }),
        })}`;
        // A newer turn without tokenUsage must not mask the previous turn's tokenUsage.
        yield* sql`INSERT INTO orchestration_v2_projection_provider_turns ${sql.insert({
          provider_turn_id: "turn-no-usage",
          thread_id: "thread-ctx",
          provider_thread_id: "pt-thread-ctx",
          node_id: "node-r-new",
          run_attempt_id: "attempt-r-new",
          ordinal: 99,
          status: "completed",
          started_at: "2026-11-28T04:30:00.000Z",
          completed_at: "2026-11-28T04:30:00.000Z",
          payload_json: JSON.stringify({}),
        })}`;

        // A thread with no active_provider_thread_id yields context 0.
        yield* seedThread("thread-no-active", "proj-1", { activeProviderThreadId: null });
        yield* sql`INSERT INTO orchestration_v2_projection_provider_turns ${sql.insert({
          provider_turn_id: "turn-orphan",
          thread_id: "thread-no-active",
          provider_thread_id: "pt-old",
          node_id: "node-orphan",
          run_attempt_id: null,
          ordinal: 1,
          status: "completed",
          started_at: NOW_ISO,
          completed_at: NOW_ISO,
          payload_json: JSON.stringify({
            tokenUsage: { usedTokens: 90_000, updatedAt: NOW_ISO },
          }),
        })}`;

        const service = yield* PromptCostService.PromptCostService;
        const normal = yield* service.predict(
          makeInput({ threadId: ThreadId.make("thread-ctx"), compactFirst: false }),
        );
        assert.strictEqual(normal.priced, true);
        assert.strictEqual(normal.inputTokens.context, 100_000);
        assert.strictEqual(normal.inputTokens.output, 2_500);
        assert.deepStrictEqual(normal.basis, ["rates"]);
        assert.strictEqual(normal.confidence, "none");

        const compacted = yield* service.predict(
          makeInput({ threadId: ThreadId.make("thread-ctx"), compactFirst: true }),
        );
        assert.strictEqual(compacted.inputTokens.context, 15_000);
        assert.deepStrictEqual(compacted.basis, ["compact", "rates"]);
        assert.isBelow(compacted.estimate.medianUsd, normal.estimate.medianUsd);

        // The compaction floor must not inflate a small thread's context beyond what it uses.
        yield* seedRun({
          runId: "r-small",
          threadId: "thread-small",
          projectId: "proj-1",
          ordinal: 1,
          model: "claude-opus-4-5",
          inputTokens: 1_000,
          outputTokens: 10,
          usedTokens: 1_000,
          promptText: "tiny thread prompt",
        });
        const smallCompacted = yield* service.predict(
          makeInput({ threadId: ThreadId.make("thread-small"), compactFirst: true }),
        );
        assert.strictEqual(smallCompacted.inputTokens.context, 1_000);
        assert.deepStrictEqual(smallCompacted.basis, ["compact", "rates"]);

        const noActive = yield* service.predict(
          makeInput({ threadId: ThreadId.make("thread-no-active"), compactFirst: false }),
        );
        assert.strictEqual(noActive.inputTokens.context, 0);
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "does not double count retried attempts or child nodes and excludes runs without usage or from deleted threads",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW_ISO));
        const sql = yield* SqlClient.SqlClient;
        const prompt = "implement strict oauth refresh token rotation handler";

        // 3 completed runs on target Opus with 10k input + 0 output -> $0.15 each.
        for (let index = 0; index < 3; index++) {
          yield* seedRun({
            runId: `retry-run-${index}`,
            threadId: `retry-thread-${index}`,
            projectId: "proj-1",
            ordinal: 1,
            model: "claude-opus-4-5",
            inputTokens: 10_000,
            outputTokens: 0,
            promptText: prompt,
          });
        }
        // Add an earlier failed attempt turn on the SAME root node for retry-run-0 (must NOT be summed).
        yield* sql`INSERT INTO orchestration_v2_projection_provider_turns ${sql.insert({
          provider_turn_id: "turn-retry-run-0-old-attempt",
          thread_id: "retry-thread-0",
          provider_thread_id: "pt-retry-thread-0",
          node_id: "node-retry-run-0",
          run_attempt_id: "attempt-stale-0",
          ordinal: 99,
          status: "failed",
          started_at: NOW_ISO,
          completed_at: NOW_ISO,
          payload_json: JSON.stringify({
            turnTokenUsage: { inputTokens: 90_000, cachedInputTokens: 0, outputTokens: 0 },
          }),
        })}`;
        // Add a child node and its turn on retry-run-0 (must NOT be summed).
        yield* sql`INSERT INTO orchestration_v2_projection_nodes ${sql.insert({
          node_id: "child-node-retry-run-0",
          thread_id: "retry-thread-0",
          run_id: "retry-run-0",
          parent_node_id: "node-retry-run-0",
          root_node_id: "node-retry-run-0",
          kind: "subagent",
          status: "completed",
          provider_thread_id: "pt-child-0",
          provider_turn_id: "turn-child-0",
          runtime_request_id: null,
          checkpoint_scope_id: null,
          started_at: NOW_ISO,
          completed_at: NOW_ISO,
          payload_json: "{}",
        })}`;
        yield* sql`INSERT INTO orchestration_v2_projection_provider_turns ${sql.insert({
          provider_turn_id: "turn-child-0",
          thread_id: "retry-thread-0",
          provider_thread_id: "pt-child-0",
          node_id: "child-node-retry-run-0",
          run_attempt_id: "attempt-retry-run-0",
          ordinal: 1,
          status: "completed",
          started_at: NOW_ISO,
          completed_at: NOW_ISO,
          payload_json: JSON.stringify({
            turnTokenUsage: { inputTokens: 80_000, cachedInputTokens: 0, outputTokens: 0 },
          }),
        })}`;

        // Add runs with absent turnTokenUsage, zero tokens, and deleted thread — none may enter the bucket.
        for (let index = 0; index < 3; index++) {
          yield* seedRun({
            runId: `no-usage-${index}`,
            threadId: `no-usage-thread-${index}`,
            projectId: "proj-1",
            ordinal: 1,
            model: "claude-opus-4-5",
            inputTokens: 0,
            outputTokens: 0,
            omitTurnTokenUsage: true,
            promptText: prompt,
          });
          yield* seedRun({
            runId: `deleted-run-${index}`,
            threadId: `deleted-thread-${index}`,
            projectId: "proj-1",
            ordinal: 1,
            model: "claude-opus-4-5",
            inputTokens: 500_000,
            outputTokens: 0,
            deletedAt: NOW_ISO,
            promptText: prompt,
          });
        }

        const service = yield* PromptCostService.PromptCostService;
        const result = yield* service.predict(makeInput({ promptText: prompt }));
        // Exactly the 3 valid runs ($0.15 each) -> medium confidence (not high) and exact $0.15 cost.
        assert.strictEqual(result.confidence, "medium");
        assert.deepStrictEqual(result.basis, ["globalSimilar"]);
        assert.closeTo(result.estimate.medianUsd, 0.15, 1e-9);
        assert.closeTo(result.estimate.p90Usd, 0.15, 1e-9);
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("prices cacheCreationTokens at cacheWritePerToken in history runs", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW_ISO));
      const prompt = "measure prompt cache creation billing accurately across turns";
      // inputTokens = 10_000, cached = 2_000, cacheCreation = 4_000 -> uncached = 4_000.
      // Cost = 4_000 * 15e-6 + 2_000 * 1.5e-6 + 4_000 * 18.75e-6 + 0 = 0.06 + 0.003 + 0.075 = 0.138.
      for (let index = 0; index < 3; index++) {
        yield* seedRun({
          runId: `cache-write-${index}`,
          threadId: `cw-thread-${index}`,
          projectId: "proj-1",
          ordinal: 1,
          model: "claude-opus-4-5",
          inputTokens: 10_000,
          cachedInputTokens: 2_000,
          cacheCreationTokens: 4_000,
          outputTokens: 0,
          promptText: prompt,
        });
      }

      const service = yield* PromptCostService.PromptCostService;
      const result = yield* service.predict(makeInput({ promptText: prompt }));
      assert.deepStrictEqual(result.basis, ["globalSimilar"]);
      assert.closeTo(result.estimate.medianUsd, 0.138, 1e-9);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "derives compactFirst USD estimate from compacted tokens and bucket p50/p90 output ratios",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW_ISO));
        const prompt = "compact large thread history before running next turn";
        // Seed 4 runs in thread-compact with huge input (100k -> ~$1.50+) and varying output ratios (0.01, 0.02, 0.04, 0.10).
        const outputs = [1_000, 2_000, 4_000, 10_000];
        for (const [index, outputTokens] of outputs.entries()) {
          yield* seedRun({
            runId: `cmp-${index}`,
            threadId: "thread-compact",
            projectId: "proj-1",
            ordinal: index + 1,
            model: "claude-opus-4-5",
            requestedAt: `2026-11-28T0${index + 1}:00:00.000Z`,
            inputTokens: 100_000,
            outputTokens,
            usedTokens: 100_000,
            promptText: prompt,
          });
        }

        const service = yield* PromptCostService.PromptCostService;
        const uncompacted = yield* service.predict(
          makeInput({
            threadId: ThreadId.make("thread-compact"),
            promptText: prompt,
            compactFirst: false,
          }),
        );
        const compacted = yield* service.predict(
          makeInput({
            threadId: ThreadId.make("thread-compact"),
            promptText: prompt,
            compactFirst: true,
          }),
        );

        assert.deepStrictEqual(uncompacted.basis, ["ownThread"]);
        assert.deepStrictEqual(compacted.basis, ["compact", "ownThread"]);
        assert.strictEqual(compacted.inputTokens.context, 15_000);
        // Uncompacted raw median cost is > $1.50; compacted prices 15k cached context + prompt + bucket output ratios.
        assert.isAbove(uncompacted.estimate.medianUsd, 1.5);
        assert.isBelow(compacted.estimate.medianUsd, 0.15);
        assert.isAbove(compacted.estimate.p90Usd, compacted.estimate.medianUsd);
        const totalInput = compacted.inputTokens.context + compacted.inputTokens.prompt;
        const expectedMedianOut = Math.round(totalInput * 0.03); // median of [0.01, 0.02, 0.04, 0.10]
        const expectedP90Out = Math.round(totalInput * 0.082); // p90 = 0.04 + 0.7 * (0.10 - 0.04)
        const expectedInputCost =
          compacted.inputTokens.context * RATES["claude-opus-4-5"]!.cacheReadPerToken +
          compacted.inputTokens.prompt * RATES["claude-opus-4-5"]!.inputPerToken;
        assert.strictEqual(compacted.inputTokens.output, expectedMedianOut);
        assert.closeTo(
          compacted.estimate.medianUsd,
          expectedInputCost + expectedMedianOut * RATES["claude-opus-4-5"]!.outputPerToken,
          1e-9,
        );
        assert.closeTo(
          compacted.estimate.p90Usd,
          expectedInputCost + expectedP90Out * RATES["claude-opus-4-5"]!.outputPerToken,
          1e-9,
        );
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "computes median and p90 from similar runs and chooses recommendation by verdicts",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW_ISO));
        const prompt = "refactor the authentication middleware session token validator cleanly";

        // 4 similar runs on target Opus -> costs: $0.30, $0.45, $0.60, $0.90 (uncached input * 15e-6 + output * 75e-6)
        for (const [index, inputTokens] of [20_000, 30_000, 40_000, 60_000].entries()) {
          yield* seedRun({
            runId: `opus-${index}`,
            threadId: `other-thread-${index}`,
            projectId: "proj-1",
            ordinal: index + 1,
            model: "claude-opus-4-5",
            inputTokens,
            outputTokens: 0,
            promptText: prompt,
          });
        }

        // 3 similar completed runs on Sonnet (100% success) -> sameFit, cost ~$0.06
        for (let index = 0; index < 3; index++) {
          yield* seedRun({
            runId: `sonnet-${index}`,
            threadId: `sonnet-thread-${index}`,
            projectId: "proj-1",
            ordinal: index + 1,
            model: "claude-sonnet-4-5",
            inputTokens: 20_000,
            outputTokens: 0,
            promptText: prompt,
          });
        }

        // 3 similar completed runs + 3 failed runs on Haiku (50% success < 0.7) -> risky
        for (let index = 0; index < 3; index++) {
          yield* seedRun({
            runId: `haiku-ok-${index}`,
            threadId: `haiku-thread-${index}`,
            projectId: "proj-1",
            ordinal: index + 1,
            model: "claude-haiku-4-5",
            inputTokens: 10_000,
            outputTokens: 0,
            promptText: prompt,
          });
          yield* seedRun({
            runId: `haiku-fail-${index}`,
            threadId: `haiku-fail-thread-${index}`,
            projectId: "proj-1",
            ordinal: index + 1,
            model: "claude-haiku-4-5",
            status: "failed",
            inputTokens: 10_000,
            outputTokens: 0,
            promptText: prompt,
          });
        }

        const service = yield* PromptCostService.PromptCostService;
        const result = yield* service.predict(makeInput({ promptText: prompt }));

        assert.deepStrictEqual(result.basis, ["globalSimilar"]);
        assert.strictEqual(result.confidence, "medium");
        // Median of [0.30, 0.45, 0.60, 0.90] = 0.525; p90 = 0.60 + 0.7 * (0.90 - 0.60) = 0.81
        assert.closeTo(result.estimate.medianUsd, 0.525, 1e-9);
        assert.closeTo(result.estimate.p90Usd, 0.81, 1e-9);

        const sonnet = result.alternatives.find((alt) => alt.model === "claude-sonnet-4-5");
        const haiku = result.alternatives.find((alt) => alt.model === "claude-haiku-4-5");
        assert.isDefined(sonnet);
        assert.isDefined(haiku);
        assert.strictEqual(sonnet!.verdict, "sameFit");
        assert.strictEqual(sonnet!.evidence.similarRuns, 3);
        assert.strictEqual(sonnet!.evidence.successRate, 1);
        assert.closeTo(sonnet!.estimate.medianUsd, 0.06, 1e-9);
        assert.strictEqual(haiku!.verdict, "risky");
        assert.closeTo(haiku!.evidence.successRate, 0.5, 1e-9);

        // Haiku is cheaper than Sonnet, but risky, so Sonnet (sameFit) is recommended.
        assert.strictEqual(result.recommendation?.model, "claude-sonnet-4-5");
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "caches non-none assessments for 60 seconds, invalidates on settings change, and refreshes after TTL",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW_ISO));
        let currentSettings: ServerSettingsValue = { ...DEFAULT_SERVER_SETTINGS };
        const layer = makeTestLayer({ getSettings: () => currentSettings });

        yield* Effect.gen(function* () {
          const prompt = "update billing webhook signature verification logic";
          for (let index = 0; index < 3; index++) {
            yield* seedRun({
              runId: `cache-run-${index}`,
              threadId: "thread-cache",
              projectId: "proj-1",
              ordinal: index + 1,
              model: "claude-opus-4-5",
              inputTokens: 10_000,
              outputTokens: 0,
              promptText: prompt,
            });
          }

          const service = yield* PromptCostService.PromptCostService;
          const input = makeInput({ threadId: ThreadId.make("thread-cache"), promptText: prompt });
          const first = yield* service.predict(input);
          assert.strictEqual(first.confidence, "medium");
          assert.closeTo(first.estimate.medianUsd, 0.15, 1e-9);

          // Insert expensive runs while cache entry is still fresh (< 60s).
          for (let index = 0; index < 6; index++) {
            yield* seedRun({
              runId: `cache-run-late-${index}`,
              threadId: "thread-cache",
              projectId: "proj-1",
              ordinal: index + 10,
              model: "claude-opus-4-5",
              inputTokens: 100_000,
              outputTokens: 0,
              promptText: prompt,
            });
          }

          const cached = yield* service.predict(input);
          assert.strictEqual(cached, first);

          // Changing pricing/classifier settings busts the assessment cache immediately.
          currentSettings = {
            ...currentSettings,
            usageModelAliases: { "alias-a": "claude-opus-4-5" },
          };
          const afterSettingsChange = yield* service.predict(input);
          assert.strictEqual(afterSettingsChange.confidence, "high");
          assert.closeTo(afterSettingsChange.estimate.medianUsd, 1.5, 1e-9);

          // Returning to the original settings still sees the old entry until TTL expires.
          currentSettings = { ...DEFAULT_SERVER_SETTINGS };
          assert.strictEqual(yield* service.predict(input), first);

          yield* TestClock.adjust(Duration.seconds(61));
          const refreshed = yield* service.predict(input);
          assert.strictEqual(refreshed.confidence, "high");
          assert.closeTo(refreshed.estimate.medianUsd, 1.5, 1e-9);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect(
    "keys classifier cache by classifier selection and target model, guards auto-pick capability, and degrades cleanly",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW_ISO));
        let calls = 0;
        let currentSettings: ServerSettingsValue = { ...DEFAULT_SERVER_SETTINGS };
        const layer = makeTestLayer({
          getSettings: () => currentSettings,
          classify: (input) => {
            calls += 1;
            return Effect.succeed({
              complexity: "complex" as const,
              reason: `Classified by ${input.modelSelection.model} for ${input.targetLabel}`,
            });
          },
        });

        yield* Effect.gen(function* () {
          const service = yield* PromptCostService.PromptCostService;
          const first = yield* service.predict(makeInput({ useClassifier: true }));
          assert.strictEqual(calls, 1);
          assert.strictEqual(first.classifier?.model, "claude-haiku-4-5");
          assert.strictEqual(first.classifier?.cached, false);
          assert.isNull(first.note);

          // Same classifier + same target model hits classifier cache.
          const second = yield* service.predict(makeInput({ useClassifier: true }));
          assert.strictEqual(calls, 1);
          assert.strictEqual(second.classifier?.cached, true);

          // Different target model misses classifier cache.
          const otherTarget = yield* service.predict(
            makeInput({ model: "claude-sonnet-4-5", useClassifier: true }),
          );
          assert.strictEqual(calls, 2);
          assert.strictEqual(otherTarget.classifier?.cached, false);

          // Different configured classifier selection misses classifier cache.
          currentSettings = {
            ...currentSettings,
            promptCostClassifier: { instanceId: INSTANCE, model: "claude-sonnet-4-5" },
          };
          const otherClassifier = yield* service.predict(makeInput({ useClassifier: true }));
          assert.strictEqual(calls, 3);
          assert.strictEqual(otherClassifier.classifier?.model, "claude-sonnet-4-5");
          assert.strictEqual(otherClassifier.classifier?.cached, false);
        }).pipe(Effect.provide(layer));

        // Non-text-generation-capable provider skips auto-pick but keeps explicit configuration.
        let nonCapableCalls = 0;
        const nonCapableProvider: ServerProvider = {
          ...PROVIDER,
          supportsTextGeneration: false,
        };
        let nonCapableSettings: ServerSettingsValue = { ...DEFAULT_SERVER_SETTINGS };
        yield* Effect.gen(function* () {
          const service = yield* PromptCostService.PromptCostService;
          const autoSkipped = yield* service.predict(makeInput({ useClassifier: true }));
          assert.isNull(autoSkipped.classifier);
          assert.strictEqual(nonCapableCalls, 0);

          nonCapableSettings = {
            ...nonCapableSettings,
            promptCostClassifier: { instanceId: INSTANCE, model: "claude-haiku-4-5" },
          };
          const configuredUsed = yield* service.predict(makeInput({ useClassifier: true }));
          assert.strictEqual(nonCapableCalls, 1);
          assert.strictEqual(configuredUsed.classifier?.model, "claude-haiku-4-5");
        }).pipe(
          Effect.provide(
            makeTestLayer({
              providers: [nonCapableProvider],
              getSettings: () => nonCapableSettings,
              classify: () => {
                nonCapableCalls += 1;
                return Effect.succeed({ complexity: "simple" as const, reason: "Configured." });
              },
            }),
          ),
        );

        const failingLayer = makeTestLayer({
          classify: () =>
            Effect.fail(
              new TextGenerationError({
                operation: "generatePromptCostAssessment",
                detail: "provider offline",
              }),
            ),
        });

        yield* Effect.gen(function* () {
          const service = yield* PromptCostService.PromptCostService;
          const degraded = yield* service.predict(makeInput({ useClassifier: true }));
          assert.strictEqual(degraded.priced, true);
          assert.isNull(degraded.classifier);
          assert.strictEqual(degraded.note, "classifierUnavailable");
        }).pipe(Effect.provide(failingLayer));
      }),
  );
});
