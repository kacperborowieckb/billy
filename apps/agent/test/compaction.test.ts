import {
  abortAllDurableObjects,
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { sql } from "drizzle-orm";
import { DateTime, Effect, Schema } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";
import {
  ModelMessageJsonSchema,
  ModelMessageSchema,
} from "../src/model-gateway/model-message-schema.ts";
import { captureNoteToolName } from "../src/notes/capture-note-tool.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { AgentStorage } from "../src/personal-agent/agent-storage.ts";
import { compactionInstructions } from "../src/personal-agent/compaction-prompt.ts";
import {
  summaryEndLabel,
  summaryLabel,
} from "../src/personal-agent/context-labels.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import type { ScheduleAction } from "../src/schedule/schedule-action.ts";
import { Schedules } from "../src/schedule/schedules.ts";
import {
  failModel,
  fakeMetrics,
  fakeModel,
  fakeTelegram,
  holdModel,
  lastUserTextOf,
  ownerTextsOf,
  resetFakes,
  scriptModel,
  systemTextOf,
} from "./fakes.ts";
import type { ScriptedModelStep } from "./fakes.ts";
import { ownerInWarsaw } from "./owner-with-data.ts";
import { telegramWebhook, textUpdate } from "./telegram-requests.ts";

interface StoredRow {
  readonly sequence: number;
  readonly event_id: string;
  readonly kind: string;
  readonly message: string;
  readonly compacted_at: string | null;
}

type ModelCall = (typeof fakeModel.doGenerateCalls)[number];

const historyOf = (prompt: ModelCall["prompt"]) =>
  prompt.filter((message) => message.role !== "system");

const compactedOrSummaryRows = async (ownerId: string) => {
  const rows = await conversationRows(ownerId);
  return rows.filter(
    (row) => row.kind === "summary" || row.compacted_at !== null
  );
};

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const query = async <Row extends object>(ownerId: string, statement: string) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(
      Effect.gen(function* queryEffect() {
        const { database } = yield* AgentStorage;
        return yield* database.all<Row>(sql.raw(statement));
      })
    )
  );

const conversationRows = (ownerId: string) =>
  query<StoredRow>(
    ownerId,
    "SELECT * FROM conversation_messages ORDER BY sequence"
  );

const compactionUsageRows = (ownerId: string) =>
  query<{ task: string; event_id: string | null }>(
    ownerId,
    "SELECT task, event_id FROM model_usage WHERE task = 'compaction'"
  );

const compactionOutputTokens = async (ownerId: string) => {
  const rows = await query<{ output_tokens: number | null }>(
    ownerId,
    "SELECT output_tokens FROM model_usage WHERE task = 'compaction' ORDER BY sequence"
  );
  return rows.map((row) => row.output_tokens);
};

const refusedBlockRows = (ownerId: string) =>
  query<{ last_compacted_sequence: number }>(
    ownerId,
    "SELECT last_compacted_sequence FROM refused_compaction_blocks"
  );

const decodeStoredMessage = Schema.decodeUnknownSync(ModelMessageJsonSchema);

const textOf = (row: StoredRow) => {
  const { content } = decodeStoredMessage(row.message);
  return typeof content === "string" ? content : JSON.stringify(content);
};

const ownerSays = async (userId: number, text: string, replies: number) => {
  await telegramWebhook(textUpdate({ fromUserId: userId, text }));
  await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(replies), {
    timeout: 10_000,
  });
};

const reply = (text: string, inputTokens: number): ScriptedModelStep => ({
  say: text,
  inputTokens,
});

const summary = (text: string, outputTokens = 300): ScriptedModelStep => ({
  say: text,
  outputTokens,
});

const firstSummaryTarget = Math.floor(
  defaultBehaviorConfig.maxSummaryTokens * 0.6
);
const retrySummaryTarget = Math.floor(
  defaultBehaviorConfig.maxSummaryTokens * 0.3
);

const overLimitSummary = summary(
  "A very long Summary.",
  defaultBehaviorConfig.maxSummaryTokens + 1
);

const fourTurnsOverTheLimit = [
  reply("First answer", 2000),
  reply("Second answer", 9000),
  reply("Third answer", 20_000),
  reply("Fourth answer", 31_000),
];

