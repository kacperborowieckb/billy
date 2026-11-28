import { max } from "drizzle-orm";
import { DateTime, Effect, Schema } from "effect";

import type { TrustLevel } from "../notes/note.ts";
import type { AgentStorage } from "../personal-agent/agent-storage.ts";
import { pendingApprovals } from "./pending-approvals-schema.ts";

type Database = AgentStorage["Service"]["database"];

export const encodeFrozenInput = Schema.encodeSync(
  Schema.fromJsonString(Schema.Unknown)
);

export interface DraftRequest {
  readonly turnEventId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly frozenInput: unknown;
  readonly summary: string;
  readonly reviewerReason?: string | undefined;
  readonly trustLevel: TrustLevel;
  readonly expiresAt: DateTime.Utc;
}

const nextPosition = (database: Database) =>
  database
    .select({ last: max(pendingApprovals.position) })
    .from(pendingApprovals)
    .pipe(Effect.map(([row]) => (row?.last ?? 0) + 1));

export const insertDraft = (
  database: Database,
  pendingApprovalId: string,
  request: DraftRequest
) =>
  database.transaction(() =>
    Effect.gen(function* insertDraftEffect() {
      yield* database.insert(pendingApprovals).values({
        pendingApprovalId,
        position: yield* nextPosition(database),
        turnEventId: request.turnEventId,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        frozenInput: encodeFrozenInput(request.frozenInput),
        summary: request.summary,
        reviewerReason: request.reviewerReason ?? null,
        trustLevel: request.trustLevel,
        state: "draft",
        createdAt: DateTime.formatIso(yield* DateTime.now),
        expiresAt: DateTime.formatIso(request.expiresAt),
      });
    })
  );
