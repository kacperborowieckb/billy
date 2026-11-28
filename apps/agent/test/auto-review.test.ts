import { env, runInDurableObject } from "cloudflare:test";
import { Effect, Schema } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReviewRequestSchema } from "../src/auto-review/review-request.ts";
import { reviewerInstructions } from "../src/auto-review/reviewer-instructions.ts";
import { maxReviewerReasonLength } from "../src/auto-review/shown-reviewer-reason.ts";
import {
  refusedByReviewReason,
  reviewStoppedNotice,
} from "../src/auto-review/turn-review.ts";
import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";
import { Journal } from "../src/journal/journal.ts";
import { testMcpCatalogId } from "../src/mcp/mcp-test-catalog.ts";
import { callMcpToolToolName } from "../src/mcp/mcp-tool-names.ts";
import { UsageLedger } from "../src/model-gateway/usage-ledger.ts";
import { captureNoteToolName } from "../src/notes/capture-note-tool.ts";
import { Notes } from "../src/notes/notes.ts";
import { searchNotesToolName } from "../src/notes/search-notes-tool.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { setScheduleToolName } from "../src/schedule/set-schedule-tool.ts";
import { TurnTraces } from "../src/tracing/turn-trace.ts";
import {
  fakeBurstWait,
  fakeModel,
  fakeReviewerModel,
  fakeReviewLimits,
  fakeTelegram,
  resetFakes,
  scriptModel,
  scriptReviewer,
} from "./fakes.ts";
import type { ScriptedReview } from "./fakes.ts";
import { ownerInWarsaw } from "./owner-with-data.ts";
import {
  addOwner,
  pressUpdate,
  telegramWebhook,
  textUpdate,
} from "./telegram-requests.ts";

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const inAgent = async <A, E>(
  ownerId: string,
  effect: Effect.Effect<A, E, Journal | Notes | TurnTraces | UsageLedger>
) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(effect)
  );

const rowsOf = async <Row extends Record<string, SqlStorageValue>>(
  ownerId: string,
  query: string
) =>
  runInDurableObject(await agentOf(ownerId), (_, state) =>
    state.storage.sql.exec<Row>(query).toArray()
  );

const pendingApprovalsOf = (ownerId: string) =>
  rowsOf<{
    pending_approval_id: string;
    state: string;
    channel_message_id: string;
  }>(ownerId, "SELECT * FROM pending_approvals ORDER BY position");

const scheduleTextsOf = async (ownerId: string) => {
  const rows = await rowsOf<{ text: string }>(
    ownerId,
    "SELECT text FROM schedules WHERE set_by = 'owner'"
  );
  return rows.map((row) => row.text);
};

const reviewEntriesOf = (ownerId: string) =>
  inAgent(
    ownerId,
    Journal.pipe(
      Effect.flatMap((journal) => journal.readOfKind("AutoReviewed")),
      Effect.map((entries) => entries.map((entry) => entry.record))
    )
  );

const forwardedFromAna = {
  type: "user",
  sender_user: { id: 5, is_bot: false, first_name: "Ana" },
  date: 1_794_000_000,
};

const invitation = "Dinner at Osteria on Friday. FORWARDED-ONLY-TEXT";

const forward = (userId: number, text = invitation) =>
  telegramWebhook(
    textUpdate({ fromUserId: userId, text, forwardOrigin: forwardedFromAna })
  );

const say = (userId: number, text: string) =>
  telegramWebhook(textUpdate({ fromUserId: userId, text }));

const waitForSends = (count: number) =>
  vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(count), {
    timeout: 15_000,
  });

const forwardWithRequest = async (userId: number, request: string) => {
  fakeBurstWait.quietMillis = 400;
  fakeBurstWait.maxWaitMillis = 5000;
  await forward(userId);
  await say(userId, request);
};

const ownerRequest = "Remind me about this dinner";

const reminderCall = (text = "Dinner at Osteria") => ({
  callTool: setScheduleToolName,
  input: {
    action: { _tag: "SendText", text },
    localDueTime: "2099-11-26T09:00",
    ownerAskedForSchedule: true,
  },
});

