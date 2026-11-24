import { modelMessageSchema } from "ai";
import type { ModelMessage } from "ai";
import { env, runInDurableObject } from "cloudflare:test";
import { sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";
import { Journal } from "../src/journal/journal.ts";
import { UsageLedger } from "../src/model-gateway/usage-ledger.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { AgentStorage } from "../src/personal-agent/agent-storage.ts";
import type { AgentMigrations } from "../src/personal-agent/agent-storage.ts";
import { Conversation } from "../src/personal-agent/conversation.ts";
import { honestFailureText } from "../src/personal-agent/delivery.ts";
import { Inbox } from "../src/personal-agent/inbox.ts";
import personalAgentMigrations from "../src/personal-agent/migrations/migrations.js";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import {
  replied,
  storeFinishedTurn,
} from "../src/personal-agent/stored-turn.ts";
import { TurnProgress } from "../src/personal-agent/turn-progress.ts";
import { Redactor, redactedMark } from "../src/tracing/redactor.ts";
import { TurnTraces } from "../src/tracing/turn-trace.ts";
import {
  fakeMetrics,
  fakeModel,
  fakeTelegram,
  fakeTool,
  resetFakes,
  scriptModel,
} from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

const inPersonalAgent = async <A, E>(
  ownerId: string,
  effect: Effect.Effect<
    A,
    E,
    Journal | TurnTraces | UsageLedger | Conversation | Inbox | TurnProgress
  >
) =>
  runInDurableObject(
    await personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId)),
    (instance) => instance.runtime.runPromise(effect)
  );

const waitForReplies = (count: number) =>
  vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(count), {
    timeout: 10_000,
  });

const tracesOf = (ownerId: string) =>
  inPersonalAgent(
    ownerId,
    TurnTraces.pipe(Effect.flatMap((traces) => traces.readReplies))
  );

const keepWord = (word: string) =>
  ({ callTool: fakeTool.name, input: { word } }) as const;

const promptPartTypes = (callIndex: number) =>
  fakeModel.doGenerateCalls[callIndex]?.prompt.flatMap((message) =>
    typeof message.content === "string"
      ? []
      : message.content.map((part) => part.type)
  );

beforeEach(() => {
  resetFakes();
});