const chatThreeTurns = async (userId: number) => {
  await ownerSays(userId, "first message", 1);
  await ownerSays(userId, "second message", 2);
  await ownerSays(userId, "third message", 3);
};

const chatFourTurns = async (userId: number) => {
  await chatThreeTurns(userId);
  await ownerSays(userId, "fourth message", 4);
};

const waitForSummaries = (ownerId: string, count: number) =>
  vi.waitFor(
    async () => {
      const rows = await conversationRows(ownerId);
      expect(rows.filter((row) => row.kind === "summary")).toHaveLength(count);
      return rows;
    },
    { timeout: 10_000 }
  );

const call = (index: number): ModelCall => {
  const found = fakeModel.doGenerateCalls[index];
  if (found === undefined) {
    throw new Error(`No model call ${index}`);
  }
  return found;
};

const decodeCompactionData = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      summaryTarget: Schema.Number,
      earlierSummary: Schema.NullOr(Schema.String),
      chat: Schema.Array(ModelMessageSchema),
    })
  )
);

const compactionDataOf = (compactionCall: ModelCall) =>
  decodeCompactionData(ownerTextsOf(compactionCall.prompt).join(""));

const fireOwnerSchedule = async (ownerId: string, action: ScheduleAction) => {
  const agent = await agentOf(ownerId);
  await runInDurableObject(agent, (instance) =>
    instance.runtime.runPromise(
      Effect.gen(function* seedEffect() {
        const schedules = yield* Schedules;
        const now = yield* DateTime.now;
        yield* schedules.set({
          action,
          setBy: "owner",
          dueAt: DateTime.subtract(now, { seconds: 5 }),
          sourceEventId: `seed-${action._tag}`,
        });
      })
    )
  );
  await runInDurableObject(agent, (instance) => instance.fireDueSchedules());
};

const waitForCurrentSummary = (ownerId: string, text: string) =>
  vi.waitFor(
    async () => {
      const rows = await conversationRows(ownerId);
      expect(
        rows
          .filter((row) => row.kind === "summary" && row.compacted_at === null)
          .map(textOf)
      ).toEqual([`${summaryLabel}\n${text}\n${summaryEndLabel}`]);
    },
    { timeout: 10_000 }
  );

const waitForModelCalls = (count: number) =>
  vi.waitFor(() => expect(fakeModel.doGenerateCalls).toHaveLength(count), {
    timeout: 10_000,
  });

beforeEach(() => {
  resetFakes();
});

