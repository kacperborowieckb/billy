import { and, asc, eq, gt } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";

import type { ApprovalMessage } from "../channels/channel.ts";
import { Journal } from "../journal/journal.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import {
  pendingApprovalStates,
  trustLevels,
} from "../personal-agent/storage-values.ts";
import type {
  ApprovalAnswering,
  ApprovalRunRecord,
} from "./approval-answering.ts";
import { encodeFrozenInput, insertDraft } from "./draft-insert.ts";
import type { DraftRequest } from "./draft-insert.ts";
import { newPendingApprovalId } from "./pending-approval-id.ts";
import { pendingApprovals } from "./pending-approvals-schema.ts";

export const PendingApprovalSchema = Schema.Struct({
  pendingApprovalId: Schema.String,
  turnEventId: Schema.String,
  toolCallId: Schema.String,
  toolName: Schema.String,
  frozenInput: Schema.fromJsonString(Schema.Unknown),
  summary: Schema.String,
  trustLevel: Schema.Literals(trustLevels),
  state: Schema.Literals(pendingApprovalStates),
  createdAt: Schema.String,
  expiresAt: Schema.String,
  channelMessageId: Schema.NullOr(Schema.String),
  result: Schema.NullOr(Schema.String),
});

export type PendingApproval = typeof PendingApprovalSchema.Type;

export const decodePendingApproval = Schema.decodeUnknownSync(
  PendingApprovalSchema
);

const decodeOpened = Schema.decodeUnknownSync(
  PendingApprovalSchema.mapFields((fields) => ({
    pendingApprovalId: fields.pendingApprovalId,
    toolName: fields.toolName,
  }))
);

export interface SentDrafts {
  readonly turnEventId: string;
  readonly approvalMessages: readonly ApprovalMessage[];
}

export interface DraftApproval {
  readonly pendingApprovalId: string;
  readonly summary: string;
}

const draftsOfTurn = (turnEventId: string) =>
  and(
    eq(pendingApprovals.turnEventId, turnEventId),
    eq(pendingApprovals.state, "draft")
  );

const makePendingApprovals = Effect.gen(function* makePendingApprovalsEffect() {
  const { database } = yield* AgentStorage;
  const journal = yield* Journal;

  const draft = Effect.fnUntraced(function* draft(request: DraftRequest) {
    const pendingApprovalId = newPendingApprovalId();
    yield* insertDraft(database, pendingApprovalId, request);
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
      .orderBy(asc(pendingApprovals.position))
      .pipe(
        Effect.map((rows) => rows.map((row) => decodePendingApproval(row)))
      );

  const journalOpened = Effect.fnUntraced(function* journalOpened(
    turnEventId: string,
    opened: readonly unknown[]
  ) {
    for (const row of opened.map((returned) => decodeOpened(returned))) {
      yield* journal.append({
        _tag: "ApprovalPending",
        eventId: turnEventId,
        pendingApprovalId: row.pendingApprovalId,
        toolName: row.toolName,
      });
    }
  });

  const openSentDraft = Effect.fnUntraced(function* openSentDraft(
    turnEventId: string,
    { pendingApprovalId, channelMessageId }: ApprovalMessage
  ) {
    const opened = yield* database
      .update(pendingApprovals)
      .set({ state: "pending", channelMessageId })
      .where(
        and(
          eq(pendingApprovals.turnEventId, turnEventId),
          eq(pendingApprovals.state, "draft"),
          eq(pendingApprovals.pendingApprovalId, pendingApprovalId)
        )
      )
      .returning({
        pendingApprovalId: pendingApprovals.pendingApprovalId,
        toolName: pendingApprovals.toolName,
      });
    yield* journalOpened(turnEventId, opened);
  });

  const openSentDrafts = ({ turnEventId, approvalMessages }: SentDrafts) =>
    Effect.forEach(
      approvalMessages,
      (approvalMessage) => openSentDraft(turnEventId, approvalMessage),
      { discard: true }
    );

  const openDrafts = (sent: SentDrafts) =>
    database.transaction(() => openSentDrafts(sent));

  const dropDrafts = (turnEventId: string) =>
    database
      .delete(pendingApprovals)
      .where(draftsOfTurn(turnEventId))
      .pipe(Effect.asVoid);

  const openUnconfirmedDrafts = (turnEventId: string) =>
    database.transaction(() =>
      Effect.gen(function* openUnconfirmedDraftsEffect() {
        const opened = yield* database
          .update(pendingApprovals)
          .set({ state: "pending" })
          .where(draftsOfTurn(turnEventId))
          .returning({
            pendingApprovalId: pendingApprovals.pendingApprovalId,
            toolName: pendingApprovals.toolName,
          });
        yield* journalOpened(turnEventId, opened);
      })
    );

  const byId = (pendingApprovalId: string) =>
    database
      .select()
      .from(pendingApprovals)
      .where(eq(pendingApprovals.pendingApprovalId, pendingApprovalId))
      .pipe(
        Effect.map((rows) =>
          Option.fromNullishOr(rows.at(0)).pipe(
            Option.map((row) => decodePendingApproval(row))
          )
        )
      );

  const answerPending = Effect.fnUntraced(function* answerPending({
    eventId,
    pendingApprovalId,
    answer,
  }: ApprovalAnswering) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const answered = yield* database
      .update(pendingApprovals)
      .set({ state: answer === "approve" ? "approved" : "rejected" })
      .where(
        and(
          eq(pendingApprovals.pendingApprovalId, pendingApprovalId),
          eq(pendingApprovals.state, "pending"),
          gt(pendingApprovals.expiresAt, now)
        )
      )
      .returning({ pendingApprovalId: pendingApprovals.pendingApprovalId });
    if (answered.length === 0) {
      return false;
    }
    yield* journal.append({
      _tag: "ApprovalAnswered",
      eventId,
      pendingApprovalId,
      answer,
    });
    return true;
  });

  const recordRun = Effect.fnUntraced(function* recordRun({
    eventId,
    pendingApprovalId,
    outcome,
  }: ApprovalRunRecord) {
    yield* database
      .update(pendingApprovals)
      .set({
        state: outcome.result,
        result:
          outcome.result === "executed"
            ? encodeFrozenInput(outcome.output ?? null)
            : outcome.reason,
      })
      .where(
        and(
          eq(pendingApprovals.pendingApprovalId, pendingApprovalId),
          eq(pendingApprovals.state, "approved")
        )
      );
    yield* journal.append({
      _tag: "ApprovalRun",
      eventId,
      pendingApprovalId,
      result: outcome.result,
      ...(outcome.result === "failed" ? { reason: outcome.reason } : {}),
    });
  });

  return {
    draft,
    forTurn,
    openDrafts,
    dropDrafts,
    openUnconfirmedDrafts,
    byId,
    answerPending,
    recordRun,
  };
});

export class PendingApprovals extends Context.Service<
  PendingApprovals,
  Effect.Success<typeof makePendingApprovals>
>()("PendingApprovals") {
  static readonly layer = Layer.effect(PendingApprovals, makePendingApprovals);
}

export const dropDraftsOf = (turnEventId: string) =>
  PendingApprovals.pipe(
    Effect.flatMap((store) => store.dropDrafts(turnEventId))
  );
