// V3 Code permanently disables agent feedback telemetry and storage.
import {
  type AgentFeedbackAnswerInput,
  type AgentFeedbackMode,
  type AgentFeedbackPreview,
  AgentFeedbackRequestError,
  type AgentFeedbackTrace,
  type NodeId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ProviderDimensions } from "../telemetry/ProviderDimensions.ts";
import {
  type FeedbackLimitError,
  type FeedbackNotRequestedError,
  FeedbackOffError,
  type FeedbackReport,
  type FeedbackStorageError,
  type FeedbackSource,
} from "./FeedbackReport.ts";

export interface FeedbackCard {
  readonly reportId: string;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly preview: AgentFeedbackPreview;
  readonly conversationTrace: AgentFeedbackTrace | null;
}

export interface UnpromptedReport {
  readonly id: string;
  readonly preview: AgentFeedbackPreview;
  readonly source: FeedbackSource;
  readonly threadId: ThreadId | null;
  readonly runId: RunId | null;
  readonly dimensions: Partial<ProviderDimensions>;
}

export class FeedbackStore extends Context.Service<
  FeedbackStore,
  {
    readonly store: (
      report: UnpromptedReport,
    ) => Effect.Effect<
      FeedbackReport,
      FeedbackLimitError | FeedbackOffError | FeedbackNotRequestedError | FeedbackStorageError
    >;
    readonly showCard: (
      card: FeedbackCard,
    ) => Effect.Effect<void, FeedbackLimitError | FeedbackStorageError>;
    readonly answer: (
      input: AgentFeedbackAnswerInput,
    ) => Effect.Effect<void, AgentFeedbackRequestError>;
  }
>()("v3code/feedback/FeedbackStore") {}

export const allowedBy = (
  _mode: AgentFeedbackMode,
  _userRequested: boolean,
  _source: FeedbackSource,
): Effect.Effect<void, FeedbackOffError | FeedbackNotRequestedError> =>
  Effect.fail(new FeedbackOffError({}));

export const layer = Layer.succeed(
  FeedbackStore,
  FeedbackStore.of({
    store: Effect.fn("FeedbackStore.store")(function* () {
      return yield* new FeedbackOffError({});
    }),
    showCard: Effect.fn("FeedbackStore.showCard")(function* () {}),
    answer: Effect.fn("FeedbackStore.answer")(function* () {
      return yield* new AgentFeedbackRequestError({ reason: "feedback_off" });
    }),
  }),
);
