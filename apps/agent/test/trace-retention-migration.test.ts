import { env, runInDurableObject } from "cloudflare:test";
import { sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { OwnerIdSchema } from "../src/owner-id.ts";
import { AgentStorage } from "../src/personal-agent/agent-storage.ts";
import personalAgentMigrations from "../src/personal-agent/migrations/migrations.js";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { replayTurn } from "../src/tracing/trace-replay.ts";
import { TurnTraces } from "../src/tracing/turn-trace.ts";
import { addOwner } from "./telegram-requests.ts";

const triggerMigration = "20261125052329_trace_retention_trigger";

const migrationsBeforeTrigger = Object.fromEntries(
  Object.entries(personalAgentMigrations.migrations).filter(
    ([name]) => name < triggerMigration
  )
);

const fullCopyRecord = JSON.stringify({
  task: "reply",
  modelId: "m",
  modelSettings: { attempts: 3, attemptTimeoutMillis: 30_000 },
  system: "The old system text",
  messages: [{ role: "user", content: "The old history" }],
  steps: [],
  reply: "r",
  error: null,
  usage: {
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    costUsd: null,
  },
  modelLatencyMillis: 1,
});

const seedBeforeTrigger = (storage: DurableObjectStorage) =>
  Effect.runPromise(
    AgentStorage.pipe(
      Effect.flatMap(({ database }) =>
        database.run(
          sql`INSERT INTO turn_traces (owner_id, recorded_at, event_id, result, record) VALUES ('owner', '2026-11-01T00:00:00.000Z', 'old-turn', 'model_replied', ${fullCopyRecord})`
        )
      ),
      Effect.provide(
        AgentStorage.layer(storage, {
          migrations: migrationsBeforeTrigger,
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

describe("the Trace retention trigger migration", () => {
  it("moves the copied prompt of an earlier Trace into its request and keeps the trigger", async () => {
    const ownerId = await addOwner(7420);
    const agent = await personalAgentFor(
      env.PERSONAL_AGENT,
      OwnerIdSchema.make(ownerId)
    );

    await runInDurableObject(agent, async (_instance, state) => {
      await seedBeforeTrigger(state.storage);
      await migrateFully(state.storage);
      expect(() =>
        state.storage.sql.exec("UPDATE turn_traces SET result = 'model_failed'")
      ).toThrow("append-only");
    });
    const [stored] = await runInDurableObject(agent, (instance) =>
      instance.runtime.runPromise(
        TurnTraces.pipe(Effect.flatMap((traces) => traces.readReplies))
      )
    );

    expect(stored?.trace.request).toEqual({
      kind: "copy",
      system: "The old system text",
      messages: [{ role: "user", content: "The old history" }],
    });
    expect(stored?.trace).not.toHaveProperty("system");
    const replay = await runInDurableObject(agent, (instance) =>
      instance.runtime.runPromise(
        stored === undefined ? Effect.die("No Trace") : replayTurn(stored.trace)
      )
    );
    expect(replay).toEqual({
      _tag: "RecordedInFull",
      system: "The old system text",
      messages: [{ role: "user", content: "The old history" }],
    });
  });
});
