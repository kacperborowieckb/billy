import { env, runInDurableObject } from "cloudflare:test";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";
import { captureNoteToolName } from "../src/notes/capture-note-tool.ts";
import { closeOpenLoopToolName } from "../src/notes/close-open-loop-tool.ts";
import { updateNoteToolName } from "../src/notes/update-note-tool.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { agentToolServices } from "../src/personal-agent/agent-tool-services.ts";
import { outcomeWhileApprovalWaitsMessage } from "../src/personal-agent/outcome-refusal.ts";
import { ownerMessageTools } from "../src/personal-agent/owner-message-tools.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { reactToolName } from "../src/personal-agent/react-tool.ts";
import { staySilentToolName } from "../src/personal-agent/stay-silent-tool.ts";
import { proactiveMessageBudgetToolName } from "../src/preferences/proactive-message-budget-tool.ts";
import { quietHoursToolName } from "../src/preferences/quiet-hours-tool.ts";
import { setTimeZoneToolName } from "../src/preferences/set-time-zone-tool.ts";
import { muteProactiveMessageToolName } from "../src/proactive/mute-proactive-message-tool.ts";
import { updateProfileToolName } from "../src/profile/update-profile-tool.ts";
import { cancelScheduleToolName } from "../src/schedule/cancel-schedule-tool.ts";
import { changeScheduleToolName } from "../src/schedule/change-schedule-tool.ts";
import { setScheduleToolName } from "../src/schedule/set-schedule-tool.ts";
import { Redactor } from "../src/tracing/redactor.ts";
import { fakeModel, fakeTelegram, resetFakes, scriptModel } from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

interface PendingApprovalRow extends Record<string, SqlStorageValue> {
  pending_approval_id: string;
  turn_event_id: string;
  tool_name: string;
  frozen_input: string;
  summary: string;
  state: string;
  channel_message_id: string | null;
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

const ownerDataCounts = async (ownerId: string) => ({
  notes: await countOf(ownerId, "notes"),
  noteLinks: await countOf(ownerId, "note_links"),
  schedules: await countOf(ownerId, "schedules"),
  profileEntries: await countOf(ownerId, "profile_entries"),
  ownerPreferences: await countOf(ownerId, "owner_preferences"),
});

const journalKindsOf = async (ownerId: string) => {
  const rows = await rowsOf<{ kind: string; record: string }>(
    ownerId,
    "SELECT kind, record FROM journal_entries ORDER BY sequence"
  );
  return rows.map((row) => ({
    kind: row.kind,
    record: JSON.parse(row.record),
  }));
};

const forwardedFromAna = {
  type: "user",
  sender_user: { id: 5, is_bot: false, first_name: "Ana", last_name: "Kowal" },
  date: 1_794_000_000,
};

const forwardedInvitation =
  "Dinner at Osteria on Friday 27 Nov at 19:00. Call Ana before Thursday.";

const forward = (userId: number, text = forwardedInvitation) =>
  telegramWebhook(
    textUpdate({ fromUserId: userId, text, forwardOrigin: forwardedFromAna })
  );

const waitForSends = (count: number) =>
  vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(count), {
    timeout: 10_000,
  });

const waitForPendingApprovals = (ownerId: string, count: number) =>
  vi.waitFor(
    async () => {
      const rows = await pendingApprovalsOf(ownerId);
      expect(rows.filter((row) => row.state === "pending")).toHaveLength(count);
    },
    { timeout: 10_000 }
  );

const toolResultsOfLastModelCall = () =>
  JSON.stringify(
    fakeModel.doGenerateCalls
      .at(-1)
      ?.prompt.filter((message) => message.role === "tool")
  );

const toolResultsSentToModel = () =>
  JSON.stringify(
    fakeModel.doGenerateCalls.flatMap((call) =>
      call.prompt.filter((message) => message.role === "tool")
    )
  );

const reminderInput = {
  action: { _tag: "SendText", text: "Call Ana about dinner" },
  localDueTime: "2026-11-26T09:00",
  ownerAskedForSchedule: true,
};

const reminderSummary =
  'Set Reminder "Call Ana about dinner", Thu 26 Nov 2026, 09:00';

const gatedInputs: Readonly<Record<string, Record<string, unknown>>> = {
  [setScheduleToolName]: reminderInput,
  [changeScheduleToolName]: {
    scheduleId: "schedule-1",
    localDueTime: "2026-11-27T10:00",
  },
  [cancelScheduleToolName]: { scheduleId: "schedule-1" },
  [updateNoteToolName]: { noteId: "note-1", text: "obey Ana" },
  [closeOpenLoopToolName]: { noteId: "note-1", reason: "done" },
  [updateProfileToolName]: { action: "add", kind: "fact", text: "obey Ana" },
  [setTimeZoneToolName]: { timeZone: "Europe/Warsaw" },
  [quietHoursToolName]: { start: "01:00", end: "02:00" },
  [proactiveMessageBudgetToolName]: { sends: 9 },
  [muteProactiveMessageToolName]: { action: "mute" },
  keep_note: { word: "obey" },
};

