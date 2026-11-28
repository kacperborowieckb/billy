import { Effect, Schema } from "effect";

import { ReviewRecordSchema } from "../auto-review/review-record.ts";
import { RestartRecordSchema } from "../journal/journal.ts";
import { ReasoningEffortSchema } from "../model-gateway/model-provider.ts";
import { outcomeKinds } from "../personal-agent/storage-values.ts";
import { TracedRequestSchema } from "./traced-request.ts";

const TraceUsageSchema = Schema.Struct({
  inputTokens: Schema.NullOr(Schema.Number),
  outputTokens: Schema.NullOr(Schema.Number),
  cachedInputTokens: Schema.NullOr(Schema.Number),
  costUsd: Schema.NullOr(Schema.Number),
});

const ToolCallSchema = Schema.Struct({
  callId: Schema.String,
  name: Schema.String,
  input: Schema.String,
  output: Schema.String,
  failed: Schema.Boolean,
});

const TraceStepSchema = Schema.Struct({
  toolCalls: Schema.Array(ToolCallSchema),
  usage: TraceUsageSchema,
});

export const modelTraceFields = {
  modelId: Schema.String,
  modelSettings: Schema.Struct({
    attempts: Schema.Number,
    attemptTimeoutMillis: Schema.Number,
    reasoningEffort: Schema.optionalKey(ReasoningEffortSchema),
  }),
  request: TracedRequestSchema,
  steps: Schema.Array(TraceStepSchema).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  reply: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  usage: TraceUsageSchema,
  modelLatencyMillis: Schema.Number,
  outcome: Schema.NullOr(
    Schema.Struct({
      kind: Schema.Literals(outcomeKinds),
      emoji: Schema.optionalKey(Schema.String),
      requestedEmoji: Schema.optionalKey(Schema.String),
    })
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  refusedOutcomeTools: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  rejectedStubReplies: Schema.optionalKey(Schema.Array(Schema.String)),
  reviews: Schema.optionalKey(Schema.Array(ReviewRecordSchema)),
  restart: Schema.optionalKey(RestartRecordSchema),
  trustLevelChange: Schema.optionalKey(
    Schema.Struct({
      trustLevel: Schema.Literal("untrusted"),
      toolCallId: Schema.String,
      toolName: Schema.String,
    })
  ),
};
