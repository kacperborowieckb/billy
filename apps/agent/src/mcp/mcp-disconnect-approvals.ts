import { and, eq } from "drizzle-orm";
import { DateTime, Effect } from "effect";

import { pendingApprovals } from "../approval/pending-approvals-schema.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { callMcpToolToolName } from "./mcp-tool-names.ts";

const connectionOf = (frozenInput: string) => {
  try {
    const parsed: unknown = JSON.parse(frozenInput);
    return typeof parsed === "object" &&
      parsed !== null &&
      "connection" in parsed
      ? parsed.connection
      : null;
  } catch {
    return null;
  }
};

export const makeApprovalsOfConnectionDue = Effect.fnUntraced(
  function* makeApprovalsOfConnectionDue(catalogId: string) {
    const { database } = yield* AgentStorage;
    const now = DateTime.formatIso(yield* DateTime.now);
    const open = yield* database
      .select({
        pendingApprovalId: pendingApprovals.pendingApprovalId,
        frozenInput: pendingApprovals.frozenInput,
      })
      .from(pendingApprovals)
      .where(
        and(
          eq(pendingApprovals.state, "pending"),
          eq(pendingApprovals.toolName, callMcpToolToolName)
        )
      );
    for (const approval of open) {
      if (connectionOf(approval.frozenInput) === catalogId) {
        yield* database
          .update(pendingApprovals)
          .set({ expiresAt: now })
          .where(
            and(
              eq(
                pendingApprovals.pendingApprovalId,
                approval.pendingApprovalId
              ),
              eq(pendingApprovals.state, "pending")
            )
          );
      }
    }
  }
);