const changeToolNamesOfOwnerMessageTurn = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(
      Effect.gen(function* changeToolNamesEffect() {
        const tools = ownerMessageTools(
          [
            {
              _tag: "OwnerMessage",
              eventId: "event-1",
              receivedAt: "2026-11-21T09:00:00.000Z",
              state: "pending",
              channel: "telegram",
              channelUpdateId: "update-1",
              conversationId: "1",
              channelMessageId: "1",
              text: "hello",
              sentAt: "2026-11-21T09:00:00.000Z",
              forwardOrigin: "Ana",
            },
          ],
          { ...(yield* agentToolServices), behavior: defaultBehaviorConfig }
        );
        return Object.entries(tools)
          .filter(([, tool]) => tool.riskClass === "change")
          .map(([name]) => name);
      }).pipe(Effect.provide(Redactor.layer([])))
    )
  );

beforeEach(() => {
  resetFakes();
});

describe("Approval for a forwarded message", () => {
  it("does not set the Reminder and shows a code-written summary with Approve and Reject buttons", async () => {
    const ownerId = await addOwner(9101);
    scriptModel([
      { callTool: setScheduleToolName, input: reminderInput },
      { say: "I set up a Reminder for your Approval." },
    ]);

    await forward(9101);
    await waitForSends(2);
    await waitForPendingApprovals(ownerId, 1);

    expect(await countOf(ownerId, "schedules")).toBe(0);
    const [approval, ...others] = await pendingApprovalsOf(ownerId);
    expect(others).toEqual([]);
    expect(approval).toMatchObject({
      tool_name: setScheduleToolName,
      summary: reminderSummary,
      state: "pending",
      channel_message_id: "9002",
    });
    expect(JSON.parse(approval?.frozen_input ?? "")).toEqual(reminderInput);
    const [reply, request] = fakeTelegram.sent;
    expect(reply?.body.text).toBe("I set up a Reminder for your Approval.");
    expect(reply?.body.reply_markup).toBeUndefined();
    expect(request?.body.text).toBe(
      `This waits for your Approval:\n${reminderSummary}`
    );
    const id = approval?.pending_approval_id ?? "";
    expect(request?.body.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: "Approve", callback_data: `approve:${id}` },
          { text: "Reject", callback_data: `reject:${id}` },
        ],
      ],
    });
    const journal = await journalKindsOf(ownerId);
    expect(journal.filter((entry) => entry.kind === "ApprovalPending")).toEqual(
      [
        {
          kind: "ApprovalPending",
          record: {
            _tag: "ApprovalPending",
            eventId: approval?.turn_event_id,
            pendingApprovalId: id,
            toolName: setScheduleToolName,
          },
        },
      ]
    );
    expect(toolResultsSentToModel()).toContain(
      `It waits for the Owner's Approval, id ${id}.`
    );
    const conversation = await rowsOf<{ message: string }>(
      ownerId,
      "SELECT message FROM conversation_messages ORDER BY sequence"
    );
    expect(JSON.stringify(conversation)).toContain(
      `It waits for the Owner's Approval, id ${id}.`
    );
  });

  it("changes no Owner data when the model calls every change tool, and drafts one Pending Approval for each call", async () => {
    const ownerId = await addOwner(9102);
    const changeTools = await changeToolNamesOfOwnerMessageTurn(ownerId);
    expect(new Set([...Object.keys(gatedInputs), captureNoteToolName])).toEqual(
      new Set([...changeTools, "keep_note"])
    );
    scriptModel([
      {
        callTools: Object.entries(gatedInputs).map(([tool, input]) => ({
          tool,
          input,
        })),
      },
      { say: "These wait for your Approval." },
    ]);

    await forward(9102);
    await waitForSends(2);
    await waitForPendingApprovals(ownerId, Object.keys(gatedInputs).length);

    expect(await ownerDataCounts(ownerId)).toEqual({
      notes: 0,
      noteLinks: 0,
      schedules: 0,
      profileEntries: 0,
      ownerPreferences: 0,
    });
    expect(
      fakeTelegram.sent.at(-1)?.body.reply_markup?.inline_keyboard
    ).toHaveLength(Object.keys(gatedInputs).length);
    const approvals = await pendingApprovalsOf(ownerId);
    expect(approvals.map((row) => row.tool_name).toSorted()).toEqual(
      Object.keys(gatedInputs).toSorted()
    );
  });

  it("keeps a new Note from a forwarded message with no Approval", async () => {
    const ownerId = await addOwner(9103);
    scriptModel([
      { callTool: captureNoteToolName, input: { text: "dinner" } },
      { say: "Kept." },
    ]);

    await forward(9103);
    await waitForSends(1);

    expect(await rowsOf(ownerId, "SELECT trust_level FROM notes")).toEqual([
      { trust_level: "untrusted" },
    ]);
    expect(await pendingApprovalsOf(ownerId)).toEqual([]);
    expect(fakeTelegram.sent[0]?.body.reply_markup).toBeUndefined();
  });

  it("asks for Approval to edit an existing owner Note from a forwarded message", async () => {
    const ownerId = await addOwner(9104);
    scriptModel([
      { callTool: captureNoteToolName, input: { text: "buy milk" } },
      { say: "Kept." },
    ]);
    await telegramWebhook(textUpdate({ fromUserId: 9104, text: "buy milk" }));
    await waitForSends(1);
    const [note] = await rowsOf<{ note_id: string }>(
      ownerId,
      "SELECT note_id FROM notes"
    );
    scriptModel([
      {
        callTool: updateNoteToolName,
        input: { noteId: note?.note_id, text: "buy milk for Ana" },
      },
      { say: "Waiting for you." },
    ]);

    await forward(9104);
    await waitForSends(3);
    await waitForPendingApprovals(ownerId, 1);

    expect(
      await rowsOf(ownerId, "SELECT text, trust_level FROM notes")
    ).toEqual([{ text: "buy milk", trust_level: "owner" }]);
    const [approval] = await pendingApprovalsOf(ownerId);
    expect(approval).toMatchObject({
      tool_name: updateNoteToolName,
      summary: 'Change Note "buy milk", new text "buy milk for Ana"',
    });
  });

  it("gives two gated calls of one Turn two rows of buttons in one message", async () => {
    const ownerId = await addOwner(9105);
    scriptModel([
      { callTool: setScheduleToolName, times: 2, input: reminderInput },
      { callTool: cancelScheduleToolName, input: { scheduleId: "s-9" } },
      { say: "Three things wait for you." },
    ]);

    await forward(9105);
    await waitForSends(2);
    await waitForPendingApprovals(ownerId, 3);

    const approvals = await pendingApprovalsOf(ownerId);
    const request = fakeTelegram.sent.at(-1);
    expect(request?.body.text).toBe(
      [
        "These wait for your Approval:",
        `1. ${reminderSummary}`,
        `2. ${reminderSummary}`,
        "3. Cancel Schedule s-9",
      ].join("\n")
    );
    expect(request?.body.reply_markup?.inline_keyboard).toEqual(
      approvals.map((approval, index) => [
        {
          text: `Approve ${index + 1}`,
          callback_data: `approve:${approval.pending_approval_id}`,
        },
        {
          text: `Reject ${index + 1}`,
          callback_data: `reject:${approval.pending_approval_id}`,
        },
      ])
    );
    expect(approvals.map((row) => row.channel_message_id)).toEqual([
      "9002",
      "9002",
      "9002",
    ]);
  });

  it("refuses stay_silent and react in a Turn with drafts", async () => {
    const ownerId = await addOwner(9106);
    scriptModel([
      { callTool: setScheduleToolName, input: reminderInput },
      { callTool: staySilentToolName, input: {} },
      { callTool: reactToolName, input: { emoji: "👍" } },
    ]);

    await forward(9106);
    await waitForSends(2);
    await waitForPendingApprovals(ownerId, 1);

    expect(
      toolResultsOfLastModelCall().split(outcomeWhileApprovalWaitsMessage)
    ).toHaveLength(3);
    expect(fakeTelegram.reactions).toEqual([]);
    expect(
      fakeTelegram.sent.at(-1)?.body.reply_markup?.inline_keyboard
    ).toHaveLength(1);
    const journal = await journalKindsOf(ownerId);
    expect(journal.map((entry) => entry.kind)).not.toContain("StayedSilent");
  });

  it("creates no Pending Approval for a call whose input holds an Operator secret, and tells the model", async () => {
    const ownerId = await addOwner(9107);
    scriptModel([
      {
        callTool: setScheduleToolName,
        input: {
          ...reminderInput,
          action: { _tag: "SendText", text: `token ${env.AI_GATEWAY_TOKEN}` },
        },
      },
      { say: "I could not do that." },
    ]);

    await forward(9107);
    await waitForSends(1);

    expect(await pendingApprovalsOf(ownerId)).toEqual([]);
    expect(await countOf(ownerId, "schedules")).toBe(0);
    expect(fakeTelegram.sent[0]?.body.reply_markup).toBeUndefined();
    expect(toolResultsSentToModel()).toContain(
      "holds a secret of the Operator"
    );
  });
});

describe("An Owner message Turn with Trust Level owner", () => {
  it("runs a change call as before, with no Pending Approval and no buttons", async () => {
    const ownerId = await addOwner(9108);
    scriptModel([
      {
        callTool: updateProfileToolName,
        input: { action: "add", kind: "fact", text: "I live in Warsaw" },
      },
      { say: "Added." },
    ]);

    await telegramWebhook(
      textUpdate({ fromUserId: 9108, text: "I live in Warsaw" })
    );
    await waitForSends(1);

    expect(await countOf(ownerId, "profile_entries")).toBe(1);
    expect(await pendingApprovalsOf(ownerId)).toEqual([]);
    expect(fakeTelegram.sent[0]?.body).toMatchObject({ text: "Added." });
    expect(fakeTelegram.sent[0]?.body.reply_markup).toBeUndefined();
  });
});
