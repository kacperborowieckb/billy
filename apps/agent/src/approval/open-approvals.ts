import { and, asc, eq, gt } from "drizzle-orm";
import { DateTime, Effect } from "effect";

import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { pendingApprovals } from "./pending-approvals-schema.ts";
import { decodePendingApproval } from "./pending-approvals.ts";

export const openApprovals = Effect.gen(function* openApprovalsEffect() {
  const { database } = yield* AgentStorage;
  const now = DateTime.formatIso(yield* DateTime.now);
  const rows = yield* database
    .select()
    .from(pendingApprovals)
    .where(
      and(
        eq(pendingApprovals.state, "pending"),
        gt(pendingApprovals.expiresAt, now)
      )
    )
    .orderBy(asc(pendingApprovals.position));
  return rows.map((row) => decodePendingApproval(row));
});
