import { generateText, jsonSchema, tool } from "ai";
import { env, runInDurableObject } from "cloudflare:test";
import { sql } from "drizzle-orm";
import { DateTime, Effect, Schema } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OwnerIdSchema } from "../src/owner-id.ts";
import { AgentStorage } from "../src/personal-agent/agent-storage.ts";
import type { Conversation } from "../src/personal-agent/conversation.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { Schedules } from "../src/schedule/schedules.ts";
import { replayTurn } from "../src/tracing/trace-replay.ts";
import type {
  ReplayedRequest,
  TurnReplay,
} from "../src/tracing/trace-replay.ts";
import {
  TraceRetentionDaysSchema,
  traceRetentionFloorDays,
} from "../src/tracing/trace-retention-days.ts";
import { TurnTraces } from "../src/tracing/turn-trace.ts";
import type { StoredTurnTrace, TurnTrace } from "../src/tracing/turn-trace.ts";
import {
  fakeModel,
  fakeTelegram,
  fakeTool,
  fakeTraceRetention,
  holdModel,
  resetFakes,
  scriptModel,
} from "./fakes.ts";
import type { ScriptedModelStep } from "./fakes.ts";
import { ownerInWarsaw } from "./owner-with-data.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

type ModelCall = (typeof fakeModel.doGenerateCalls)[number];

type ModelTurnTrace = Extract<TurnTrace, { readonly request: unknown }>;

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const inAgent = async <A, E>(
  ownerId: string,
  effect: Effect.Effect<A, E, AgentStorage | Conversation | TurnTraces>
) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(effect)
  );

const run = (ownerId: string, statement: string) =>
  inAgent(
    ownerId,
    AgentStorage.pipe(
      Effect.flatMap(({ database }) => database.run(sql.raw(statement))),
      Effect.asVoid
    )
  );

const query = <Row extends object>(ownerId: string, statement: string) =>
  inAgent(
    ownerId,
    AgentStorage.pipe(
      Effect.flatMap(({ database }) => database.all<Row>(sql.raw(statement)))
    )
  );

const modelTracesOf = async (ownerId: string) => {
  const traces = await inAgent(
    ownerId,
    TurnTraces.pipe(Effect.flatMap((stored) => stored.read))
  );
  return traces.flatMap((stored): StoredTurnTrace<ModelTurnTrace>[] =>
    "request" in stored.trace ? [{ ...stored, trace: stored.trace }] : []
  );
};

const waitForModelTraces = (ownerId: string, count: number) =>
  vi.waitFor(
    async () => {
      const traces = await modelTracesOf(ownerId);
      expect(traces).toHaveLength(count);
      return traces;
    },
    { timeout: 10_000 }
  );

const replayOf = (ownerId: string, stored: StoredTurnTrace<ModelTurnTrace>) =>
  inAgent(ownerId, replayTurn(stored.trace));

const replayedRequestOf = (replay: TurnReplay): ReplayedRequest => {
  if (replay._tag !== "Replayed") {
    throw new Error(`The Turn was not replayed: ${JSON.stringify(replay)}`);
  }
  return replay.request;
};

const call = (index: number): ModelCall => {
  const found = fakeModel.doGenerateCalls[index];
  if (found === undefined) {
    throw new Error(`No model call ${index}`);
  }
  return found;
};

const sendAgain = async (request: ReplayedRequest) => {
  await generateText({
    model: fakeModel,
    system: request.system,
    messages: [...request.messages],
    tools: Object.fromEntries(
      request.toolDefinitions.map((definition) => [
        definition.name,
        tool({
          description: definition.description,
          inputSchema: jsonSchema(definition.inputSchema),
        }),
      ])
    ),
  });
  return call(fakeModel.doGenerateCalls.length - 1);
};

const sentBytesOf = (modelCall: ModelCall) =>
  JSON.stringify({ prompt: modelCall.prompt, tools: modelCall.tools });

