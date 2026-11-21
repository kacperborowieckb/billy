import {
  abortAllDurableObjects,
  env,
  runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  expiredNotice,
  expiredStatus,
} from "../src/approval/approval-status.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { setScheduleToolName } from "../src/schedule/set-schedule-tool.ts";
import {
  fakeModel,
  fakeTelegram,
  fakeTool,
  fakeToolApprovalExpiryMillis,
  resetFakes,
  scriptModel,
} from "./fakes.ts";
import type { ScriptedToolCall } from "./fakes.ts";
import {
  addOwner,
  pressUpdate,
  telegramWebhook,
  textUpdate,
} from "./telegram-requests.ts";

interface PendingApprovalRow extends Record<string, SqlStorageValue> {
  pending_approval_id: string;
  turn_event_id: string;
  tool_name: string;
  state: string;
  created_at: string;
  expires_at: string;
  channel_message_id: string | null;
}

const longAgo = "2000-01-01T00:00:00.000Z";

const dayMillis = 24 * 60 * 60 * 1000;

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const rowsOf = async <Row extends Record<string, SqlStorageValue>>(
  ownerId: string,
  query: string,
  ...bindings: string[]
) =>
  runInDurableObject(await agentOf(ownerId), (_, state) =>
    state.storage.sql.exec<Row>(query, ...bindings).toArray()
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
    "SELECT record FROM journal_entries WHERE kind = ? ORDER BY sequence",
    kind
  );
  return rows.map((row) => JSON.parse(row.record));
};

const lastConversationEntry = async (ownerId: string) => {
  const rows = await rowsOf<{ message: string }>(
    ownerId,
    "SELECT message FROM conversation_messages ORDER BY sequence DESC LIMIT 1"
  );
  return rows.map((row) => JSON.parse(row.message)).at(0);
};

const alarmsOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), async (instance) => {
    const sdkSchedules = await instance.listSchedules();
    return sdkSchedules
      .filter((schedule) => schedule.callback === "fireDueSchedules")
      .map((schedule) => schedule.time);
  });

const epochSecondsOf = (instant: string) =>
  Math.ceil(Date.parse(instant) / 1000);

const makeDue = (ownerId: string, pendingApprovalId: string) =>
  rowsOf(
    ownerId,
    "UPDATE pending_approvals SET expires_at = ? WHERE pending_approval_id = ?",
    longAgo,
    pendingApprovalId
  );

const fireTheAlarm = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.fireDueSchedules()
  );

const waitFor = (check: () => unknown) =>
  vi.waitFor(check, { timeout: 10_000 });

const waitForPending = (ownerId: string, count: number) =>
  waitFor(async () => {
    const rows = await pendingApprovalsOf(ownerId);
    expect(rows.filter((row) => row.state === "pending")).toHaveLength(count);
  });

const forward = (userId: number) =>
  telegramWebhook(
    textUpdate({
      fromUserId: userId,
      text: "Dinner at Osteria on Friday 27 Nov at 19:00. Call Ana before Thursday.",
      forwardOrigin: {
        type: "user",
        sender_user: { id: 5, is_bot: false, first_name: "Ana" },
        date: 1_794_000_000,
      },
    })
  );

const reminderInput = {
  action: { _tag: "SendText", text: "Call Ana about dinner" },
  localDueTime: "2099-11-26T09:00",
  ownerAskedForSchedule: true,
};

const reminderSummary =
  'Set Reminder "Call Ana about dinner", Thu 26 Nov 2099, 09:00';

const wordSummary = 'Keep the word "dinner"';

const lifetimeOf = (row: PendingApprovalRow | undefined) =>
  Math.round(
    (Date.parse(row?.expires_at ?? "") - Date.parse(row?.created_at ?? "")) /
      1000
  ) * 1000;

const askForApprovals = async (
  userId: number,
  calls: readonly ScriptedToolCall[]
) => {
  const ownerId = await addOwner(userId);
  scriptModel([{ callTools: calls }, { say: "This waits for your Approval." }]);
  await forward(userId);
  await waitFor(() => expect(fakeTelegram.sent).toHaveLength(2));
  await waitForPending(ownerId, calls.length);
  return { ownerId, approvals: await pendingApprovalsOf(ownerId) };
};

const askForReminder = async (userId: number) => {
  const { ownerId, approvals } = await askForApprovals(userId, [
    { tool: setScheduleToolName, input: reminderInput },
  ]);
  const [approval] = approvals;
  return {
    ownerId,
    id: approval?.pending_approval_id ?? "",
    turnEventId: approval?.turn_event_id ?? "",
    expiresAt: approval?.expires_at ?? "",
    messageId: Number(approval?.channel_message_id),
  };
};

