import type { ModelMessage } from "ai";
import { Effect, Schema } from "effect";

import type { AgentTools } from "../model-gateway/agent-tool.ts";
import {
  ModelMessageJsonSchema,
  ModelMessageSchema,
} from "../model-gateway/model-message-schema.ts";
import {
  ToolDefinitionsJsonSchema,
  toolDefinitionsOf,
} from "../model-gateway/tool-definitions.ts";
import type {
  ConversationRowKind,
  ModelTurnTask,
  RequestPartKind,
} from "../personal-agent/storage-values.ts";
import { sha256Hex } from "../sha256-hex.ts";
import type { Redactor } from "./redactor.ts";

export const SentConversationRowsSchema = Schema.Struct({
  summarySequence: Schema.NullOr(Schema.Number),
  firstSequence: Schema.NullOr(Schema.Number),
  lastSequence: Schema.NullOr(Schema.Number),
  hash: Schema.String,
});

export type SentConversationRows = typeof SentConversationRowsSchema.Type;

const PointedRequestSchema = Schema.Struct({
  kind: Schema.Literal("pointer"),
  systemHash: Schema.String,
  toolDefinitionsHash: Schema.String,
  ownerContextHash: Schema.String,
  conversationRows: SentConversationRowsSchema,
  tailHash: Schema.String,
  tail: Schema.Array(ModelMessageSchema),
});

export type PointedRequest = typeof PointedRequestSchema.Type;

const CopiedRequestSchema = Schema.Struct({
  kind: Schema.Literal("copy"),
  system: Schema.String,
  messages: Schema.Array(ModelMessageSchema),
});

export const TracedRequestSchema = Schema.Union([
  PointedRequestSchema,
  CopiedRequestSchema,
]);

export type TracedRequestRecord = typeof TracedRequestSchema.Type;

export interface RequestPart {
  readonly kind: RequestPartKind;
  readonly task: ModelTurnTask;
  readonly hash: string;
  readonly content: string;
}

export interface SentRow {
  readonly sequence: number;
  readonly kind: ConversationRowKind;
  readonly message: ModelMessage;
}

export interface SentRequest {
  readonly task: ModelTurnTask;
  readonly system: string;
  readonly tools: AgentTools;
  readonly ownerContext: ModelMessage;
  readonly rows: readonly SentRow[];
  readonly tail: readonly ModelMessage[];
}

export interface TracedRequest {
  readonly pointer: PointedRequest;
  readonly parts: readonly RequestPart[];
}

const encodeMessage = Schema.encodeSync(ModelMessageJsonSchema);
const encodeMessages = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(ModelMessageSchema))
);
export const encodeToolDefinitions = Schema.encodeSync(
  ToolDefinitionsJsonSchema
);

export const encodeOwnerContext = encodeMessage;

export const messagesHashOf = (messages: readonly ModelMessage[]) =>
  sha256Hex(encodeMessages(messages));

const sentConversationRowsOf = Effect.fnUntraced(
  function* sentConversationRowsOf(rows: readonly SentRow[]) {
    const summary = rows.find((row) => row.kind === "summary");
    const others = rows.filter((row) => row.kind !== "summary");
    return {
      summarySequence: summary?.sequence ?? null,
      firstSequence: others[0]?.sequence ?? null,
      lastSequence: others.at(-1)?.sequence ?? null,
      hash: yield* messagesHashOf(rows.map((row) => row.message)),
    } satisfies SentConversationRows;
  }
);

export const tracedRequestOf = Effect.fnUntraced(function* tracedRequestOf(
  sent: SentRequest,
  redactor: Redactor["Service"]
) {
  const toolDefinitions = encodeToolDefinitions(
    yield* toolDefinitionsOf(sent.tools)
  );
  const ownerContext = encodeOwnerContext(sent.ownerContext);
  const systemHash = yield* sha256Hex(sent.system);
  const toolDefinitionsHash = yield* sha256Hex(toolDefinitions);
  const ownerContextHash = yield* sha256Hex(ownerContext);
  return {
    pointer: {
      kind: "pointer",
      systemHash,
      toolDefinitionsHash,
      ownerContextHash,
      conversationRows: yield* sentConversationRowsOf(sent.rows),
      tailHash: yield* messagesHashOf(sent.tail),
      tail: sent.tail.map((message) => redactor.redactMessage(message)),
    },
    parts: [
      {
        kind: "system",
        task: sent.task,
        hash: systemHash,
        content: redactor.redact(sent.system),
      },
      {
        kind: "tool_definitions",
        task: sent.task,
        hash: toolDefinitionsHash,
        content: redactor.redact(toolDefinitions),
      },
      {
        kind: "owner_context",
        task: sent.task,
        hash: ownerContextHash,
        content: encodeOwnerContext(redactor.redactMessage(sent.ownerContext)),
      },
    ],
  } satisfies TracedRequest;
});
