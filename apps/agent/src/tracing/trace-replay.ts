import type { ModelMessage } from "ai";
import { and, eq } from "drizzle-orm";
import { Effect, Option, Schema } from "effect";

import { ModelMessageJsonSchema } from "../model-gateway/model-message-schema.ts";
import { ToolDefinitionsJsonSchema } from "../model-gateway/tool-definitions.ts";
import type { ToolDefinition } from "../model-gateway/tool-definitions.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { Conversation } from "../personal-agent/conversation.ts";
import type {
  ModelTurnTask,
  RequestPartKind,
} from "../personal-agent/storage-values.ts";
import { contentHashOf } from "./content-hash.ts";
import { traceRequestParts } from "./trace-storage-schema.ts";
import { conversationRowsHashOf } from "./traced-request.ts";
import type {
  PointedRequest,
  SentConversationRows,
  TracedRequestRecord,
} from "./traced-request.ts";

export type ReplayedPart = RequestPartKind | "conversation_rows";

export interface ReplayProblem {
  readonly part: ReplayedPart;
  readonly reason: "missing" | "changed";
}

export interface ReplayedRequest {
  readonly system: string;
  readonly toolDefinitions: readonly ToolDefinition[];
  readonly messages: readonly ModelMessage[];
}

export type TurnReplay =
  | { readonly _tag: "Replayed"; readonly request: ReplayedRequest }
  | {
      readonly _tag: "RecordedInFull";
      readonly system: string;
      readonly messages: readonly ModelMessage[];
    }
  | {
      readonly _tag: "PartsDiffer";
      readonly problems: readonly ReplayProblem[];
    };

type PartCheck<Value> =
  | { readonly _tag: "Found"; readonly value: Value }
  | { readonly _tag: "Problem"; readonly problem: ReplayProblem };

const found = <Value>(value: Value): PartCheck<Value> => ({
  _tag: "Found",
  value,
});

const problemWith = <Value>(
  part: ReplayedPart,
  reason: ReplayProblem["reason"]
): PartCheck<Value> => ({ _tag: "Problem", problem: { part, reason } });

const decodeToolDefinitions = Schema.decodeUnknownOption(
  ToolDefinitionsJsonSchema
);
const decodeMessage = Schema.decodeUnknownOption(ModelMessageJsonSchema);

const checkedPart = Effect.fnUntraced(function* checkedPart<Value>(
  part: { readonly kind: RequestPartKind; readonly task: ModelTurnTask },
  hash: string,
  decode: (content: string) => Option.Option<Value>
) {
  const { database } = yield* AgentStorage;
  const [row] = yield* database
    .select({ content: traceRequestParts.content })
    .from(traceRequestParts)
    .where(
      and(
        eq(traceRequestParts.kind, part.kind),
        eq(traceRequestParts.task, part.task),
        eq(traceRequestParts.hash, hash)
      )
    );
  if (row === undefined) {
    return problemWith<Value>(part.kind, "missing");
  }
  const decoded = decode(row.content);
  if ((yield* contentHashOf(row.content)) !== hash || Option.isNone(decoded)) {
    return problemWith<Value>(part.kind, "changed");
  }
  return found(decoded.value);
});

const checkedRows = Effect.fnUntraced(function* checkedRows(
  sent: SentConversationRows
) {
  const conversation = yield* Conversation;
  const messages = (yield* conversation.sentRows(sent)).map(
    (row) => row.message
  );
  if ((yield* conversationRowsHashOf(messages)) === sent.hash) {
    return found(messages);
  }
  return problemWith<readonly ModelMessage[]>(
    "conversation_rows",
    messages.length === 0 ? "missing" : "changed"
  );
});

const replayPointedRequest = Effect.fnUntraced(function* replayPointedRequest(
  task: ModelTurnTask,
  request: PointedRequest
) {
  const system = yield* checkedPart(
    { kind: "system", task },
    request.systemHash,
    Option.some
  );
  const toolDefinitions = yield* checkedPart(
    { kind: "tool_definitions", task },
    request.toolDefinitionsHash,
    decodeToolDefinitions
  );
  const ownerContext = yield* checkedPart(
    { kind: "owner_context", task },
    request.ownerContextHash,
    decodeMessage
  );
  const rows = yield* checkedRows(request.conversationRows);
  if (
    system._tag === "Found" &&
    toolDefinitions._tag === "Found" &&
    ownerContext._tag === "Found" &&
    rows._tag === "Found"
  ) {
    return {
      _tag: "Replayed",
      request: {
        system: system.value,
        toolDefinitions: toolDefinitions.value,
        messages: [ownerContext.value, ...rows.value, ...request.tail],
      },
    } satisfies TurnReplay;
  }
  return {
    _tag: "PartsDiffer",
    problems: [system, toolDefinitions, ownerContext, rows].flatMap((check) =>
      check._tag === "Problem" ? [check.problem] : []
    ),
  } satisfies TurnReplay;
});

export interface ReplayableTrace {
  readonly task: ModelTurnTask;
  readonly request: TracedRequestRecord;
}

export const replayTurn = ({ task, request }: ReplayableTrace) =>
  request.kind === "copy"
    ? Effect.succeed<TurnReplay>({
        _tag: "RecordedInFull",
        system: request.system,
        messages: request.messages,
      })
    : replayPointedRequest(task, request);
