import { env, runInDurableObject } from "cloudflare:test";
import { sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { OwnerIdSchema } from "../src/owner-id.ts";
import { AgentStorage } from "../src/personal-agent/agent-storage.ts";
import personalAgentMigrations from "../src/personal-agent/migrations/migrations.js";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { addOwner } from "./telegram-requests.ts";

const positionMigration = "20261122215135_pending_approval_position";

const migrationsBeforePosition = Object.fromEntries(
  Object.entries(personalAgentMigrations.migrations).filter(
    ([name]) => name < positionMigration
  )
);

const seededApprovalIds = ["zulu", "alpha", "mike"];

const seedBeforePosition = (storage: DurableObjectStorage) =>
  Effect.runPromise(
    Effect.gen(function* seedEffect() {
      const { database } = yield* AgentStorage;
      for (const pendingApprovalId of seededApprovalIds) {
        yield* database.run(
          sql`INSERT INTO pending_approvals (pending_approval_id, turn_event_id, tool_call_id, tool_name, frozen_input, summary, state, created_at, expires_at) VALUES (${pendingApprovalId}, 'turn', ${`call-${pendingApprovalId}`}, 'send_text', '{}', 'Send', 'pending', '2026-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z')`
        );
      }
    }).pipe(
      Effect.provide(
        AgentStorage.layer(storage, {
          migrations: migrationsBeforePosition,
        }).pipe(Layer.orDie)
      )
    )
  );

const migrateFully = (storage: DurableObjectStorage) =>
  Effect.runPromise(
    Effect.void.pipe(
      Effect.provide(AgentStorage.layer(storage).pipe(Layer.orDie))
    )
  );

describe("the Pending Approval position migration", () => {
  it("gives existing Pending Approvals positions in their insertion order", async () => {
    const ownerId = await addOwner(9701);
    const agent = await personalAgentFor(
      env.PERSONAL_AGENT,
      OwnerIdSchema.make(ownerId)
    );

    const rows = await runInDurableObject(agent, async (_instance, state) => {
      await seedBeforePosition(state.storage);
      await migrateFully(state.storage);
      return state.storage.sql
        .exec<{ pending_approval_id: string }>(
          "SELECT pending_approval_id FROM pending_approvals ORDER BY position"
        )
        .toArray();
    });

    expect(rows.map((row) => row.pending_approval_id)).toEqual(
      seededApprovalIds
    );
  });
});