beforeEach(() => {
  resetFakes();
});

describe("Pending Approvals expire", { timeout: 40_000 }, () => {
  it("arms the alarm at the expiry instant and expires the Pending Approval there with no model call, also after a reset", async () => {
    const { ownerId, id, turnEventId, expiresAt, messageId } =
      await askForReminder(7301);
    expect(await alarmsOf(ownerId)).toEqual([epochSecondsOf(expiresAt)]);
    const modelCalls = fakeModel.doGenerateCalls.length;
    const traces = await countOf(ownerId, "turn_traces");

    await abortAllDurableObjects();
    await makeDue(ownerId, id);
    await fireTheAlarm(ownerId);

    const [approval] = await pendingApprovalsOf(ownerId);
    expect(approval?.state).toBe("expired");
    expect(await journalOf(ownerId, "ApprovalExpired")).toEqual([
      { _tag: "ApprovalExpired", eventId: turnEventId, pendingApprovalId: id },
    ]);
    expect(fakeTelegram.edits.map((edit) => edit.body)).toEqual([
      {
        chat_id: 7301,
        message_id: messageId,
        text: `This waits for your Approval:\n${reminderSummary}\n${expiredStatus}`,
        reply_markup: { inline_keyboard: [] },
      },
    ]);
    expect(await lastConversationEntry(ownerId)).toEqual({
      role: "assistant",
      content: `Approval for ${reminderSummary}: expired`,
    });
    expect(fakeModel.doGenerateCalls).toHaveLength(modelCalls);
    expect(await countOf(ownerId, "turn_traces")).toBe(traces);
    expect(await countOf(ownerId, "schedules WHERE set_by = 'owner'")).toBe(0);
    expect(await alarmsOf(ownerId)).toEqual([]);

    await fireTheAlarm(ownerId);
    expect(fakeTelegram.edits).toHaveLength(1);
    expect(await journalOf(ownerId, "ApprovalExpired")).toHaveLength(1);
  });

  it("runs nothing on a press after expiry and answers This expired", async () => {
    const { ownerId, id, messageId } = await askForReminder(7302);
    await makeDue(ownerId, id);
    await fireTheAlarm(ownerId);

    await telegramWebhook(
      pressUpdate({ fromUserId: 7302, data: `approve:${id}`, messageId })
    );
    await waitFor(() => expect(fakeTelegram.pressAnswers).toHaveLength(1));

    expect(fakeTelegram.pressAnswers[0]).toEqual({
      callback_query_id: expect.any(String),
      text: expiredNotice,
    });
    const [approval] = await pendingApprovalsOf(ownerId);
    expect(approval?.state).toBe("expired");
    expect(await countOf(ownerId, "schedules WHERE set_by = 'owner'")).toBe(0);
    expect(await journalOf(ownerId, "ApprovalAnswered")).toEqual([]);
    expect(fakeTelegram.edits).toHaveLength(1);
  });

  it("uses the tool's own expiry over the default and expires only the due row of a message", async () => {
    const { ownerId, approvals } = await askForApprovals(7303, [
      { tool: setScheduleToolName, input: reminderInput },
      { tool: fakeTool.name, input: { word: "dinner" } },
    ]);
    const [reminder, word] = approvals;
    expect(lifetimeOf(reminder)).toBe(dayMillis);
    expect(lifetimeOf(word)).toBe(fakeToolApprovalExpiryMillis);
    expect(await alarmsOf(ownerId)).toEqual([
      epochSecondsOf(word?.expires_at ?? ""),
    ]);

    await makeDue(ownerId, word?.pending_approval_id ?? "");
    await fireTheAlarm(ownerId);

    const rows = await pendingApprovalsOf(ownerId);
    expect(rows.map((row) => row.state)).toEqual(["pending", "expired"]);
    expect(fakeTelegram.edits[0]?.body).toEqual({
      chat_id: 7303,
      message_id: Number(reminder?.channel_message_id),
      text: `These wait for your Approval:\n1. ${reminderSummary}\n2. ${wordSummary}\n${expiredStatus}`,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Approve 1",
              callback_data: `approve:${reminder?.pending_approval_id}`,
            },
            {
              text: "Reject 1",
              callback_data: `reject:${reminder?.pending_approval_id}`,
            },
          ],
        ],
      },
    });
    expect(fakeTool.kept).toEqual([]);
    expect(await alarmsOf(ownerId)).toEqual([
      epochSecondsOf(reminder?.expires_at ?? ""),
    ]);
  });
});
