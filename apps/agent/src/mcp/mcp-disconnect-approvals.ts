import { and, eq, inArray } from "drizzle-orm";
import { DateTime, Effect, Option, Schema } from "effect";

import { pendingApprovals } from "../approval/pending-approvals-schema.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import {
  callMcpToolToolName,
  disconnectMcpConnectionToolName,
} from "./mcp-tool-names.ts";

const FrozenCallSchema = Schema.fromJsonString(
  Schema.Struct({ connection: Schema.String })
);

const decodeFrozenCall = Schema.decodeUnknownOption(FrozenCallSchema);

const connectionOf = (frozenInput: string) =>
  Option.getOrUndefined(
    Option.map(decodeFrozenCall(frozenInput), ({ connection }) => connection)
  );

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
          inArray(pendingApprovals.toolName, [
            callMcpToolToolName,
            disconnectMcpConnectionToolName,
          ])
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
