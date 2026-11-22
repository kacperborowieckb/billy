import {
  abortAllDurableObjects,
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  alreadyAnsweredNotice,
  doneStatus,
  failedStatus,
  rejectedStatus,
} from "../src/approval/approval-status.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { setScheduleToolName } from "../src/schedule/set-schedule-tool.ts";
import {
  fakeModel,
  fakeTelegram,
  fakeTool,
  resetFakes,
  scriptModel,
} from "./fakes.ts";
import { ownerInWarsaw } from "./owner-with-data.ts";
import {
  addOwner,
  pressUpdate,
  telegramWebhook,
  textUpdate,
} from "./telegram-requests.ts";

interface PendingApprovalRow extends Record<string, SqlStorageValue> {
  pending_approval_id: string;
  tool_name: string;
  state: string;
  channel_message_id: string | null;
  result: string | null;
}

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const rowsOf = async <Row extends Record<string, SqlStorageValue>>(
  ownerId: string,
  query: string
) =>
  runInDurableObject(await agentOf(ownerId), (_, state) =>
    state.storage.sql.exec<Row>(query).toArray()
  );

const pendingApprovalsOf = (ownerId: string) =>
  rowsOf<PendingApprovalRow>(
    ownerId,
    "SELECT * FROM pending_approvals ORDER BY rowid"
  );

const countOf = async (ownerId: string, table: string) => {
  const [row] = await rowsOf<{ count: number }>(
    ownerId,
    `SELECT count(*) AS count FROM ${table}`
  );
  return row?.count;
};

const journalOf = async (ownerId: string, kind: string) => {
  const rows = await rowsOf<{ record: string }>(
    ownerId,
    `SELECT record FROM journal_entries WHERE kind = '${kind}' ORDER BY sequence`
  );
  return rows.map((row) => JSON.parse(row.record));
};

const ownerScheduleSetEntries = async (ownerId: string) => {
  const ownerSchedules = await rowsOf<{ schedule_id: string }>(
    ownerId,
    "SELECT schedule_id FROM schedules WHERE set_by = 'owner'"
  );
  const owned = new Set(ownerSchedules.map((row) => row.schedule_id));
  const entries = await journalOf(ownerId, "ScheduleSet");
  return entries.filter((record: { scheduleId: string }) =>
    owned.has(record.scheduleId)
  );
};

const conversationTexts = async (ownerId: string) => {
  const rows = await rowsOf<{ message: string }>(
    ownerId,
    "SELECT message FROM conversation_messages ORDER BY sequence"
  );
  return rows.map((row) => JSON.parse(row.message));
};

const lastConversationEntry = async (ownerId: string) => {
  const entries = await conversationTexts(ownerId);
  return entries.at(-1);
};

const firstApprovalOf = async (ownerId: string) => {
  const [first] = await pendingApprovalsOf(ownerId);
  return first;
};

const firstStateOf = async (ownerId: string) => {
  const first = await firstApprovalOf(ownerId);
  return first?.state;
};

const statesOf = async (ownerId: string) => {
  const rows = await pendingApprovalsOf(ownerId);
  return rows.map((row) => row.state);
};

const forwardedFromAna = {
  type: "user",
  sender_user: { id: 5, is_bot: false, first_name: "Ana", last_name: "Kowal" },
  date: 1_794_000_000,
};

const forward = (userId: number) =>
  telegramWebhook(
    textUpdate({
      fromUserId: userId,
      text: "Dinner at Osteria on Friday 27 Nov at 19:00. Call Ana before Thursday.",
      forwardOrigin: forwardedFromAna,
    })
  );

const setTimeZone = async (userId: number) => {
  scriptModel([
    { callTool: "set_time_zone", input: { timeZone: "Europe/Warsaw" } },
    { say: "Time zone set." },
  ]);
  await telegramWebhook(
    textUpdate({ fromUserId: userId, text: "I live in Warsaw" })
  );
  await waitForSends(1);
};

const reminderInput = {
  action: { _tag: "SendText", text: "Call Ana about dinner" },
  localDueTime: "2099-11-26T09:00",
  ownerAskedForSchedule: true,
};

const reminderSummary =
  'Set Reminder "Call Ana about dinner", Thu 26 Nov 2099, 09:00';

const waitForSends = (count: number) =>
  vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(count), {
    timeout: 10_000,
  });

