import { env, runInDurableObject } from "cloudflare:test";
import { sql } from "drizzle-orm";
import { DateTime, Effect } from "effect";
import { describe, expect, it } from "vitest";

import { approvalsDueToExpire } from "../src/approval/approval-expiry.ts";
import { openApprovals } from "../src/approval/open-approvals.ts";
import { PendingApprovals } from "../src/approval/pending-approvals.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { AgentStorage } from "../src/personal-agent/agent-storage.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { addOwner } from "./telegram-requests.ts";

interface SeededApproval {
  readonly pendingApprovalId: string;
  readonly position: number;
  readonly turnEventId: string;
  readonly expiresAt: string;
}

const longAgo = "2000-01-01T00:00:00.000Z";
const farAway = "2100-01-01T00:00:00.000Z";

const insertedFirstToLast: readonly SeededApproval[] = [
  {
    pendingApprovalId: "open-c",
    position: 30,
    turnEventId: "open-turn",
    expiresAt: farAway,
  },
  {
    pendingApprovalId: "open-a",
    position: 10,
    turnEventId: "open-turn",
    expiresAt: farAway,
  },
  {
    pendingApprovalId: "open-b",
    position: 20,
    turnEventId: "open-turn",
    expiresAt: farAway,
  },
  {
    pendingApprovalId: "due-z",
    position: 60,
    turnEventId: "due-turn",
    expiresAt: longAgo,
  },
  {
    pendingApprovalId: "due-x",
    position: 40,
    turnEventId: "due-turn",
    expiresAt: longAgo,
  },
  {
    pendingApprovalId: "due-y",
    position: 50,
    turnEventId: "due-turn",
    expiresAt: longAgo,
  },
];

const seed = Effect.gen(function* seedEffect() {
  const { database } = yield* AgentStorage;
  for (const approval of insertedFirstToLast) {
    yield* database.run(
      sql`INSERT INTO pending_approvals (pending_approval_id, position, turn_event_id, tool_call_id, tool_name, frozen_input, summary, state, created_at, expires_at) VALUES (${approval.pendingApprovalId}, ${approval.position}, ${approval.turnEventId}, ${`call-${approval.pendingApprovalId}`}, 'send_text', '{}', 'Send', 'pending', '2026-01-01T00:00:00.000Z', ${approval.expiresAt})`
    );
  }
});

const idsOf = (approvals: readonly { readonly pendingApprovalId: string }[]) =>
  approvals.map((approval) => approval.pendingApprovalId);

const readOrders = Effect.gen(function* readOrdersEffect() {
  const { database } = yield* AgentStorage;
  const pendingApprovals = yield* PendingApprovals;
  return {
    forTurn: idsOf(yield* pendingApprovals.forTurn("open-turn")),
    open: idsOf(yield* openApprovals),
    dueToExpire: idsOf(
      yield* approvalsDueToExpire(database, DateTime.nowUnsafe())
    ),
  };
});

describe("the order of Pending Approvals", () => {
  it("follows the position column, not the insertion order", async () => {
    const ownerId = await addOwner(9702);
    const agent = await personalAgentFor(
      env.PERSONAL_AGENT,
      OwnerIdSchema.make(ownerId)
    );

    const orders = await runInDurableObject(agent, (instance) =>
      instance.runtime.runPromise(seed.pipe(Effect.andThen(readOrders)))
    );

    expect(orders).toEqual({
      forTurn: ["open-a", "open-b", "open-c"],
      open: ["open-a", "open-b", "open-c"],
      dueToExpire: ["due-x", "due-y", "due-z"],
    });
  });
});
