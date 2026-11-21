import { and, eq, lte, min, sql } from "drizzle-orm";
import { DateTime, Effect, Option } from "effect";

import { Journal } from "../journal/journal.ts";
import type { AgentStorage } from "../personal-agent/agent-storage.ts";
import { pendingApprovals } from "./pending-approvals-schema.ts";
import { decodePendingApproval } from "./pending-approvals.ts";
import type { PendingApproval } from "./pending-approvals.ts";

type Database = AgentStorage["Service"]["database"];

const pendingBy = (now: DateTime.Utc) =>
  and(
    eq(pendingApprovals.state, "pending"),
    lte(pendingApprovals.expiresAt, DateTime.formatIso(now))
  );

export const earliestApprovalExpiryAt = (database: Database) =>
  database
    .select({ expiresAt: min(pendingApprovals.expiresAt) })
    .from(pendingApprovals)
    .where(eq(pendingApprovals.state, "pending"))
    .pipe(
      Effect.map(([row]) =>
        Option.fromNullishOr(row?.expiresAt).pipe(
          Option.map((expiresAt) => DateTime.makeUnsafe(expiresAt))
        )
      )
    );

export const approvalsDueToExpire = (database: Database, now: DateTime.Utc) =>
  database
    .select()
    .from(pendingApprovals)
    .where(pendingBy(now))
    .orderBy(sql`rowid`)
    .pipe(Effect.map((rows) => rows.map((row) => decodePendingApproval(row))));

export const expireApproval = Effect.fnUntraced(function* expireApproval(
  database: Database,
  approval: PendingApproval,
  now: DateTime.Utc
) {
  const journal = yield* Journal;
  const expired = yield* database
    .update(pendingApprovals)
    .set({ state: "expired" })
    .where(
      and(
        eq(pendingApprovals.pendingApprovalId, approval.pendingApprovalId),
        pendingBy(now)
      )
    )
    .returning({ pendingApprovalId: pendingApprovals.pendingApprovalId });
  if (expired.length === 0) {
    return false;
  }
  yield* journal.append({
    _tag: "ApprovalExpired",
    eventId: approval.turnEventId,
    pendingApprovalId: approval.pendingApprovalId,
  });
  return true;
});