const waitForEdits = (count: number) =>
  vi.waitFor(() => expect(fakeTelegram.edits).toHaveLength(count), {
    timeout: 10_000,
  });

const waitForPressAnswers = (count: number) =>
  vi.waitFor(() => expect(fakeTelegram.pressAnswers).toHaveLength(count), {
    timeout: 10_000,
  });

const waitForPending = (ownerId: string, count: number) =>
  vi.waitFor(
    async () => {
      const rows = await pendingApprovalsOf(ownerId);
      expect(rows.filter((row) => row.state === "pending")).toHaveLength(count);
    },
    { timeout: 10_000 }
  );

const waitForInboxDone = (ownerId: string) =>
  vi.waitFor(
    async () => {
      expect(
        await rowsOf(
          ownerId,
          "SELECT event_id FROM inbox_events WHERE state = 'pending'"
        )
      ).toEqual([]);
    },
    { timeout: 10_000 }
  );

const askForReminder = async (userId: number, sendsBefore = 0) => {
  const ownerId = await ownerInWarsaw(userId);
  if (sendsBefore > 0) {
    await setTimeZone(userId);
  }
  scriptModel([
    { callTool: setScheduleToolName, input: reminderInput },
    { say: "This Reminder waits for your Approval." },
  ]);
  await forward(userId);
  await waitForSends(sendsBefore + 2);
  await waitForPending(ownerId, 1);
  const [approval] = await pendingApprovalsOf(ownerId);
  return {
    ownerId,
    id: approval?.pending_approval_id ?? "",
    messageId: Number(approval?.channel_message_id),
  };
};

const press = (
  userId: number,
  data: string,
  {
    messageId,
    pressId,
  }: { readonly messageId: number; readonly pressId?: string }
) =>
  telegramWebhook(
    pressUpdate({
      fromUserId: userId,
      data,
      messageId,
      ...(pressId === undefined ? {} : { pressId }),
    })
  );

beforeEach(() => {
  resetFakes();
});

