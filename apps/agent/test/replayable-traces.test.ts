import { env, runInDurableObject } from "cloudflare:test";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Journal } from "../src/journal/journal.ts";
import { UsageLedger } from "../src/model-gateway/usage-ledger.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { textAfterContextBlock } from "../src/personal-agent/context-labels.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { redactedMark } from "../src/tracing/redactor.ts";
import { TurnTraces } from "../src/tracing/turn-trace.ts";
import {
  failModel,
  fakeReplyPrefix,
  fakeTelegram,
  resetFakes,
} from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

const inPersonalAgent = async <A, E>(
  ownerId: string,
  effect: Effect.Effect<A, E, Journal | TurnTraces | UsageLedger>
) =>
  runInDurableObject(
    await personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId)),
    (instance) => instance.runtime.runPromise(effect)
  );

const tracesOf = (ownerId: string) =>
  inPersonalAgent(
    ownerId,
    TurnTraces.pipe(Effect.flatMap((traces) => traces.readReplies))
  );

const waitForTraces = (ownerId: string, count: number) =>
  vi.waitFor(async () => expect(await tracesOf(ownerId)).toHaveLength(count), {
    timeout: 10_000,
  });

const everythingStoredFor = async (ownerId: string) =>
  JSON.stringify(
    await inPersonalAgent(
      ownerId,
      Effect.all({
        traces: TurnTraces.pipe(Effect.flatMap((traces) => traces.readReplies)),
        journal: Journal.pipe(Effect.flatMap((journal) => journal.read)),
        usage: UsageLedger.pipe(Effect.flatMap((ledger) => ledger.read)),
      })
    )
  );

const allSecrets = [
  env.AI_GATEWAY_TOKEN,
  env.TELEGRAM_BOT_TOKEN,
  env.TELEGRAM_WEBHOOK_SECRET,
  env.OPERATOR_TOKEN,
];

beforeEach(() => {
  resetFakes();
});

describe("Replayable Traces", () => {
  it("records the prompt, model settings, reply, and usage of a normal Turn", async () => {
    const ownerId = await addOwner(8001);

    await telegramWebhook(textUpdate({ fromUserId: 8001, text: "Hello" }));
    await waitForTraces(ownerId, 1);

    const [stored] = await tracesOf(ownerId);
    expect(stored?.ownerId).toBe(ownerId);
    expect(stored?.trace).toMatchObject({
      result: "model_replied",
      task: "reply",
      modelId: "fake-reply-model",
      modelSettings: {
        attempts: 3,
        attemptTimeoutMillis: 30_000,
        reasoningEffort: "none",
      },
      request: {
        kind: "pointer",
        tail: [
          {
            role: "user",
            content: expect.stringMatching(
              /^\[Turn context\][^]*\[End of Turn context\]\nHello$/u
            ),
          },
        ],
      },
      steps: [
        {
          toolCalls: [],
          usage: {
            inputTokens: 42,
            outputTokens: 7,
            cachedInputTokens: 12,
            costUsd: null,
          },
        },
      ],
      reply: `${fakeReplyPrefix}Hello`,
      error: null,
      usage: {
        inputTokens: 42,
        outputTokens: 7,
        cachedInputTokens: 12,
        costUsd: null,
      },
    });
    expect(stored?.trace.modelLatencyMillis).toBeGreaterThanOrEqual(0);
  });

  it("records a failed Turn with its error and no secret", async () => {
    const ownerId = await addOwner(8003);
    failModel(3, `Provider refused ${allSecrets.join(" and ")}`);

    await telegramWebhook(textUpdate({ fromUserId: 8003, text: "Hello" }));
    await waitForTraces(ownerId, 1);

    const [stored] = await tracesOf(ownerId);
    expect(stored?.trace).toMatchObject({
      result: "model_failed",
      reply: null,
      modelSettings: { reasoningEffort: "none" },
      request: {
        kind: "pointer",
        tail: [
          {
            role: "user",
            content: expect.stringMatching(
              /^\[Turn context\][^]*\[End of Turn context\]\nHello$/u
            ),
          },
        ],
      },
    });
    expect(stored?.trace.error).toContain(redactedMark);
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    const storedText = await everythingStoredFor(ownerId);
    for (const secret of allSecrets) {
      expect(storedText).not.toContain(secret);
    }
  });

  it("replaces a secret that the Owner sends or the model repeats", async () => {
    const ownerId = await addOwner(8005);

    await telegramWebhook(
      textUpdate({ fromUserId: 8005, text: `Keys ${allSecrets.join(" ")}` })
    );
    await waitForTraces(ownerId, 1);

    const storedText = await everythingStoredFor(ownerId);
    for (const secret of allSecrets) {
      expect(storedText).not.toContain(secret);
    }
    const marks = allSecrets.map(() => redactedMark).join(" ");
    const [stored] = await tracesOf(ownerId);
    const request = stored?.trace.request;
    expect(
      textAfterContextBlock(
        String(request?.kind === "pointer" && request.tail.at(-1)?.content)
      )
    ).toBe(`Keys ${marks}`);
    expect(stored?.trace.reply).toBe(`${fakeReplyPrefix}Keys ${marks}`);
  });
});