describe("Compaction", () => {
  it("replaces the oldest Turns with one Summary after the Delivery of the Turn that passed the limit", async () => {
    const ownerId = await ownerInWarsaw(8801);
    scriptModel([...fourTurnsOverTheLimit, summary("They talked about A.")]);
    const releaseModel = holdModel(4);

    await chatFourTurns(8801);
    await waitForModelCalls(5);
    expect(fakeTelegram.sent).toHaveLength(4);
    expect(await conversationRows(ownerId)).not.toContainEqual(
      expect.objectContaining({ kind: "summary" })
    );
    releaseModel();
    const rows = await waitForSummaries(ownerId, 1);

    const compactionCall = call(4);
    expect(systemTextOf(compactionCall.prompt)).toBe(compactionInstructions);
    expect(compactionCall.tools ?? []).toEqual([]);
    expect(compactionCall.maxOutputTokens).toBe(
      defaultBehaviorConfig.maxSummaryTokens
    );
    const data = compactionDataOf(compactionCall);
    expect(data.summaryTarget).toBe(firstSummaryTarget);
    expect(data.earlierSummary).toBeNull();
    expect(JSON.stringify(data.chat)).toContain("first message");
    expect(JSON.stringify(data.chat)).toContain("Third answer");
    expect(JSON.stringify(data.chat)).not.toContain("fourth message");

    const compacted = rows.filter((row) => row.compacted_at !== null);
    const kept = rows.filter(
      (row) => row.compacted_at === null && row.kind !== "summary"
    );
    expect(compacted.map(textOf).join("\n")).toContain("first message");
    expect(compacted.map(textOf).join("\n")).toContain("Third answer");
    expect(kept.map(textOf).join("\n")).toContain("fourth message");
    expect(kept.map(textOf)).toContain("Fourth answer");
    const summaryRow = rows.find((row) => row.kind === "summary");
    expect(summaryRow === undefined ? "" : textOf(summaryRow)).toBe(
      `${summaryLabel}\nThey talked about A.\n${summaryEndLabel}`
    );
    expect(await compactionUsageRows(ownerId)).toEqual([
      { task: "compaction", event_id: summaryRow?.event_id },
    ]);
  });

  it("sends no compacted row in a later request, and keeps the newest part word for word after the Summary", async () => {
    const ownerId = await ownerInWarsaw(8802);
    scriptModel([...fourTurnsOverTheLimit, summary("They talked about A.")]);
    await chatFourTurns(8802);
    const rows = await waitForSummaries(ownerId, 1);
    const fourthTurnRequest = call(3).prompt;

    await ownerSays(8802, "fifth message", 5);
    const laterRequest = call(5).prompt;

    const laterTexts = ownerTextsOf(laterRequest);
    expect(laterTexts.join("\n")).not.toContain("first message");
    expect(laterTexts.join("\n")).not.toContain("third message");
    const fourthInput = historyOf(fourthTurnRequest).at(-1);
    expect(JSON.stringify(historyOf(laterRequest).slice(1))).toBe(
      JSON.stringify([
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `${summaryLabel}\nThey talked about A.\n${summaryEndLabel}`,
            },
          ],
        },
        fourthInput,
        {
          role: "assistant",
          content: [{ type: "text", text: "Fourth answer" }],
        },
        historyOf(laterRequest).at(-1),
      ])
    );
    expect(
      rows.filter((row) => row.compacted_at === null).map((row) => row.kind)
    ).toEqual(["input", "reply", "summary"]);
  });

  it("writes one new Summary from the old Summary and the new block", async () => {
    const ownerId = await ownerInWarsaw(8803);
    scriptModel([
      ...fourTurnsOverTheLimit,
      summary("They talked about A."),
      reply("Fifth answer", 32_000),
      summary("They talked about A and B."),
    ]);
    await chatFourTurns(8803);
    await waitForSummaries(ownerId, 1);
    await ownerSays(8803, "fifth message", 5);

    const rows = await vi.waitFor(
      async () => {
        const stored = await conversationRows(ownerId);
        expect(
          stored.filter((row) => row.kind === "summary" && row.compacted_at)
        ).toHaveLength(1);
        return stored;
      },
      { timeout: 10_000 }
    );

    const data = compactionDataOf(call(6));
    expect(data.earlierSummary).toBe(
      `${summaryLabel}\nThey talked about A.\n${summaryEndLabel}`
    );
    expect(JSON.stringify(data.chat)).toContain("fourth message");
    expect(JSON.stringify(data.chat)).not.toContain("third message");
    expect(JSON.stringify(data.chat)).not.toContain("fifth message");
    const current = rows.filter((row) => row.compacted_at === null);
    expect(current.filter((row) => row.kind === "summary").map(textOf)).toEqual(
      [`${summaryLabel}\nThey talked about A and B.\n${summaryEndLabel}`]
    );
    expect(current.map(textOf).join("\n")).toContain("fifth message");
    expect(current.map(textOf).join("\n")).not.toContain("fourth message");
  });

  it("replaces a Summary that reached the size limit with a shorter one that is over the target", async () => {
    const ownerId = await ownerInWarsaw(8816);
    scriptModel([
      ...fourTurnsOverTheLimit,
      summary("They talked about A.", defaultBehaviorConfig.maxSummaryTokens),
      reply("Fifth answer", 32_000),
      summary("A and B.", firstSummaryTarget + 300),
    ]);
    await chatFourTurns(8816);
    await waitForCurrentSummary(ownerId, "They talked about A.");
    await ownerSays(8816, "fifth message", 5);
    await waitForCurrentSummary(ownerId, "A and B.");

    expect(systemTextOf(call(6).prompt)).toBe(compactionInstructions);
    expect(compactionDataOf(call(6)).summaryTarget).toBe(firstSummaryTarget);
    expect(compactionDataOf(call(6)).earlierSummary).toBe(
      `${summaryLabel}\nThey talked about A.\n${summaryEndLabel}`
    );
    expect(await compactionOutputTokens(ownerId)).toEqual([
      defaultBehaviorConfig.maxSummaryTokens,
      firstSummaryTarget + 300,
    ]);
    expect(await refusedBlockRows(ownerId)).toEqual([]);
  });

  it("keeps compacting each new block after a Summary at the size limit, also when the first attempt is cut", async () => {
    const ownerId = await ownerInWarsaw(8817);
    scriptModel([
      ...fourTurnsOverTheLimit,
      summary("They talked about A.", defaultBehaviorConfig.maxSummaryTokens),
      reply("Fifth answer", 32_000),
      overLimitSummary,
      summary("A and B.", retrySummaryTarget + 700),
      reply("Sixth answer", 32_000),
      summary("A, B, and C.", defaultBehaviorConfig.maxSummaryTokens),
    ]);
    await chatFourTurns(8817);
    await waitForCurrentSummary(ownerId, "They talked about A.");
    await ownerSays(8817, "fifth message", 5);
    await waitForCurrentSummary(ownerId, "A and B.");
    await ownerSays(8817, "sixth message", 6);
    await waitForCurrentSummary(ownerId, "A, B, and C.");

    expect(
      [call(6), call(7), call(9)].map((compactionCall) =>
        systemTextOf(compactionCall.prompt)
      )
    ).toEqual([
      compactionInstructions,
      compactionInstructions,
      compactionInstructions,
    ]);
    expect(
      [call(6), call(7), call(9)].map(
        (compactionCall) => compactionDataOf(compactionCall).summaryTarget
      )
    ).toEqual([firstSummaryTarget, retrySummaryTarget, firstSummaryTarget]);
    expect(
      fakeMetrics.modelStepDataPoints
        .filter((point) => point.blobs?.[5] === "compaction")
        .map((point) => point.blobs?.[1])
    ).toEqual(["no_earlier_call", "none", "none", "none"]);
    expect(compactionDataOf(call(9)).earlierSummary).toBe(
      `${summaryLabel}\nA and B.\n${summaryEndLabel}`
    );
    expect(await compactionOutputTokens(ownerId)).toEqual([
      defaultBehaviorConfig.maxSummaryTokens,
      defaultBehaviorConfig.maxSummaryTokens,
      retrySummaryTarget + 700,
      defaultBehaviorConfig.maxSummaryTokens,
    ]);
    expect(await refusedBlockRows(ownerId)).toEqual([]);
  });

  it("stops when an Owner Burst becomes due, writes nothing, answers the Turn first, records the Usage of the stopped call, and runs again at the next check", async () => {
    const ownerId = await ownerInWarsaw(8804);
    scriptModel([
      ...fourTurnsOverTheLimit,
      summary("A stopped Summary.", 555),
      reply("Fifth answer", 33_000),
      summary("They talked about A."),
    ]);
    await chatThreeTurns(8804);
    const releaseModel = holdModel(4);
    await ownerSays(8804, "fourth message", 4);
    await waitForModelCalls(5);

    await telegramWebhook(
      textUpdate({ fromUserId: 8804, text: "fifth message" })
    );
    await waitForModelCalls(6);
    const rowsAfterStop = await conversationRows(ownerId);
    const usageAfterStop = await compactionUsageRows(ownerId);
    releaseModel();
    const usage = await vi.waitFor(
      async () => {
        const rows = await compactionUsageRows(ownerId);
        expect(rows).toHaveLength(2);
        return rows;
      },
      { timeout: 10_000 }
    );
    const rows = await waitForSummaries(ownerId, 1);

    expect(rowsAfterStop.filter((row) => row.kind === "summary")).toEqual([]);
    expect(rowsAfterStop.filter((row) => row.compacted_at !== null)).toEqual(
      []
    );
    expect(usageAfterStop).toEqual([]);
    expect(fakeTelegram.sent.at(-1)?.body.text).toBe("Fifth answer");
    expect(ownerTextsOf(call(5).prompt).at(-1)).toBe("fifth message");
    expect(call(4).abortSignal?.aborted).not.toBe(true);
    expect(await compactionOutputTokens(ownerId)).toEqual([555, 300]);
    expect(new Set(usage.map((row) => row.event_id)).size).toBe(2);
    expect(
      fakeMetrics.modelStepDataPoints.filter(
        (point) => point.blobs?.[5] === "compaction"
      )
    ).toHaveLength(2);
    expect(rows.filter((row) => row.kind === "summary").map(textOf)).toEqual([
      `${summaryLabel}\nThey talked about A.\n${summaryEndLabel}`,
    ]);
  });

  it("writes nothing after a failed model call, and runs again at the next check", async () => {
    const ownerId = await ownerInWarsaw(8805);
    scriptModel([
      ...fourTurnsOverTheLimit,
      reply("Fifth answer", 33_000),
      summary("They talked about A."),
    ]);
    await chatThreeTurns(8805);
    const releaseModel = holdModel(4);
    await ownerSays(8805, "fourth message", 4);
    await waitForModelCalls(5);
    failModel(3);
    releaseModel();
    await vi.waitFor(() => expect(fakeModel.doGenerateCalls).toHaveLength(7), {
      timeout: 20_000,
    });
    await vi.waitFor(async () =>
      expect(await conversationRows(ownerId)).toHaveLength(8)
    );
    expect(await compactedOrSummaryRows(ownerId)).toEqual([]);

    await ownerSays(8805, "fifth message", 5);
    await waitForSummaries(ownerId, 1);
  }, 30_000);

  it("asks again for a shorter Summary when the first one is over the size limit, and writes the second one", async () => {
    const ownerId = await ownerInWarsaw(8806);
    scriptModel([
      ...fourTurnsOverTheLimit,
      overLimitSummary,
      summary("They talked about A."),
    ]);
    await chatFourTurns(8806);
    const rows = await waitForSummaries(ownerId, 1);

    expect(systemTextOf(call(4).prompt)).toBe(compactionInstructions);
    expect(systemTextOf(call(5).prompt)).toBe(compactionInstructions);
    expect(call(5).maxOutputTokens).toBe(
      defaultBehaviorConfig.maxSummaryTokens
    );
    expect(compactionDataOf(call(4)).summaryTarget).toBe(firstSummaryTarget);
    expect(compactionDataOf(call(5))).toEqual({
      ...compactionDataOf(call(4)),
      summaryTarget: retrySummaryTarget,
    });
    const summaryRow = rows.find((row) => row.kind === "summary");
    expect(summaryRow === undefined ? "" : textOf(summaryRow)).toBe(
      `${summaryLabel}\nThey talked about A.\n${summaryEndLabel}`
    );
    expect(await compactionUsageRows(ownerId)).toEqual([
      { task: "compaction", event_id: summaryRow?.event_id },
      { task: "compaction", event_id: summaryRow?.event_id },
    ]);
  });

  it("refuses a Summary over the size limit twice, makes no call for the same block again, and compacts when the block changes", async () => {
    const ownerId = await ownerInWarsaw(8813);
    scriptModel([
      reply("First answer", 2000),
      reply("Second answer", 9000),
      reply("Third answer", 25_000),
      reply("Fourth answer", 31_000),
      overLimitSummary,
      overLimitSummary,
      reply("Fifth answer", 32_000),
      reply("Sixth answer", 40_000),
      summary("They talked about A and B."),
    ]);
    await chatFourTurns(8813);
    await vi.waitFor(
      async () =>
        expect(await refusedBlockRows(ownerId)).toEqual([
          { last_compacted_sequence: expect.any(Number) },
        ]),
      { timeout: 10_000 }
    );
    expect(await compactedOrSummaryRows(ownerId)).toEqual([]);

    await ownerSays(8813, "fifth message", 5);
    await ownerSays(8813, "sixth message", 6);
    const rows = await waitForSummaries(ownerId, 1);

    expect(fakeModel.doGenerateCalls).toHaveLength(9);
    expect(lastUserTextOf(call(6).prompt)).toContain("fifth message");
    expect(lastUserTextOf(call(7).prompt)).toContain("sixth message");
    expect(await compactionUsageRows(ownerId)).toHaveLength(3);
    const data = compactionDataOf(call(8));
    expect(JSON.stringify(data.chat)).toContain("fifth message");
    expect(JSON.stringify(data.chat)).not.toContain("sixth message");
    expect(rows.filter((row) => row.kind === "summary").map(textOf)).toEqual([
      `${summaryLabel}\nThey talked about A and B.\n${summaryEndLabel}`,
    ]);
  });

  it("makes no call for a block that ends before a refused block, after the history total falls", async () => {
    const ownerId = await ownerInWarsaw(8815);
    scriptModel([
      reply("First answer", 2000),
      reply("Second answer", 23_000),
      reply("Third answer", 24_000),
      reply("Fourth answer", 30_000),
      reply("Fifth answer", 40_000),
      overLimitSummary,
      overLimitSummary,
      reply("Sixth answer", 31_500),
      reply("Seventh answer", 31_600),
    ]);
    await chatFourTurns(8815);
    await ownerSays(8815, "fifth message", 5);
    await vi.waitFor(
      async () => expect(await refusedBlockRows(ownerId)).toHaveLength(1),
      { timeout: 10_000 }
    );
    const refusedAtFifth = await refusedBlockRows(ownerId);
    expect(JSON.stringify(compactionDataOf(call(5)).chat)).toContain(
      "fourth message"
    );

    await ownerSays(8815, "sixth message", 6);
    await ownerSays(8815, "seventh message", 7);

    expect(fakeModel.doGenerateCalls).toHaveLength(9);
    expect(ownerTextsOf(call(8).prompt).at(-1)).toBe("seventh message");
    expect(await compactionUsageRows(ownerId)).toHaveLength(2);
    expect(await refusedBlockRows(ownerId)).toEqual(refusedAtFifth);
    expect(await compactedOrSummaryRows(ownerId)).toEqual([]);
  });

  it("records no refusal when an Owner Burst stops the second Summary call", async () => {
    const ownerId = await ownerInWarsaw(8814);
    scriptModel([
      ...fourTurnsOverTheLimit,
      overLimitSummary,
      summary("A stopped Summary."),
      reply("Fifth answer", 33_000),
      summary("They talked about A."),
    ]);
    await chatThreeTurns(8814);
    const releaseModel = holdModel(5);
    await ownerSays(8814, "fourth message", 4);
    await waitForModelCalls(6);

    await telegramWebhook(
      textUpdate({ fromUserId: 8814, text: "fifth message" })
    );
    await waitForModelCalls(7);
    const refusedAfterStop = await refusedBlockRows(ownerId);
    releaseModel();
    await waitForSummaries(ownerId, 1);

    expect(refusedAfterStop).toEqual([]);
    expect(await refusedBlockRows(ownerId)).toEqual([]);
    expect(systemTextOf(call(5).prompt)).toBe(compactionInstructions);
    expect(compactionDataOf(call(5)).summaryTarget).toBe(retrySummaryTarget);
    expect(ownerTextsOf(call(6).prompt).at(-1)).toBe("fifth message");
  });

  it("writes nothing after a reset during the call, and runs again at the next check", async () => {
    const ownerId = await ownerInWarsaw(8807);
    scriptModel([...fourTurnsOverTheLimit, summary("They talked about A.")]);
    await chatThreeTurns(8807);
    const releaseModel = holdModel(4);
    await ownerSays(8807, "fourth message", 4);
    await waitForModelCalls(5);

    await abortAllDurableObjects();
    const rowsAfterReset = await conversationRows(ownerId);
    releaseModel();
    await runDurableObjectAlarm(await agentOf(ownerId));
    const rows = await waitForSummaries(ownerId, 1);

    expect(
      rowsAfterReset.filter(
        (row) => row.kind === "summary" || row.compacted_at !== null
      )
    ).toEqual([]);
    expect(rows.filter((row) => row.kind === "summary").map(textOf)).toEqual([
      `${summaryLabel}\nThey talked about A.\n${summaryEndLabel}`,
    ]);
  });

  it("counts the first message of a Turn in the newest part that it keeps", async () => {
    const ownerId = await ownerInWarsaw(8809);
    scriptModel([
      reply("First answer", 2000),
      reply("Second answer", 4000),
      reply("Third answer", 25_000),
      reply("Fourth answer", 31_000),
      summary("They talked about A."),
    ]);
    await chatFourTurns(8809);
    const rows = await waitForSummaries(ownerId, 1);

    const compacted = rows.filter((row) => row.compacted_at !== null);
    expect(compacted.map(textOf).join("\n")).toContain("third message");
    expect(compacted.map(textOf).join("\n")).not.toContain("fourth message");
  });

  it("measures the kept part on the stored history, not on the tool results that a Turn saw in full", async () => {
    const ownerId = await ownerInWarsaw(8811);
    scriptModel([
      reply("First answer", 2000),
      { callTool: captureNoteToolName, input: { text: "Buy milk" } },
      reply("Kept.", 25_000),
      reply("Third answer", 4000),
      reply("Fourth answer", 31_000),
      summary("They talked about A."),
    ]);
    await chatFourTurns(8811);
    const rows = await waitForSummaries(ownerId, 1);

    const compacted = rows.filter((row) => row.compacted_at !== null);
    expect(compacted.map(textOf).join("\n")).toContain("third message");
    expect(compacted.map(textOf).join("\n")).not.toContain("fourth message");
  });

  it("does not measure a Turn whose first step reported no input tokens", async () => {
    const ownerId = await ownerInWarsaw(8812);
    scriptModel([
      reply("First answer", 2000),
      {
        callTool: captureNoteToolName,
        input: { text: "Buy milk" },
        inputTokens: "unreported",
      },
      reply("Kept.", 25_000),
      reply("Third answer", 4000),
      reply("Fourth answer", 31_000),
      summary("They talked about A."),
    ]);
    await chatFourTurns(8812);
    const rows = await waitForSummaries(ownerId, 1);

    const compacted = rows.filter((row) => row.compacted_at !== null);
    expect(compacted.map(textOf).join("\n")).toContain("third message");
    expect(compacted.map(textOf).join("\n")).not.toContain("fourth message");
  });

  it("compacts a Write-back before the cut with its block, and a later Side Session reads no compacted text", async () => {
    const ownerId = await ownerInWarsaw(8810);
    scriptModel([...fourTurnsOverTheLimit, summary("They talked about A.")]);
    await ownerSays(8810, "first message", 1);
    await ownerSays(8810, "second message", 2);
    await fireOwnerSchedule(ownerId, {
      _tag: "SendText",
      text: "Water the plants",
    });
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(3), {
      timeout: 10_000,
    });
    await ownerSays(8810, "third message", 4);
    await ownerSays(8810, "fourth message", 5);
    const rows = await waitForSummaries(ownerId, 1);

    const writeBack = rows.find((row) => row.kind === "write_back");
    expect(writeBack === undefined ? "" : textOf(writeBack)).toContain(
      "Water the plants"
    );
    expect(writeBack?.compacted_at).not.toBeNull();

    await fireOwnerSchedule(ownerId, {
      _tag: "RunPrompt",
      prompt: "List my open tasks",
    });
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(6), {
      timeout: 10_000,
    });
    const runBlock = lastUserTextOf(
      call(fakeModel.doGenerateCalls.length - 1).prompt
    );
    expect(runBlock).toContain("fourth message");
    expect(runBlock).not.toContain("first message");
    expect(runBlock).not.toContain("Water the plants");
  });

  it("never puts a running Turn in a block", async () => {
    const ownerId = await ownerInWarsaw(8808);
    scriptModel([...fourTurnsOverTheLimit, summary("They talked about A.")]);
    await chatFourTurns(8808);
    const rows = await waitForSummaries(ownerId, 1);
    const doneEvents = await query<{ event_id: string }>(
      ownerId,
      "SELECT event_id FROM inbox_events WHERE state = 'done'"
    );

    const compactedEvents = new Set(
      rows.filter((row) => row.compacted_at !== null).map((row) => row.event_id)
    );
    expect(compactedEvents.size).toBe(3);
    expect(
      [...compactedEvents].every((eventId) =>
        doneEvents.some((event) => event.event_id === eventId)
      )
    ).toBe(true);
  });
});