describe("Approve or Reject with a button", { timeout: 40_000 }, () => {
  it("runs the approved call once, edits the message, and records the answer", async () => {
    const { ownerId, id, messageId } = await askForReminder(9201, 1);
    const modelCalls = fakeModel.doGenerateCalls.length;

    const response = await press(9201, `approve:${id}`, { messageId });
    expect(response.status).toBe(200);
    await waitForEdits(1);
    await waitForInboxDone(ownerId);

    expect(await countOf(ownerId, "schedules WHERE set_by = 'owner'")).toBe(1);
    expect(fakeTelegram.pressAnswers).toEqual([
      { callback_query_id: expect.any(String) },
    ]);
    expect(fakeTelegram.edits.map((edit) => edit.body)).toEqual([
      {
        chat_id: 9201,
        message_id: messageId,
        text: `This waits for your Approval:\n${reminderSummary}\n${doneStatus}`,
        reply_markup: { inline_keyboard: [] },
      },
    ]);
    const [approval] = await pendingApprovalsOf(ownerId);
    expect(approval?.state).toBe("executed");
    expect(await journalOf(ownerId, "ApprovalAnswered")).toEqual([
      expect.objectContaining({ pendingApprovalId: id, answer: "approve" }),
    ]);
    expect(await journalOf(ownerId, "ApprovalRun")).toEqual([
      expect.objectContaining({ pendingApprovalId: id, result: "executed" }),
    ]);
    expect(await ownerScheduleSetEntries(ownerId)).toHaveLength(1);
    expect(await lastConversationEntry(ownerId)).toEqual({
      role: "assistant",
      content: `Approval for ${reminderSummary}: approved, done`,
    });
    expect(fakeModel.doGenerateCalls).toHaveLength(modelCalls);
    expect(fakeTelegram.sent).toHaveLength(3);
  });

  it("runs nothing on Reject and shows Rejected", async () => {
    const { ownerId, id, messageId } = await askForReminder(9202);

    await press(9202, `reject:${id}`, { messageId });
    await waitForEdits(1);
    await waitForInboxDone(ownerId);

    expect(await countOf(ownerId, "schedules WHERE set_by = 'owner'")).toBe(0);
    expect(fakeTelegram.edits[0]?.body.text).toBe(
      `This waits for your Approval:\n${reminderSummary}\n${rejectedStatus}`
    );
    expect(fakeTelegram.edits[0]?.body.reply_markup?.inline_keyboard).toEqual(
      []
    );
    const [approval] = await pendingApprovalsOf(ownerId);
    expect(approval?.state).toBe("rejected");
    expect(await journalOf(ownerId, "ApprovalRun")).toEqual([]);
    const entry = await lastConversationEntry(ownerId);
    expect(entry?.content).toBe(`Approval for ${reminderSummary}: rejected`);
  });

  it("sends no Event to the Personal Agent for a press from another Telegram user", async () => {
    const { ownerId, id, messageId } = await askForReminder(9203);
    const inboxBefore = await countOf(ownerId, "inbox_events");

    const response = await press(9299, `approve:${id}`, { messageId });

    expect(response.status).toBe(200);
    expect(await countOf(ownerId, "inbox_events")).toBe(inboxBefore);
    expect(await firstStateOf(ownerId)).toBe("pending");
    expect(await countOf(ownerId, "schedules WHERE set_by = 'owner'")).toBe(0);
    expect(fakeTelegram.edits).toEqual([]);
    expect(fakeTelegram.pressAnswers).toEqual([]);
  });

  it("sends no Event to the Personal Agent for button data that is not an Approval answer", async () => {
    const { ownerId, id, messageId } = await askForReminder(9209);
    const inboxBefore = await countOf(ownerId, "inbox_events");

    await press(9209, `approve:${id}x`, { messageId });
    await press(9209, `delete:${id}`, { messageId });

    expect(await countOf(ownerId, "inbox_events")).toBe(inboxBefore);
    expect(await firstStateOf(ownerId)).toBe("pending");
  });

  it("drops a duplicate callback by its callback query id", async () => {
    const { ownerId, id, messageId } = await askForReminder(9204, 1);

    await press(9204, `approve:${id}`, { messageId, pressId: "press-dup" });
    await press(9204, `approve:${id}`, { messageId, pressId: "press-dup" });
    await waitForEdits(1);
    await waitForInboxDone(ownerId);

    expect(
      await countOf(ownerId, "inbox_events WHERE kind = 'ApprovalAnswered'")
    ).toBe(1);
    expect(fakeTelegram.pressAnswers).toHaveLength(1);
    expect(await countOf(ownerId, "schedules WHERE set_by = 'owner'")).toBe(1);
  });

  it("retries a refused edit of the Approval message after an answer until it succeeds", async () => {
    const { ownerId, id, messageId } = await askForReminder(9215, 1);
    fakeTelegram.refuseNextEdits(1);

    await press(9215, `approve:${id}`, { messageId });
    await waitForEdits(2);
    await waitForInboxDone(ownerId);

    expect(fakeTelegram.edits[1]?.body).toEqual(fakeTelegram.edits[0]?.body);
    expect(fakeTelegram.edits[1]?.body.text).toContain(doneStatus);
    expect(fakeTelegram.edits).toHaveLength(2);
  });

  it("stops retrying a refused edit after three attempts", async () => {
    const { ownerId, id, messageId } = await askForReminder(9216, 1);
    fakeTelegram.refuseNextEdits(10);

    await press(9216, `approve:${id}`, { messageId });
    await waitForEdits(3);
    await waitForInboxDone(ownerId);

    expect(fakeTelegram.edits).toHaveLength(3);
  });

  it("answers a second press with a notice and changes nothing", async () => {
    const { ownerId, id, messageId } = await askForReminder(9205, 1);
    await press(9205, `approve:${id}`, { messageId });
    await waitForEdits(1);
    await waitForInboxDone(ownerId);

    await press(9205, `reject:${id}`, { messageId });
    await waitForPressAnswers(2);
    await waitForInboxDone(ownerId);

    expect(fakeTelegram.pressAnswers[1]).toEqual({
      callback_query_id: expect.any(String),
      text: alreadyAnsweredNotice,
    });
    expect(await firstStateOf(ownerId)).toBe("executed");
    expect(await countOf(ownerId, "schedules WHERE set_by = 'owner'")).toBe(1);
    expect(fakeTelegram.edits).toHaveLength(1);
    expect(await journalOf(ownerId, "ApprovalAnswered")).toHaveLength(1);
  });

  it("shows the failure and never says done when the approved call fails", async () => {
    const ownerId = await addOwner(9206);
    fakeTool.failWith = "The word list is full";
    scriptModel([
      { callTool: fakeTool.name, input: { word: "dinner" } },
      { say: "This waits for your Approval." },
    ]);
    await forward(9206);
    await waitForSends(2);
    await waitForPending(ownerId, 1);
    const [approval] = await pendingApprovalsOf(ownerId);

    await press(9206, `approve:${approval?.pending_approval_id}`, {
      messageId: Number(approval?.channel_message_id),
    });
    await waitForEdits(1);
    await waitForInboxDone(ownerId);

    const edited = fakeTelegram.edits[0]?.body.text ?? "";
    expect(edited).toContain(failedStatus("The word list is full"));
    expect(edited).not.toContain(doneStatus);
    expect(await firstApprovalOf(ownerId)).toMatchObject({
      state: "failed",
      result: "The word list is full",
    });
    expect(await journalOf(ownerId, "ApprovalRun")).toEqual([
      expect.objectContaining({
        result: "failed",
        reason: "The word list is full",
      }),
    ]);
  });

  it("lets each row of two work on its own", async () => {
    const ownerId = await addOwner(9207);
    await setTimeZone(9207);
    scriptModel([
      {
        callTools: [
          { tool: setScheduleToolName, input: reminderInput },
          { tool: fakeTool.name, input: { word: "dinner" } },
        ],
      },
      { say: "These wait for your Approval." },
    ]);
    await forward(9207);
    await waitForSends(3);
    await waitForPending(ownerId, 2);
    const [reminder, word] = await pendingApprovalsOf(ownerId);
    const messageId = Number(reminder?.channel_message_id);
    const wordSummary = 'Keep the word "dinner"';

    await press(9207, `approve:${reminder?.pending_approval_id}`, {
      messageId,
    });
    await waitForEdits(1);
    await waitForInboxDone(ownerId);

    expect(fakeTelegram.edits[0]?.body).toEqual({
      chat_id: 9207,
      message_id: messageId,
      text: `These wait for your Approval:\n1. ${reminderSummary}\n${doneStatus}\n2. ${wordSummary}`,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Approve 2",
              callback_data: `approve:${word?.pending_approval_id}`,
            },
            {
              text: "Reject 2",
              callback_data: `reject:${word?.pending_approval_id}`,
            },
          ],
        ],
      },
    });
    expect(fakeTool.kept).toEqual([]);

    await press(9207, `reject:${word?.pending_approval_id}`, { messageId });
    await waitForEdits(2);
    await waitForInboxDone(ownerId);

    expect(fakeTelegram.edits[1]?.body).toEqual({
      chat_id: 9207,
      message_id: messageId,
      text: `These wait for your Approval:\n1. ${reminderSummary}\n${doneStatus}\n2. ${wordSummary}\n${rejectedStatus}`,
      reply_markup: { inline_keyboard: [] },
    });
    expect(await statesOf(ownerId)).toEqual(["executed", "rejected"]);
    expect(await countOf(ownerId, "schedules WHERE set_by = 'owner'")).toBe(1);
    expect(fakeTool.kept).toEqual([]);
  });

  it("runs the approved call when Telegram never answers the press", async () => {
    const { ownerId, id, messageId } = await askForReminder(9210, 1);
    const releasePressAnswer = fakeTelegram.holdPressAnswers();

    await press(9210, `approve:${id}`, { messageId });
    await waitForEdits(1);
    await waitForInboxDone(ownerId);
    releasePressAnswer();

    expect(await countOf(ownerId, "schedules WHERE set_by = 'owner'")).toBe(1);
    expect(await firstStateOf(ownerId)).toBe("executed");
    expect(fakeTelegram.edits[0]?.body.text).toContain(doneStatus);
  });

  it("does not run the call twice after a reset during the approved run", async () => {
    const { ownerId, id, messageId } = await askForReminder(9208, 1);
    const releaseEdit = fakeTelegram.holdEdits();

    await press(9208, `approve:${id}`, { messageId });
    await waitForEdits(1);
    await abortAllDurableObjects();
    releaseEdit();
    await runDurableObjectAlarm(await agentOf(ownerId));
    await waitForEdits(2);
    await waitForInboxDone(ownerId);

    expect(await countOf(ownerId, "schedules WHERE set_by = 'owner'")).toBe(1);
    expect(await ownerScheduleSetEntries(ownerId)).toHaveLength(1);
    expect(await journalOf(ownerId, "ApprovalRun")).toHaveLength(1);
    expect(fakeTelegram.edits[1]?.body.text).toContain(doneStatus);
    expect(fakeTelegram.pressAnswers).toHaveLength(1);
  });
});
