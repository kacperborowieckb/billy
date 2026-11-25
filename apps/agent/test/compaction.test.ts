import {
  abortAllDurableObjects,
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { sql } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";
import {
  ModelMessageJsonSchema,
  ModelMessageSchema,
} from "../src/model-gateway/model-message-schema.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { AgentStorage } from "../src/personal-agent/agent-storage.ts";
import { compactionInstructions } from "../src/personal-agent/compaction-prompt.ts";
import {
  summaryEndLabel,
  summaryLabel,
} from "../src/personal-agent/context-labels.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import {
  failModel,
  fakeModel,
  fakeTelegram,
  holdModel,
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
      earlierSummary: Schema.NullOr(Schema.String),
      chat: Schema.Array(ModelMessageSchema),
    })
  )
);

const compactionDataOf = (compactionCall: ModelCall) =>
  decodeCompactionData(ownerTextsOf(compactionCall.prompt).join(""));

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
    expect(systemTextOf(compactionCall.prompt)).toBe(
      compactionInstructions(defaultBehaviorConfig.maxSummaryTokens)
    );
    expect(compactionCall.tools ?? []).toEqual([]);
    const data = compactionDataOf(compactionCall);
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

  it("stops when an Owner Burst becomes due, writes nothing, answers the Turn first, and runs again at the next check", async () => {
    const ownerId = await ownerInWarsaw(8804);
    scriptModel([
      ...fourTurnsOverTheLimit,
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
    releaseModel();
    await waitForSummaries(ownerId, 1);

    expect(rowsAfterStop.filter((row) => row.kind === "summary")).toEqual([]);
    expect(rowsAfterStop.filter((row) => row.compacted_at !== null)).toEqual(
      []
    );
    expect(fakeTelegram.sent.at(-1)?.body.text).toBe("Fifth answer");
    expect(ownerTextsOf(call(5).prompt).at(-1)).toBe("fifth message");
    expect(await compactionUsageRows(ownerId)).toHaveLength(1);
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

  it("refuses a Summary above the size limit", async () => {
    const ownerId = await ownerInWarsaw(8806);
    scriptModel([
      ...fourTurnsOverTheLimit,
      summary(
        "A very long Summary.",
        defaultBehaviorConfig.maxSummaryTokens + 1
      ),
    ]);
    await chatFourTurns(8806);
    await waitForModelCalls(5);

    await vi.waitFor(async () =>
      expect(await compactionUsageRows(ownerId)).toHaveLength(1)
    );
    expect(await compactedOrSummaryRows(ownerId)).toEqual([]);
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