describe("Tool loop", () => {
  it("runs the tool, shows its result to the model, and sends one reply", async () => {
    const ownerId = await addOwner(9001);
    scriptModel([keepWord("red"), { say: "Kept red" }]);

    await telegramWebhook(textUpdate({ fromUserId: 9001, text: "keep red" }));
    await waitForReplies(1);

    expect(fakeTool.kept).toEqual(["red"]);
    expect(fakeTelegram.sent.map((sent) => sent.body.text)).toEqual([
      "Kept red",
    ]);
    expect(fakeModel.doGenerateCalls).toHaveLength(2);
    expect(promptPartTypes(1)).toContain("tool-result");
    const [stored] = await tracesOf(ownerId);
    expect(stored?.trace.result).toBe("model_replied");
    expect(stored?.trace.steps).toHaveLength(2);
    expect(stored?.trace.steps[0]?.toolCalls).toEqual([
      {
        callId: expect.any(String),
        name: fakeTool.name,
        input: JSON.stringify({ word: "red" }),
        output: JSON.stringify({ kept: "red" }),
        failed: false,
      },
    ]);
    expect(stored?.trace.usage.inputTokens).toBe(84);
  });

  it("puts the tool call and the tool result in the prompt of the next Turn", async () => {
    await addOwner(9002);
    scriptModel([keepWord("red"), { say: "Kept red" }]);
    await telegramWebhook(
      textUpdate({ fromUserId: 9002, text: "keep red", messageId: 1 })
    );
    await waitForReplies(1);

    await telegramWebhook(
      textUpdate({ fromUserId: 9002, text: "and blue", messageId: 2 })
    );
    await waitForReplies(2);

    expect(promptPartTypes(2)).toEqual(
      expect.arrayContaining(["tool-call", "tool-result"])
    );
  });

  it("does not run a tool again when the model call after it is retried", async () => {
    await addOwner(9007);
    scriptModel([
      keepWord("red"),
      { error: "The model provider is down" },
      { say: "Kept red" },
    ]);

    await telegramWebhook(textUpdate({ fromUserId: 9007, text: "keep red" }));
    await waitForReplies(1);

    expect(fakeTool.kept).toEqual(["red"]);
    expect(fakeTelegram.sent[0]?.body.text).toBe("Kept red");
  });

  it("remembers in the next Turn a tool that ran in a Turn that failed", async () => {
    const ownerId = await addOwner(9008);
    scriptModel(
      Array.from({ length: defaultBehaviorConfig.maxToolSteps + 4 }, () =>
        keepWord("loop")
      )
    );
    await telegramWebhook(
      textUpdate({ fromUserId: 9008, text: "keep", messageId: 1 })
    );
    await waitForReplies(1);
    resetFakes();

    await telegramWebhook(
      textUpdate({ fromUserId: 9008, text: "again", messageId: 2 })
    );
    await waitForReplies(1);

    expect(promptPartTypes(0)).toEqual(
      expect.arrayContaining(["tool-call", "tool-result"])
    );
    const [first] = await tracesOf(ownerId);
    expect(first?.trace.steps[0]?.toolCalls[0]?.callId).toEqual(
      expect.any(String)
    );
  });

  it("remembers in the next Turn a tool that ran in a Turn whose send failed", async () => {
    await addOwner(9009);
    scriptModel([keepWord("red"), { say: "Kept red" }]);
    fakeTelegram.answerWith("refuse");
    await telegramWebhook(
      textUpdate({ fromUserId: 9009, text: "keep red", messageId: 1 })
    );
    await waitForReplies(1);
    resetFakes();

    await telegramWebhook(
      textUpdate({ fromUserId: 9009, text: "again", messageId: 2 })
    );
    await waitForReplies(1);

    expect(promptPartTypes(0)).toEqual(
      expect.arrayContaining(["tool-call", "tool-result"])
    );
  });

  it("gives a tool error to the model as a result and finishes the Turn", async () => {
    const ownerId = await addOwner(9003);
    fakeTool.failWith = "The Note store is full";
    scriptModel([keepWord("red"), { say: "I could not keep it" }]);

    await telegramWebhook(textUpdate({ fromUserId: 9003, text: "keep red" }));
    await waitForReplies(1);

    expect(fakeTelegram.sent[0]?.body.text).toBe("I could not keep it");
    expect(JSON.stringify(fakeModel.doGenerateCalls[1]?.prompt)).toContain(
      "The Note store is full"
    );
    const [stored] = await tracesOf(ownerId);
    expect(stored?.trace.result).toBe("model_replied");
    expect(stored?.trace.steps[0]?.toolCalls[0]).toMatchObject({
      output: "The Note store is full",
      failed: true,
    });
  });

  it("sends the honest failure and records a failed Turn at the step limit", async () => {
    const ownerId = await addOwner(9004);
    scriptModel(
      Array.from({ length: defaultBehaviorConfig.maxToolSteps + 4 }, () =>
        keepWord("loop")
      )
    );

    await telegramWebhook(textUpdate({ fromUserId: 9004, text: "keep" }));
    await waitForReplies(1);

    expect(fakeTelegram.sent[0]?.body.text).toBe(honestFailureText);
    expect(fakeModel.doGenerateCalls).toHaveLength(
      defaultBehaviorConfig.maxToolSteps
    );
    const [stored] = await tracesOf(ownerId);
    expect(stored?.trace.result).toBe("model_failed");
    expect(stored?.trace.error).toContain("did not give a final answer");
    expect(stored?.trace.usage.inputTokens).toBe(
      42 * defaultBehaviorConfig.maxToolSteps
    );
    const metric = fakeMetrics.dataPoints.find((candidate) =>
      candidate.blobs?.includes("model_failed")
    );
    expect(metric?.doubles?.slice(1, 3)).toEqual([
      42 * defaultBehaviorConfig.maxToolSteps,
      7 * defaultBehaviorConfig.maxToolSteps,
    ]);
    expect(stored?.trace.steps).toHaveLength(
      defaultBehaviorConfig.maxToolSteps
    );
    const journal = await inPersonalAgent(
      ownerId,
      Journal.pipe(Effect.flatMap((entries) => entries.read))
    );
    expect(journal.map((entry) => entry.record._tag)).toContain("TurnFailed");
    const usage = await inPersonalAgent(
      ownerId,
      UsageLedger.pipe(Effect.flatMap((ledger) => ledger.read))
    );
    expect(usage).toHaveLength(defaultBehaviorConfig.maxToolSteps);
  });

  it("sends the honest failure without a model call when the steps of the Event are already used", async () => {
    const ownerId = await addOwner(9010);
    scriptModel([{ say: "never sent" }]);
    const agent = await personalAgentFor(
      env.PERSONAL_AGENT,
      OwnerIdSchema.make(ownerId)
    );
    await runInDurableObject(agent, async (instance) => {
      await instance.runtime.runPromise(
        Effect.gen(function* seedEffect() {
          const inbox = yield* Inbox;
          const progress = yield* TurnProgress;
          yield* inbox.store({
            _tag: "OwnerMessage",
            channel: "telegram",
            channelUpdateId: "used-steps-1",
            conversationId: "9010",
            channelMessageId: "71",
            text: "keep",
            sentAt: new Date().toISOString(),
          });
          const [event] = yield* inbox.pending;
          for (
            let step = 0;
            step < defaultBehaviorConfig.maxToolSteps;
            step += 1
          ) {
            yield* progress.markModelStep(event?.eventId ?? "", step);
          }
        })
      );
      await instance.runTurn();
    });

    expect(fakeTelegram.sent.map((call) => call.body.text)).toEqual([
      honestFailureText,
    ]);
    expect(fakeModel.doGenerateCalls).toHaveLength(0);
    const journal = await inPersonalAgent(
      ownerId,
      Journal.pipe(Effect.flatMap((entries) => entries.read))
    );
    expect(journal.map((entry) => entry.record._tag)).toContain("TurnFailed");
  });

  it("saves no secret from the Owner message in the stored history", async () => {
    const ownerId = await addOwner(9012);
    scriptModel([{ say: "Kept" }]);

    await telegramWebhook(
      textUpdate({ fromUserId: 9012, text: `keep ${env.AI_GATEWAY_TOKEN}` })
    );
    await waitForReplies(1);

    const history = await inPersonalAgent(
      ownerId,
      Conversation.pipe(Effect.flatMap((conversation) => conversation.history))
    );
    expect(JSON.stringify(history)).not.toContain(env.AI_GATEWAY_TOKEN);
    expect(JSON.stringify(history)).toContain(redactedMark);
  });

  it("redacts secrets in the Trace steps and in the stored history", async () => {
    const ownerId = await addOwner(9005);
    scriptModel([keepWord(env.AI_GATEWAY_TOKEN), { say: "Kept" }]);

    await telegramWebhook(textUpdate({ fromUserId: 9005, text: "keep it" }));
    await waitForReplies(1);

    const [stored] = await tracesOf(ownerId);
    expect(JSON.stringify(stored?.trace.steps)).not.toContain(
      env.AI_GATEWAY_TOKEN
    );
    expect(JSON.stringify(stored?.trace.steps)).toContain(redactedMark);
    const history = await inPersonalAgent(
      ownerId,
      Conversation.pipe(Effect.flatMap((conversation) => conversation.history))
    );
    expect(JSON.stringify(history)).not.toContain(env.AI_GATEWAY_TOKEN);
  });

  it("counts steps and tool calls in the Operator metrics without content", async () => {
    await addOwner(9006);
    scriptModel([keepWord("secret-word"), { say: "Kept" }]);

    await telegramWebhook(textUpdate({ fromUserId: 9006, text: "keep it" }));
    await waitForReplies(1);

    const point = fakeMetrics.dataPoints.find((candidate) =>
      candidate.blobs?.includes("replied")
    );
    expect(point?.doubles?.slice(-3)).toEqual([2, 1, 0]);
    expect(JSON.stringify(point)).not.toContain("secret-word");
  });
});