const ownerSays = async (userId: number, text: string, replies: number) => {
  await telegramWebhook(textUpdate({ fromUserId: userId, text }));
  await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(replies), {
    timeout: 10_000,
  });
};

const daysAgo = (days: number) =>
  DateTime.formatIso(DateTime.subtract(DateTime.nowUnsafe(), { days }));

const runRetention = async (ownerId: string) => {
  await run(ownerId, "DELETE FROM trace_retention_runs");
  await runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.fireDueSchedules()
  );
};

const insertOldTrace = (ownerId: string, eventId: string, days: number) =>
  run(
    ownerId,
    `INSERT INTO turn_traces (owner_id, recorded_at, event_id, result, record) VALUES ('${ownerId}', '${daysAgo(days)}', '${eventId}', 'reminder_delivered', '{"task":"reminder_delivery","scheduleId":"s","dueAt":"2026-01-01T00:00:00.000Z","text":"t","channelMessageId":null,"error":null,"latencyMillis":1}')`
  );

const traceEventIds = async (ownerId: string) => {
  const rows = await query<{ event_id: string }>(
    ownerId,
    "SELECT event_id FROM turn_traces ORDER BY sequence"
  );
  return rows.map((row) => row.event_id);
};

const toolDefinitionVersions = async (ownerId: string) => {
  const rows = await query<{ hash: string }>(
    ownerId,
    "SELECT hash FROM trace_request_parts WHERE kind = 'tool_definitions' AND task = 'reply' ORDER BY hash"
  );
  return rows.map((row) => row.hash);
};

const reply = (text: string, inputTokens: number): ScriptedModelStep => ({
  say: text,
  inputTokens,
});

vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  resetFakes();
});