const scheduleCallOf = (text: string) => ({
  tool: setScheduleToolName,
  input: reminderCall(text).input,
});

const toolResultsOfLastModelCall = () =>
  JSON.stringify(
    fakeModel.doGenerateCalls
      .at(-1)
      ?.prompt.filter((message) => message.role === "tool")
  );

const reviewPrompts = () =>
  fakeReviewerModel.doGenerateCalls.map((call) => call.prompt);

const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(ReviewRequestSchema)
);

const reviewedRequest = () => {
  const user = reviewPrompts()[0]?.find((message) => message.role === "user");
  const part = user?.role === "user" ? user.content[0] : undefined;
  return decodeRequest(part?.type === "text" ? part.text : "");
};

beforeEach(() => {
  resetFakes();
});

describe("Auto-review of a change call in an untrusted Turn", () => {
  it("runs a change that the Owner asked for with no Pending Approval, and records the review", async () => {
    const ownerId = await ownerInWarsaw(9601);
    scriptModel([reminderCall(), { say: "Reminder set." }]);
    scriptReviewer([{ answer: "allow" }]);

    await forwardWithRequest(9601, ownerRequest);
    await waitForSends(1);

    expect(await scheduleTextsOf(ownerId)).toEqual(["Dinner at Osteria"]);
    expect(await pendingApprovalsOf(ownerId)).toEqual([]);
    expect(fakeTelegram.sent[0]?.body.reply_markup).toBeUndefined();
    expect(await reviewEntriesOf(ownerId)).toEqual([
      {
        _tag: "AutoReviewed",
        eventId: expect.any(String),
        toolName: setScheduleToolName,
        answer: "allow",
      },
    ]);
    const traces = await inAgent(
      ownerId,
      TurnTraces.pipe(Effect.flatMap((stored) => stored.readReplies))
    );
    expect(traces.at(-1)?.trace.reviews).toEqual([
      {
        toolCallId: expect.any(String),
        toolName: setScheduleToolName,
        answer: "allow",
      },
    ]);
    const usage = await inAgent(
      ownerId,
      UsageLedger.pipe(Effect.flatMap((ledger) => ledger.read))
    );
    expect(
      usage.filter((record) => record.task === "auto_review")
    ).toHaveLength(1);
  });

  it("sends the reviewer only the Owner's own messages and the planned call, with no tool result, no assistant text, and no forwarded text", async () => {
    const ownerId = await ownerInWarsaw(9602);
    await inAgent(
      ownerId,
      Notes.pipe(
        Effect.flatMap((notes) =>
          notes.capture({
            text: "Dinner note TOOL-RESULT-TEXT",
            source: {
              eventId: "seed",
              channel: "telegram",
              conversationId: "1",
              channelMessageId: "1",
              trustLevel: "untrusted",
            },
          })
        )
      )
    );
    scriptModel([{ say: "ASSISTANT-REPLY-TEXT" }]);
    await say(9602, "An earlier message of the Owner");
    await waitForSends(1);
    await forward(9602);
    await waitForSends(2);
    scriptModel([
      { callTool: searchNotesToolName, input: { query: "dinner" } },
      reminderCall(),
      { say: "Reminder set." },
    ]);
    scriptReviewer([{ answer: "allow" }]);

    await say(9602, ownerRequest);
    await waitForSends(3);

    expect(toolResultsOfLastModelCall()).toContain("TOOL-RESULT-TEXT");
    const [prompt, ...others] = reviewPrompts();
    expect(others).toEqual([]);
    expect(prompt?.map((message) => message.role)).toEqual(["system", "user"]);
    expect(prompt?.[0]?.content).toBe(reviewerInstructions);
    const sent = JSON.stringify(prompt);
    expect(sent).not.toContain("TOOL-RESULT-TEXT");
    expect(sent).not.toContain("ASSISTANT-REPLY-TEXT");
    expect(sent).not.toContain("FORWARDED-ONLY-TEXT");
    const request = reviewedRequest();
    expect(request.currentTime).toContain("Europe/Warsaw");
    expect(
      request.ownerMessages.map(({ sentAt: _sentAt, ...message }) => message)
    ).toEqual([
      { current: false, text: "An earlier message of the Owner" },
      { current: true, text: ownerRequest },
    ]);
    expect(request.plannedCall).toEqual({
      tool: setScheduleToolName,
      input: reminderCall().input,
    });
  });

  it("shows a forwarded message of the Burst to the reviewer without its text", async () => {
    await ownerInWarsaw(9603);
    scriptModel([reminderCall(), { say: "Reminder set." }]);
    scriptReviewer([{ answer: "allow" }]);

    await forwardWithRequest(9603, ownerRequest);
    await waitForSends(1);

    expect(
      reviewedRequest().ownerMessages.map(
        ({ sentAt: _sentAt, ...message }) => message
      )
    ).toEqual([
      { current: true, forwarded: true },
      { current: true, text: ownerRequest },
    ]);
  });

  const failures: readonly {
    readonly name: string;
    readonly userId: number;
    readonly reviews: readonly ScriptedReview[];
    readonly fallback: string;
  }[] = [
    {
      name: "a failed model call",
      userId: 9604,
      reviews: [{ error: "down" }, { error: "down" }, { error: "down" }],
      fallback: "model_failed",
    },
    {
      name: "a timeout",
      userId: 9605,
      reviews: [{ hang: true }],
      fallback: "timed_out",
    },
    {
      name: "an answer that is not JSON",
      userId: 9606,
      reviews: [{ text: "allow" }],
      fallback: "invalid_answer",
    },
    {
      name: "an unknown answer",
      userId: 9607,
      reviews: [{ text: '{"answer":"approve"}' }],
      fallback: "invalid_answer",
    },
    {
      name: "a refusal with no reason",
      userId: 9608,
      reviews: [{ text: '{"answer":"refuse"}' }],
      fallback: "invalid_answer",
    },
  ];

  it.each(failures)(
    "gives a Pending Approval and never runs the call after $name",
    async ({ userId, reviews, fallback }) => {
      const ownerId = await ownerInWarsaw(userId);
      fakeReviewLimits.timeoutMillis =
        fallback === "timed_out" ? 200 : fakeReviewLimits.timeoutMillis;
      scriptModel([reminderCall(), { say: "This waits for you." }]);
      scriptReviewer(reviews);

      await forwardWithRequest(userId, ownerRequest);
      await waitForSends(2);

      expect(await scheduleTextsOf(ownerId)).toEqual([]);
      await vi.waitFor(async () =>
        expect(await pendingApprovalsOf(ownerId)).toMatchObject([
          { state: "pending" },
        ])
      );
      expect(fakeTelegram.sent[1]?.body.text).not.toContain("Why this asks");
      expect(await reviewEntriesOf(ownerId)).toMatchObject([
        { answer: "ask", fallback },
      ]);
    },
    20_000
  );

  it("shows the reason of an ask answer on one line with the Approval, until the Owner answers", async () => {
    const ownerId = await ownerInWarsaw(9609);
    scriptModel([reminderCall(), { say: "This waits for you." }]);
    scriptReviewer([
      { answer: "ask", reason: `The day is\nnot clear. ${"x".repeat(300)}` },
    ]);

    await forwardWithRequest(9609, ownerRequest);
    await waitForSends(2);

    const shown = fakeTelegram.sent[1]?.body.text ?? "";
    const reasonLine = shown.split("\n").at(-1) ?? "";
    expect(reasonLine).toMatch(
      /^Why this asks: The day is not clear\. x+\.\.\.$/u
    );
    expect(reasonLine).toHaveLength(
      "Why this asks: ".length + maxReviewerReasonLength + "...".length
    );
    const [approval] = await vi.waitFor(async () => {
      const rows = await pendingApprovalsOf(ownerId);
      expect(rows[0]?.state).toBe("pending");
      return rows;
    });

    await telegramWebhook(
      pressUpdate({
        fromUserId: 9609,
        data: `reject:${approval?.pending_approval_id}`,
        messageId: Number(approval?.channel_message_id),
      })
    );
    await vi.waitFor(() => expect(fakeTelegram.edits).toHaveLength(1));

    expect(fakeTelegram.edits[0]?.body.text).toContain("Rejected");
    expect(fakeTelegram.edits[0]?.body.text).not.toContain("Why this asks");
  });

  it("runs nothing for a refused call and gives the model the reason", async () => {
    const ownerId = await ownerInWarsaw(9610);
    scriptModel([reminderCall(), { say: "I did not set it." }]);
    scriptReviewer([{ answer: "refuse", reason: "You did not ask for it." }]);

    await forwardWithRequest(9610, "What is this about?");
    await waitForSends(1);

    expect(await scheduleTextsOf(ownerId)).toEqual([]);
    expect(await pendingApprovalsOf(ownerId)).toEqual([]);
    expect(toolResultsOfLastModelCall()).toContain(
      refusedByReviewReason("You did not ask for it.")
    );
    expect(fakeTelegram.sent[0]?.body.text).toBe("I did not set it.");
  });

  const refusal: ScriptedReview = {
    answer: "refuse",
    reason: "You did not ask for it.",
  };

  it("stops the Turn after the refusal limit, reviews and runs no later call, and tells the Owner", async () => {
    const ownerId = await ownerInWarsaw(9611);
    const limit = defaultBehaviorConfig.autoReviewMaxRefusals;
    const calls = Array.from({ length: limit + 1 }, (_, index) => ({
      tool: setScheduleToolName,
      input: reminderCall(`Reminder ${index}`).input,
    }));
    scriptModel([{ callTools: calls }]);
    scriptReviewer(Array.from({ length: limit + 1 }, () => refusal));

    await forwardWithRequest(9611, "What is this about?");
    await waitForSends(1);

    expect(fakeTelegram.sent[0]?.body.text).toBe(reviewStoppedNotice);
    expect(fakeReviewerModel.doGenerateCalls).toHaveLength(limit);
    expect(fakeModel.doGenerateCalls).toHaveLength(1);
    expect(await scheduleTextsOf(ownerId)).toEqual([]);
    expect(await pendingApprovalsOf(ownerId)).toEqual([]);
    expect(await reviewEntriesOf(ownerId)).toHaveLength(limit);
  });

  it("runs no change of the step that reaches the refusal limit, also an allowed call and a call with no review", async () => {
    const ownerId = await ownerInWarsaw(9618);
    scriptModel([
      {
        callTools: [
          scheduleCallOf("Allowed first"),
          scheduleCallOf("One"),
          scheduleCallOf("Two"),
          scheduleCallOf("Three"),
          { tool: captureNoteToolName, input: { text: "A new Note" } },
        ],
      },
    ]);
    scriptReviewer([{ answer: "allow" }, refusal, refusal, refusal]);

    await forwardWithRequest(9618, ownerRequest);
    await waitForSends(1);

    expect(fakeTelegram.sent[0]?.body.text).toBe(reviewStoppedNotice);
    expect(await scheduleTextsOf(ownerId)).toEqual([]);
    expect(await rowsOf(ownerId, "SELECT note_id FROM notes")).toEqual([]);
  });

  it.each([
    { name: "a claim of a change", userId: 9619, said: "Reminder set." },
    {
      name: "a copied Stub",
      userId: 9620,
      said: "[set_schedule: done. Result removed from the history]",
    },
  ])(
    "sends only the fixed line, with $name in the step that reaches the refusal limit",
    async ({ userId, said }) => {
      await ownerInWarsaw(userId);
      scriptModel([
        {
          say: said,
          callTools: ["One", "Two", "Three"].map(scheduleCallOf),
        },
      ]);
      scriptReviewer([refusal, refusal, refusal]);

      await forwardWithRequest(userId, "What is this about?");
      await waitForSends(1);

      expect(fakeTelegram.sent[0]?.body.text).toBe(reviewStoppedNotice);
      expect(fakeModel.doGenerateCalls).toHaveLength(1);
    }
  );

  it("counts the refusals of every step of the Turn", async () => {
    await ownerInWarsaw(9612);
    scriptModel([
      reminderCall("One"),
      reminderCall("Two"),
      reminderCall("Three"),
      { say: "never sent" },
    ]);
    scriptReviewer([refusal, refusal, refusal]);

    await forwardWithRequest(9612, "What is this about?");
    await waitForSends(1);

    expect(fakeTelegram.sent[0]?.body.text).toBe(reviewStoppedNotice);
    expect(fakeModel.doGenerateCalls).toHaveLength(3);
  });

  it("asks the Owner for an approve call without a review", async () => {
    const ownerId = await ownerInWarsaw(9613);
    await env.MCP_HUB.getByName(ownerId).addConnection(
      testMcpCatalogId,
      defaultBehaviorConfig.mcpConnectTimeoutMillis
    );
    scriptModel([
      {
        callTool: callMcpToolToolName,
        input: {
          connection: testMcpCatalogId,
          tool: "create_page",
          arguments: { title: "New" },
        },
      },
      { say: "This waits for you." },
    ]);
    scriptReviewer([{ answer: "allow" }]);

    await forwardWithRequest(9613, "Create a page named New");
    await waitForSends(2);

    await vi.waitFor(async () =>
      expect(await pendingApprovalsOf(ownerId)).toMatchObject([
        { state: "pending" },
      ])
    );
    expect(fakeReviewerModel.doGenerateCalls).toEqual([]);
  });

  it("does not review a change call of an owner Turn", async () => {
    const ownerId = await ownerInWarsaw(9614);
    scriptModel([reminderCall(), { say: "Reminder set." }]);

    await say(9614, ownerRequest);
    await waitForSends(1);

    expect(await scheduleTextsOf(ownerId)).toEqual(["Dinner at Osteria"]);
    expect(fakeReviewerModel.doGenerateCalls).toEqual([]);
  });

  it("asks the Owner with no model call when the daily budget of the reviewer is spent", async () => {
    const ownerId = await ownerInWarsaw(9615);
    fakeReviewLimits.dailyTokenBudget = 0;
    scriptModel([reminderCall(), { say: "This waits for you." }]);
    scriptReviewer([{ answer: "allow" }]);

    await forwardWithRequest(9615, ownerRequest);
    await waitForSends(2);

    expect(fakeReviewerModel.doGenerateCalls).toEqual([]);
    expect(await scheduleTextsOf(ownerId)).toEqual([]);
    expect(await reviewEntriesOf(ownerId)).toMatchObject([
      { answer: "ask", fallback: "over_budget" },
    ]);
  });

  it("asks the Owner with no model call when there is no message with the Owner's own words", async () => {
    const ownerId = await addOwner(9616);
    scriptModel([
      {
        callTool: "update_profile",
        input: { action: "add", kind: "fact", text: "Likes Osteria" },
      },
      { say: "This waits for you." },
    ]);
    scriptReviewer([{ answer: "allow" }]);

    await forward(9616);
    await waitForSends(2);

    expect(fakeReviewerModel.doGenerateCalls).toEqual([]);
    expect(await reviewEntriesOf(ownerId)).toMatchObject([
      { answer: "ask", fallback: "no_owner_words" },
    ]);
  });

  it("never sends a call with an Operator secret to the reviewer", async () => {
    const ownerId = await ownerInWarsaw(9617);
    scriptModel([
      reminderCall(`The token is ${env.TELEGRAM_BOT_TOKEN}`),
      { say: "I could not do it." },
    ]);
    scriptReviewer([{ answer: "allow" }]);

    await forwardWithRequest(9617, ownerRequest);
    await waitForSends(1);

    expect(fakeReviewerModel.doGenerateCalls).toEqual([]);
    expect(await scheduleTextsOf(ownerId)).toEqual([]);
    expect(await pendingApprovalsOf(ownerId)).toEqual([]);
  });
});