const toolTurn = (index: number) =>
  [
    { role: "user", content: `ask ${index}` },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: `c${index}`,
          toolName: fakeTool.name,
          input: { word: "x" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `c${index}`,
          toolName: fakeTool.name,
          output: { type: "json", value: { kept: "x" } },
        },
      ],
    },
    { role: "assistant", content: `done ${index}` },
  ] satisfies ModelMessage[];

const migrationsBefore = (name: string): AgentMigrations => ({
  migrations: Object.fromEntries(
    Object.entries(personalAgentMigrations.migrations).filter(
      ([migration]) => migration < name
    )
  ),
});

const conversationLayoutMigration = "20261124202916";

describe("Conversation history", () => {
  it("sends every stored row with no window, and each row has its Turn Event id and row kind", async () => {
    const agent = await personalAgentFor(
      env.PERSONAL_AGENT,
      OwnerIdSchema.make("owner-no-window")
    );
    const turns = 8;
    const { history, rows } = await runInDurableObject(agent, (instance) =>
      instance.runtime.runPromise(
        Effect.gen(function* noWindowEffect() {
          const conversation = yield* Conversation;
          const { database } = yield* AgentStorage;
          for (let index = 0; index < turns; index += 1) {
            const turn = toolTurn(index);
            yield* storeFinishedTurn({
              eventId: `seed-${index}`,
              turnContext: `[Turn context] ${index}`,
              inputs: turn.slice(0, 1),
              steps: turn.slice(1, 3),
              ending: replied(`done ${index}`),
            });
          }
          return {
            history: yield* conversation.history,
            rows: yield* database.all<{ event_id: string; kind: string }>(
              sql`SELECT event_id, kind FROM conversation_messages ORDER BY sequence`
            ),
          };
        }).pipe(Effect.provide(Redactor.layer([])))
      )
    );

    expect(history).toHaveLength(turns * 4);
    expect(history[0]).toEqual({
      role: "user",
      content: "[Turn context] 0\nask 0",
    });
    expect(history.at(-1)).toEqual({
      role: "assistant",
      content: `done ${turns - 1}`,
    });
    expect(rows.slice(0, 4)).toEqual([
      { event_id: "seed-0", kind: "input" },
      { event_id: "seed-0", kind: "step" },
      { event_id: "seed-0", kind: "step" },
      { event_id: "seed-0", kind: "reply" },
    ]);
  });

  it("converts existing text rows to valid model messages, and the layout migration then deletes the stored Conversation", async () => {
    const agent = await personalAgentFor(
      env.PERSONAL_AGENT,
      OwnerIdSchema.make("owner-legacy-rows")
    );

    const { converted, afterLayout } = await runInDurableObject(
      agent,
      async (_instance, state) => {
        const run = <A>(
          migrations: AgentMigrations,
          effect: Effect.Effect<A, unknown, AgentStorage>
        ) =>
          Effect.runPromise(
            effect.pipe(
              Effect.provide(AgentStorage.layer(state.storage, migrations))
            )
          );
        await run(
          migrationsBefore("20261115141734"),
          Effect.gen(function* legacyEffect() {
            const { database } = yield* AgentStorage;
            yield* database.run(
              sql`INSERT INTO conversation_messages (role, text, recorded_at) VALUES ('owner', 'Hello', 'then'), ('agent', 'Hi there', 'then')`
            );
          })
        );
        const convertedRows = await run(
          migrationsBefore(conversationLayoutMigration),
          Effect.gen(function* convertedEffect() {
            const { database } = yield* AgentStorage;
            return yield* database.all<{ message: string }>(
              sql`SELECT message FROM conversation_messages ORDER BY sequence`
            );
          })
        );
        const history = await Effect.runPromise(
          Conversation.pipe(
            Effect.flatMap((conversation) => conversation.history),
            Effect.provide(
              Conversation.layer.pipe(
                Layer.provideMerge(AgentStorage.layer(state.storage))
              )
            )
          )
        );
        return {
          converted: convertedRows.map(
            (row) => JSON.parse(row.message) as unknown
          ),
          afterLayout: history,
        };
      }
    );

    expect(converted).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ]);
    for (const message of converted) {
      expect(modelMessageSchema.safeParse(message).success).toBe(true);
    }
    expect(afterLayout).toEqual([]);
  });
});