describe("Trace pointers", () => {
  it("holds the hashes, the row range, and the tail of an Owner message Turn, and no copy of the history", async () => {
    const ownerId = await addOwner(7401);
    await ownerSays(7401, "First words", 1);
    await ownerSays(7401, "Second words", 2);

    const [, second] = await waitForModelTraces(ownerId, 2);
    const request = second?.trace.request;
    expect(request).toMatchObject({
      kind: "pointer",
      systemHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      toolDefinitionsHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      ownerContextHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      conversationRows: {
        summarySequence: null,
        firstSequence: expect.any(Number),
        lastSequence: expect.any(Number),
        hash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
      tail: [
        {
          role: "user",
          content: expect.stringMatching(
            /^\[Turn context\][^]*\nSecond words$/u
          ),
        },
      ],
    });
    const storedText = JSON.stringify(second?.trace);
    expect(storedText).not.toContain("First words");
    expect(storedText).not.toContain("[Owner context]");
    expect(storedText).not.toContain("You are the Owner's Personal Agent");
  });

  it("holds the hashes, no rows, and the run block of a Side Session", async () => {
    const ownerId = await ownerInWarsaw(7402);
    await ownerSays(7402, "Plain chat", 1);
    const agent = await agentOf(ownerId);
    await runInDurableObject(agent, (instance) =>
      instance.runtime.runPromise(
        Effect.gen(function* seedEffect() {
          const schedules = yield* Schedules;
          const now = yield* DateTime.now;
          yield* schedules.set({
            action: { _tag: "RunPrompt", prompt: "List my open tasks" },
            setBy: "owner",
            dueAt: DateTime.subtract(now, { seconds: 5 }),
            sourceEventId: "seed-run-prompt",
          });
        })
      )
    );
    await runInDurableObject(agent, (instance) => instance.fireDueSchedules());

    const traces = await waitForModelTraces(ownerId, 2);
    const sideSession = traces.find(
      (stored) => stored.trace.task === "scheduled_task"
    );
    expect(sideSession?.trace.request).toMatchObject({
      kind: "pointer",
      systemHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      toolDefinitionsHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      ownerContextHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      conversationRows: {
        summarySequence: null,
        firstSequence: null,
        lastSequence: null,
      },
      tail: [
        {
          role: "user",
          content: expect.stringContaining("List my open tasks"),
        },
      ],
    });
    expect(JSON.stringify(sideSession?.trace)).not.toContain("[Owner context]");
    if (sideSession === undefined) {
      throw new Error("No Side Session Trace");
    }
    const replayed = await sendAgain(
      replayedRequestOf(await replayOf(ownerId, sideSession))
    );
    expect(sentBytesOf(replayed)).toBe(
      sentBytesOf(call(fakeModel.doGenerateCalls.length - 2))
    );
  });
});

describe("Replay", () => {
  it("builds the byte-identical request of a Turn after a Compaction, with the tools that it had", async () => {
    const ownerId = await ownerInWarsaw(7403);
    scriptModel([
      reply("First answer", 2000),
      reply("Second answer", 9000),
      reply("Third answer", 20_000),
      reply("Fourth answer", 31_000),
      { say: "They talked about A.", outputTokens: 300 },
    ]);
    const releaseModel = holdModel(4);
    await ownerSays(7403, "first message", 1);
    await ownerSays(7403, "second message", 2);
    await ownerSays(7403, "third message", 3);
    await ownerSays(7403, "fourth message", 4);
    releaseModel();
    await vi.waitFor(
      async () =>
        expect(
          await query(
            ownerId,
            "SELECT 1 FROM conversation_messages WHERE kind = 'summary'"
          )
        ).toHaveLength(1),
      { timeout: 10_000 }
    );
    await ownerSays(7403, "fifth message", 5);

    const traces = await waitForModelTraces(ownerId, 5);
    const [beforeCompaction, afterCompaction] = traces.slice(3);
    if (beforeCompaction === undefined || afterCompaction === undefined) {
      throw new Error("Missing Traces");
    }
    expect(afterCompaction.trace.request).toMatchObject({
      conversationRows: { summarySequence: expect.any(Number) },
    });
    expect(JSON.stringify(afterCompaction.trace)).not.toContain(
      "They talked about A."
    );

    const fourthCall = call(3);
    const fifthCall = call(5);
    expect(
      sentBytesOf(
        await sendAgain(
          replayedRequestOf(await replayOf(ownerId, beforeCompaction))
        )
      )
    ).toBe(sentBytesOf(fourthCall));
    expect(
      sentBytesOf(
        await sendAgain(
          replayedRequestOf(await replayOf(ownerId, afterCompaction))
        )
      )
    ).toBe(sentBytesOf(fifthCall));
  });

  it("uses the stored tool definitions after a tool definition changed", async () => {
    const ownerId = await addOwner(7404);
    await ownerSays(7404, "Before the change", 1);
    fakeTool.description = "Keep one word for the Owner";
    await ownerSays(7404, "After the change", 2);

    const [before, after] = await waitForModelTraces(ownerId, 2);
    if (before === undefined || after === undefined) {
      throw new Error("Missing Traces");
    }
    expect(before.trace.request).not.toMatchObject({
      toolDefinitionsHash:
        after.trace.request.kind === "pointer"
          ? after.trace.request.toolDefinitionsHash
          : "",
    });
    const replayedBefore = replayedRequestOf(await replayOf(ownerId, before));
    expect(
      replayedBefore.toolDefinitions.find(
        (definition) => definition.name === fakeTool.name
      )?.description
    ).toBe("Keep a word");
    expect(sentBytesOf(await sendAgain(replayedBefore))).toBe(
      sentBytesOf(call(0))
    );
  });

  it("reports a stored part that is missing or changed, and does not use the current one", async () => {
    const ownerId = await addOwner(7405);
    await ownerSays(7405, "First words", 1);
    await ownerSays(7405, "Second words", 2);
    const [, second] = await waitForModelTraces(ownerId, 2);
    if (second === undefined) {
      throw new Error("Missing Trace");
    }

    await run(ownerId, "DELETE FROM trace_request_parts WHERE kind = 'system'");
    await run(
      ownerId,
      "UPDATE trace_request_parts SET content = replace(content, 'Keep a word', 'Keep two words') WHERE kind = 'tool_definitions'"
    );
    await run(
      ownerId,
      "UPDATE conversation_messages SET message = replace(message, 'First words', 'Other words')"
    );

    expect(await replayOf(ownerId, second)).toEqual({
      _tag: "PartsDiffer",
      problems: [
        { part: "system", reason: "missing" },
        { part: "tool_definitions", reason: "changed" },
        { part: "conversation_rows", reason: "changed" },
      ],
    });
  });
});

describe("Replay of a changed row or tail", () => {
  it("reports a Conversation row that no longer decodes, and does not fail", async () => {
    const ownerId = await addOwner(7412);
    await ownerSays(7412, "First words", 1);
    await ownerSays(7412, "Second words", 2);
    const [, second] = await waitForModelTraces(ownerId, 2);
    if (second === undefined) {
      throw new Error("Missing Trace");
    }
    await run(
      ownerId,
      "UPDATE conversation_messages SET message = 'not json' WHERE sequence = (SELECT min(sequence) FROM conversation_messages)"
    );

    expect(await replayOf(ownerId, second)).toEqual({
      _tag: "PartsDiffer",
      problems: [{ part: "conversation_rows", reason: "changed" }],
    });
  });

  it("reports a tail that the Redactor changed", async () => {
    const ownerId = await addOwner(7413);
    await ownerSays(7413, `My key ${env.TELEGRAM_BOT_TOKEN}`, 1);
    const [first] = await waitForModelTraces(ownerId, 1);
    if (first === undefined) {
      throw new Error("Missing Trace");
    }

    expect(await replayOf(ownerId, first)).toEqual({
      _tag: "PartsDiffer",
      problems: [{ part: "tail", reason: "changed" }],
    });
  });
});

describe("Retention", () => {
  beforeEach(() => {
    fakeTraceRetention.days = TraceRetentionDaysSchema.make(30);
  });

  it("deletes a Trace older than the Behavior Config value and a row compacted longer ago, on the alarm", async () => {
    const ownerId = await addOwner(7406);
    await ownerSays(7406, "Recent words", 1);
    await waitForModelTraces(ownerId, 1);
    await insertOldTrace(ownerId, "old-trace", 31);
    await insertOldTrace(ownerId, "kept-trace", 29);
    await run(
      ownerId,
      `INSERT INTO conversation_messages (event_id, kind, message, recorded_at, compacted_at) VALUES ('old-row', 'input', '{"role":"user","content":"old"}', '${daysAgo(60)}', '${daysAgo(31)}')`
    );

    const journalBefore = await query(ownerId, "SELECT * FROM journal_entries");

    await runRetention(ownerId);

    expect(await query(ownerId, "SELECT * FROM journal_entries")).toEqual(
      journalBefore
    );
    const eventIds = await traceEventIds(ownerId);
    expect(eventIds).not.toContain("old-trace");
    expect(eventIds).toContain("kept-trace");
    expect(eventIds).toHaveLength(2);
    expect(
      await query(
        ownerId,
        "SELECT 1 FROM conversation_messages WHERE event_id = 'old-row'"
      )
    ).toHaveLength(0);
  });

  it("keeps an old row that was compacted inside the retention period, and a Trace that points to it replays", async () => {
    const ownerId = await addOwner(7407);
    await ownerSays(7407, "Old words", 1);
    await ownerSays(7407, "Newer words", 2);
    const [, second] = await waitForModelTraces(ownerId, 2);
    if (second === undefined) {
      throw new Error("Missing Trace");
    }
    await run(
      ownerId,
      `UPDATE conversation_messages SET recorded_at = '${daysAgo(45)}', compacted_at = '${daysAgo(2)}' WHERE sequence <= (SELECT min(sequence) + 1 FROM conversation_messages)`
    );

    await runRetention(ownerId);

    expect(
      await query(
        ownerId,
        "SELECT 1 FROM conversation_messages WHERE compacted_at IS NOT NULL"
      )
    ).toHaveLength(2);
    expect(
      sentBytesOf(
        await sendAgain(replayedRequestOf(await replayOf(ownerId, second)))
      )
    ).toBe(sentBytesOf(call(1)));
  });

  it("deletes a stored version that no Trace points to, and keeps the current one", async () => {
    const ownerId = await addOwner(7408);
    await ownerSays(7408, "Before the change", 1);
    fakeTool.description = "Keep one word for the Owner";
    await ownerSays(7408, "After the change", 2);
    await waitForModelTraces(ownerId, 2);
    const pointedVersions = await toolDefinitionVersions(ownerId);
    await run(
      ownerId,
      `INSERT INTO trace_request_parts (kind, task, hash, content, last_used_at) VALUES ('tool_definitions', 'reply', 'no-trace', '[]', '${daysAgo(40)}'), ('system', 'proactive', 'current-with-no-trace', 'x', '${daysAgo(40)}')`
    );

    await runRetention(ownerId);

    expect(await toolDefinitionVersions(ownerId)).toEqual(pointedVersions);
    expect(
      await query(
        ownerId,
        "SELECT 1 FROM trace_request_parts WHERE hash = 'current-with-no-trace'"
      )
    ).toHaveLength(1);
  });

  it("arms the alarm for the day when the oldest Trace expires", async () => {
    const ownerId = await addOwner(7409);
    await ownerSays(7409, "Hello", 1);
    const [first] = await waitForModelTraces(ownerId, 1);

    const alarms = await runInDurableObject(
      await agentOf(ownerId),
      async (instance) => {
        const sdkSchedules = await instance.listSchedules();
        return sdkSchedules
          .filter((schedule) => schedule.callback === "fireDueSchedules")
          .map((schedule) => schedule.time);
      }
    );

    if (first === undefined) {
      throw new Error("Missing Trace");
    }
    const expiresAt = DateTime.add(DateTime.makeUnsafe(first.recordedAt), {
      days: 30,
    });
    expect(alarms).toEqual([
      Math.ceil(DateTime.toEpochMillis(expiresAt) / 1000),
    ]);
  });
});

describe("the Trace trigger", () => {
  it("aborts every UPDATE and a DELETE of a Trace newer than the floor", async () => {
    const ownerId = await addOwner(7410);
    await ownerSays(7410, "Hello", 1);
    await waitForModelTraces(ownerId, 1);
    await insertOldTrace(
      ownerId,
      "older-than-floor",
      traceRetentionFloorDays + 1
    );

    await runInDurableObject(await agentOf(ownerId), (_, state) => {
      expect(() =>
        state.storage.sql.exec(
          "UPDATE turn_traces SET result = 'model_replied'"
        )
      ).toThrow("append-only");
      expect(() =>
        state.storage.sql.exec(
          "UPDATE turn_traces SET result = 'model_replied' WHERE event_id = 'older-than-floor'"
        )
      ).toThrow("append-only");
      expect(() => state.storage.sql.exec("DELETE FROM turn_traces")).toThrow(
        "retention floor"
      );
      state.storage.sql.exec(
        "DELETE FROM turn_traces WHERE event_id = 'older-than-floor'"
      );
    });
    expect(await traceEventIds(ownerId)).toHaveLength(1);
  });
});

describe("the retention value", () => {
  it("refuses a Behavior Config value below the floor", () => {
    expect(() =>
      TraceRetentionDaysSchema.make(traceRetentionFloorDays - 1)
    ).toThrow();
    expect(Schema.is(TraceRetentionDaysSchema)(traceRetentionFloorDays)).toBe(
      true
    );
  });
});
