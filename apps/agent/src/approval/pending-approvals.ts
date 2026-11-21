import { and, eq, sql } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Schema } from "effect";

import { Journal } from "../journal/journal.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { pendingApprovalStates } from "../personal-agent/storage-values.ts";
import { pendingApprovals } from "./pending-approvals-schema.ts";

export const PendingApprovalSchema = Schema.Struct({
  pendingApprovalId: Schema.String,
  turnEventId: Schema.String,
  toolCallId: Schema.String,
  toolName: Schema.String,
  frozenInput: Schema.fromJsonString(Schema.Unknown),
  summary: Schema.String,
  state: Schema.Literals(pendingApprovalStates),
  createdAt: Schema.String,
  expiresAt: Schema.String,
  channelMessageId: Schema.NullOr(Schema.String),
  result: Schema.NullOr(Schema.String),
});

export type PendingApproval = typeof PendingApprovalSchema.Type;

const decodeRow = Schema.decodeUnknownSync(PendingApprovalSchema);

const encodeFrozenInput = Schema.encodeSync(
  Schema.fromJsonString(Schema.Unknown)
);

export interface DraftRequest {
  readonly turnEventId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly frozenInput: unknown;
  readonly summary: string;
  readonly expiresAt: DateTime.Utc;
}

export interface DraftApproval {
  readonly pendingApprovalId: string;
  readonly summary: string;
}

const pendingApprovalIdBytes = 9;

export const newPendingApprovalId = () =>
  btoa(
    String.fromCodePoint(
      ...crypto.getRandomValues(new Uint8Array(pendingApprovalIdBytes))
    )
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_");

const makePendingApprovals = Effect.gen(function* makePendingApprovalsEffect() {
  const { database } = yield* AgentStorage;
  const journal = yield* Journal;

  const draft = Effect.fnUntraced(function* draft(request: DraftRequest) {
    const pendingApprovalId = newPendingApprovalId();
    yield* database.insert(pendingApprovals).values({
      pendingApprovalId,
      turnEventId: request.turnEventId,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      frozenInput: encodeFrozenInput(request.frozenInput),
      summary: request.summary,
      state: "draft",
      createdAt: DateTime.formatIso(yield* DateTime.now),
      expiresAt: DateTime.formatIso(request.expiresAt),
    });
    return {
      pendingApprovalId,
      summary: request.summary,
    } satisfies DraftApproval;
  });

  const forTurn = (turnEventId: string) =>
    database
      .select()
      .from(pendingApprovals)
      .where(eq(pendingApprovals.turnEventId, turnEventId))
      .orderBy(sql`rowid`)
      .pipe(Effect.map((rows) => rows.map((row) => decodeRow(row))));

  const openDrafts = (turnEventId: string, channelMessageId: string) =>
    database.transaction(() => openDraftsOfTurn(turnEventId, channelMessageId));

  const openDraftsOfTurn = Effect.fnUntraced(function* openDraftsOfTurn(
    turnEventId: string,
    channelMessageId: string
  ) {
    const opened = yield* database
      .update(pendingApprovals)
      .set({ state: "pending", channelMessageId })
      .where(
        and(
          eq(pendingApprovals.turnEventId, turnEventId),
          eq(pendingApprovals.state, "draft")
        )
      )
      .returning({
        pendingApprovalId: pendingApprovals.pendingApprovalId,
        toolName: pendingApprovals.toolName,
      });
    for (const { pendingApprovalId, toolName } of opened) {
      yield* journal.append({
        _tag: "ApprovalPending",
        eventId: turnEventId,
        pendingApprovalId,
        toolName,
      });
    }
  });

  return { draft, forTurn, openDrafts };
});

export class PendingApprovals extends Context.Service<
  PendingApprovals,
  Effect.Success<typeof makePendingApprovals>
>()("PendingApprovals") {
  static readonly layer = Layer.effect(PendingApprovals, makePendingApprovals);
}
