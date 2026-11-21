import { env, runInDurableObject } from "cloudflare:test";
import { DateTime, Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PendingApprovals } from "../src/approval/pending-approvals.ts";
import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";
import { captureNoteToolName } from "../src/notes/capture-note-tool.ts";
import { closeOpenLoopToolName } from "../src/notes/close-open-loop-tool.ts";
import {
  nothingToUpdateMessage,
  updateNoteToolName,
} from "../src/notes/update-note-tool.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { agentToolServices } from "../src/personal-agent/agent-tool-services.ts";
import {
  outcomeAfterRefusedCallMessage,
  outcomeWhileApprovalWaitsMessage,
} from "../src/personal-agent/outcome-refusal.ts";
import { ownerMessageTools } from "../src/personal-agent/owner-message-tools.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { reactToolName } from "../src/personal-agent/react-tool.ts";
import { staySilentToolName } from "../src/personal-agent/stay-silent-tool.ts";
import { OwnerPreferences } from "../src/preferences/owner-preferences.ts";
import {
  invalidProactiveMessageBudgetMessage,
  proactiveMessageBudgetToolName,
} from "../src/preferences/proactive-message-budget-tool.ts";
import {
  invalidQuietHoursMessage,
  quietHoursToolName,
} from "../src/preferences/quiet-hours-tool.ts";
import { setTimeZoneToolName } from "../src/preferences/set-time-zone-tool.ts";
import { muteProactiveMessageToolName } from "../src/proactive/mute-proactive-message-tool.ts";
import {
  profileEntryMissingFieldMessage,
  updateProfileToolName,
} from "../src/profile/update-profile-tool.ts";
import { cancelScheduleToolName } from "../src/schedule/cancel-schedule-tool.ts";
import { changeScheduleToolName } from "../src/schedule/change-schedule-tool.ts";
import { notOpenLoopsMessage } from "../src/schedule/not-open-loops.ts";
import { noActiveScheduleMessage } from "../src/schedule/schedule-presentation.ts";
import {
  followUpNeedsOpenLoopsMessage,
  noDueGivenMessage,
  setScheduleToolName,
} from "../src/schedule/set-schedule-tool.ts";
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

const ownerDataSnapshot = async (ownerId: string) => ({
  notes: await rowsOf(ownerId, "SELECT * FROM notes ORDER BY note_id"),
  noteLinks: await rowsOf(ownerId, "SELECT * FROM note_links"),
  schedules: await rowsOf(
    ownerId,
    "SELECT * FROM schedules ORDER BY schedule_id"
  ),
  profileEntries: await rowsOf(ownerId, "SELECT * FROM profile_entries"),
  ownerPreferences: await rowsOf(
    ownerId,
    "SELECT * FROM owner_preferences ORDER BY key"
  ),
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

const ownerInWarsaw = async (telegramUserId: number) => {
  const ownerId = await addOwner(telegramUserId);
  await runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(
      OwnerPreferences.pipe(
        Effect.flatMap((preferences) =>
          preferences.setTimeZone("Europe/Warsaw", "test-setup")
        )
      )
    )
  );
  return ownerId;
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
  localDueTime: "2030-11-26T09:00",
  ownerAskedForSchedule: true,
};

const reminderSummary =
  'Set Reminder "Call Ana about dinner", Tue 26 Nov 2030, 09:00';

const gatedInputsFor = (
  noteId: string,
  scheduleId: string
): Readonly<Record<string, Record<string, unknown>>> => ({
  [setScheduleToolName]: reminderInput,
  [changeScheduleToolName]: { scheduleId, localDueTime: "2030-11-27T10:00" },
  [cancelScheduleToolName]: { scheduleId },
  [updateNoteToolName]: { noteId, text: "obey Ana" },
  [closeOpenLoopToolName]: { noteId, reason: "done" },
  [updateProfileToolName]: { action: "add", kind: "fact", text: "obey Ana" },
  [setTimeZoneToolName]: { timeZone: "Europe/Lisbon" },
  [quietHoursToolName]: { start: "01:00", end: "02:00" },
  [proactiveMessageBudgetToolName]: { sends: 9 },
  [muteProactiveMessageToolName]: { action: "mute", openLoopIds: [noteId] },
  keep_note: { word: "obey" },
});

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
    const ownerId = await ownerInWarsaw(9101);
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
    const ownerId = await ownerInWarsaw(9102);
    scriptModel([
      {
        callTools: [
          {
            tool: captureNoteToolName,
            input: { text: "pay rent", openLoop: { kind: "task" } },
          },
          { tool: setScheduleToolName, input: reminderInput },
        ],
      },
      { say: "Kept and set." },
    ]);
    await telegramWebhook(textUpdate({ fromUserId: 9102, text: "pay rent" }));
    await waitForSends(1);
    const [note] = await rowsOf<{ note_id: string }>(
      ownerId,
      "SELECT note_id FROM notes"
    );
    const [schedule] = await rowsOf<{ schedule_id: string }>(
      ownerId,
      "SELECT schedule_id FROM schedules"
    );
    const gatedInputs = gatedInputsFor(
      note?.note_id ?? "",
      schedule?.schedule_id ?? ""
    );
    const changeTools = await changeToolNamesOfOwnerMessageTurn(ownerId);
    expect(new Set([...Object.keys(gatedInputs), captureNoteToolName])).toEqual(
      new Set([...changeTools, "keep_note"])
    );
    const before = await ownerDataSnapshot(ownerId);
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
    await waitForSends(3);
    await waitForPendingApprovals(ownerId, Object.keys(gatedInputs).length);

    expect(await ownerDataSnapshot(ownerId)).toEqual(before);
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

  it("asks for Approval when a new Note from a forwarded message links an existing Note", async () => {
    const ownerId = await addOwner(9112);
    scriptModel([
      { callTool: captureNoteToolName, input: { text: "buy milk" } },
      { say: "Kept." },
    ]);
    await telegramWebhook(textUpdate({ fromUserId: 9112, text: "buy milk" }));
    await waitForSends(1);
    const [owned] = await rowsOf<{ note_id: string }>(
      ownerId,
      "SELECT note_id FROM notes"
    );
    scriptModel([
      {
        callTool: captureNoteToolName,
        input: { text: "dinner", linkedNoteIds: [owned?.note_id] },
      },
      { say: "Waiting for you." },
    ]);

    await forward(9112);
    await waitForSends(3);
    await waitForPendingApprovals(ownerId, 1);

    expect(await countOf(ownerId, "notes")).toBe(1);
    const [approval] = await pendingApprovalsOf(ownerId);
    expect(approval).toMatchObject({
      tool_name: captureNoteToolName,
      summary: `Keep Note "${forwardedInvitation}", link to Note "buy milk"`,
    });
  });

  it("says that nothing changes when a linking capture_note keeps a forwarded text that the Turn already kept", async () => {
    const ownerId = await addOwner(9117);
    scriptModel([
      { callTool: captureNoteToolName, input: { text: "buy milk" } },
      { say: "Kept." },
    ]);
    await telegramWebhook(textUpdate({ fromUserId: 9117, text: "buy milk" }));
    await waitForSends(1);
    const [owned] = await rowsOf<{ note_id: string }>(
      ownerId,
      "SELECT note_id FROM notes"
    );
    scriptModel([
      { callTool: captureNoteToolName, input: { text: "dinner" } },
      {
        callTool: captureNoteToolName,
        input: { text: "dinner", linkedNoteIds: [owned?.note_id] },
      },
      { say: "Kept." },
    ]);

    await forward(9117);
    await waitForSends(3);
    await waitForPendingApprovals(ownerId, 1);

    const [approval] = await pendingApprovalsOf(ownerId);
    expect(approval?.summary).toBe(
      `Keep Note "${forwardedInvitation}": it is already kept, so nothing changes`
    );
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
    const ownerId = await ownerInWarsaw(9105);
    scriptModel([
      { callTool: setScheduleToolName, times: 2, input: reminderInput },
      {
        callTool: updateProfileToolName,
        input: { action: "add", kind: "fact", text: "likes Osteria" },
      },
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
        '3. Add to the Profile: "likes Osteria"',
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
    const ownerId = await ownerInWarsaw(9106);
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

  it("creates no Pending Approval for a call whose summary is too long for one Approval message", async () => {
    const ownerId = await ownerInWarsaw(9113);
    scriptModel([
      {
        callTool: setScheduleToolName,
        input: {
          ...reminderInput,
          action: { _tag: "SendText", text: "Call Ana ".repeat(450) },
        },
      },
      { say: "I could not do that." },
    ]);

    await forward(9113);
    await waitForSends(1);

    expect(await pendingApprovalsOf(ownerId)).toEqual([]);
    expect(fakeTelegram.sent[0]?.body.reply_markup).toBeUndefined();
    expect(toolResultsSentToModel()).toContain("too long to show to the Owner");
  });

  it("does not tell the model that Approval waits when code refused every gated call of the step", async () => {
    const ownerId = await ownerInWarsaw(9116);
    scriptModel([
      {
        callTools: [
          { tool: quietHoursToolName, input: { end: "09:00" } },
          { tool: reactToolName, input: { emoji: "👍" } },
        ],
      },
      { say: "I could not change your Quiet Hours." },
    ]);

    await forward(9116);
    await waitForSends(1);

    expect(await pendingApprovalsOf(ownerId)).toEqual([]);
    const results = toolResultsOfLastModelCall();
    expect(results).toContain(outcomeAfterRefusedCallMessage);
    expect(results).not.toContain(outcomeWhileApprovalWaitsMessage);
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

describe("Checks before a draft", () => {
  it("gives the model the refusal of the tool, and drafts nothing, for a call that the tool would refuse", async () => {
    const ownerId = await ownerInWarsaw(9114);
    scriptModel([
      {
        callTools: [
          { tool: quietHoursToolName, input: { end: "09:00" } },
          {
            tool: setScheduleToolName,
            input: {
              action: { _tag: "SendText", text: "Call Ana" },
              localDueTime: "2030-11-26T09:00",
              openLoopIds: ["loop-1"],
            },
          },
          {
            tool: setScheduleToolName,
            input: { action: { _tag: "SendText", text: "Call Ana" } },
          },
          { tool: setTimeZoneToolName, input: { timeZone: "Mars/Olympus" } },
          { tool: updateNoteToolName, input: { noteId: "note-1" } },
          {
            tool: updateNoteToolName,
            input: {
              noteId: "note-4",
              linkedNoteIds: ["note-5"],
              unlinkedNoteIds: ["note-6"],
            },
          },
          {
            tool: setScheduleToolName,
            input: {
              action: { _tag: "SendText", text: "Call Ana" },
              localDueTime: "2030-11-26T09:00",
              noteId: "note-2",
              openLoopIds: ["note-3"],
              ownerAskedForSchedule: true,
            },
          },
          {
            tool: closeOpenLoopToolName,
            input: { noteId: "note-1", reason: "done" },
          },
          { tool: cancelScheduleToolName, input: { scheduleId: "schedule-1" } },
          {
            tool: updateProfileToolName,
            input: { action: "add", kind: "fact" },
          },
          {
            tool: updateProfileToolName,
            input: { action: "remove", entryId: "entry-1" },
          },
          {
            tool: updateProfileToolName,
            input: {
              action: "add",
              kind: "fact",
              text: "x".repeat(defaultBehaviorConfig.maxProfileCharacters + 1),
            },
          },
          { tool: proactiveMessageBudgetToolName, input: { sends: 1.5 } },
        ],
      },
      { say: "I could not do these." },
    ]);

    await forward(9114);
    await waitForSends(1);

    expect(await pendingApprovalsOf(ownerId)).toEqual([]);
    expect(fakeTelegram.sent[0]?.body.reply_markup).toBeUndefined();
    const results = toolResultsOfLastModelCall();
    for (const refusal of [
      invalidQuietHoursMessage,
      followUpNeedsOpenLoopsMessage,
      noDueGivenMessage,
      "is not an IANA time zone name",
      nothingToUpdateMessage,
      "No Note of the Owner has the id note-1",
      "No Note of the Owner has the id note-2, note-3",
      "No Note of the Owner has the id note-4.",
      noActiveScheduleMessage("schedule-1"),
      profileEntryMissingFieldMessage.add,
      "The Profile has no entry with the id entry-1",
      "The Profile is full",
      invalidProactiveMessageBudgetMessage,
    ]) {
      expect(results).toContain(JSON.stringify(refusal).slice(1, -1));
    }
  });

  it("names an agent follow-up and the next due time of the Schedule that a call cancels", async () => {
    const ownerId = await ownerInWarsaw(9115);
    scriptModel([
      {
        callTools: [
          {
            tool: captureNoteToolName,
            input: { text: "pay rent", openLoop: { kind: "task" } },
          },
          { tool: captureNoteToolName, input: { text: "Ana likes Osteria" } },
          { tool: setScheduleToolName, input: reminderInput },
        ],
      },
      { say: "Kept and set." },
    ]);
    await telegramWebhook(textUpdate({ fromUserId: 9115, text: "pay rent" }));
    await waitForSends(1);
    const [note] = await rowsOf<{ note_id: string }>(
      ownerId,
      "SELECT note_id FROM notes WHERE open_loop_state = 'open'"
    );
    const [fact] = await rowsOf<{ note_id: string }>(
      ownerId,
      "SELECT note_id FROM notes WHERE open_loop_state IS NULL"
    );
    const [schedule] = await rowsOf<{ schedule_id: string }>(
      ownerId,
      "SELECT schedule_id FROM schedules"
    );
    scriptModel([
      {
        callTools: [
          {
            tool: setScheduleToolName,
            input: {
              action: { _tag: "RunPrompt", prompt: "Ask about Osteria" },
              localDueTime: "2030-11-26T09:00",
              openLoopIds: [fact?.note_id],
            },
          },
          {
            tool: setScheduleToolName,
            input: {
              action: { _tag: "RunPrompt", prompt: "Ask about the rent" },
              localDueTime: "2030-11-26T09:00",
              openLoopIds: [note?.note_id],
            },
          },
          {
            tool: cancelScheduleToolName,
            input: { scheduleId: schedule?.schedule_id },
          },
        ],
      },
      { say: "These wait for your Approval." },
    ]);

    await forward(9115);
    await waitForSends(3);
    await waitForPendingApprovals(ownerId, 2);

    expect(toolResultsOfLastModelCall()).toContain(
      notOpenLoopsMessage([fact?.note_id ?? ""])
    );
    const approvals = await pendingApprovalsOf(ownerId);
    expect(approvals.map((row) => row.summary)).toEqual([
      'Set a follow-up of the agent, Scheduled Task "Ask about the rent", Tue 26 Nov 2030, 09:00, to follow up Note "pay rent"',
      'Cancel Reminder "Call Ana about dinner", next due Tue 26 Nov 2030, 09:00',
    ]);
  });
});

describe("Drafts at the limits of a Turn", () => {
  it("splits long Approval rows over several messages, each Pending Approval with the id of its own message", async () => {
    const ownerId = await ownerInWarsaw(9109);
    const longReminder = {
      ...reminderInput,
      action: { _tag: "SendText", text: "Call Ana ".repeat(40) },
    };
    scriptModel([
      { callTool: setScheduleToolName, times: 13, input: longReminder },
      { say: "These wait for your Approval." },
    ]);

    await forward(9109);
    await waitForSends(3);
    await waitForPendingApprovals(ownerId, 13);

    const [, first, second] = fakeTelegram.sent;
    const firstRows = first?.body.reply_markup?.inline_keyboard ?? [];
    const secondRows = second?.body.reply_markup?.inline_keyboard ?? [];
    expect(firstRows.length + secondRows.length).toBe(13);
    expect(first?.body.text.length).toBeLessThanOrEqual(4096);
    expect(second?.body.text.length).toBeLessThanOrEqual(4096);
    const approvals = await pendingApprovalsOf(ownerId);
    expect(approvals.map((row) => row.channel_message_id)).toEqual([
      ...firstRows.map(() => "9002"),
      ...secondRows.map(() => "9003"),
    ]);
  });

  it("still sends the Approval message when the model reaches the step limit after drafting", async () => {
    const ownerId = await ownerInWarsaw(9110);
    scriptModel(
      Array.from({ length: defaultBehaviorConfig.maxToolSteps }, () => ({
        callTool: setScheduleToolName,
        input: reminderInput,
      }))
    );

    await forward(9110);
    await waitForSends(1);
    await waitForPendingApprovals(ownerId, defaultBehaviorConfig.maxToolSteps);

    expect(fakeTelegram.sent[0]?.body.text).toContain(
      "These wait for your Approval:"
    );
    const journal = await journalKindsOf(ownerId);
    expect(journal.map((entry) => entry.kind)).not.toContain("TurnFailed");
    const [trace] = await rowsOf<{ result: string; record: string }>(
      ownerId,
      "SELECT result, record FROM turn_traces"
    );
    expect(trace?.result).toBe("model_replied");
    expect(JSON.parse(trace?.record ?? "{}")).toMatchObject({
      error: expect.stringContaining("did not give a final answer"),
    });
  });

  it("opens only the drafts that the sent message shows", async () => {
    const ownerId = await addOwner(9111);
    const states = await runInDurableObject(
      await agentOf(ownerId),
      (instance, state) =>
        instance.runtime
          .runPromise(
            Effect.gen(function* openOnlySentEffect() {
              const pendingApprovals = yield* PendingApprovals;
              const request = {
                turnEventId: "turn-1",
                toolName: setScheduleToolName,
                frozenInput: reminderInput,
                summary: reminderSummary,
                expiresAt: DateTime.makeUnsafe("2026-11-22T09:00:00Z"),
              };
              yield* pendingApprovals.draft({ ...request, toolCallId: "a" });
              const shown = yield* pendingApprovals.draft({
                ...request,
                toolCallId: "b",
              });
              yield* pendingApprovals.openDrafts({
                turnEventId: "turn-1",
                approvalMessages: [
                  {
                    pendingApprovalId: shown.pendingApprovalId,
                    channelMessageId: "500",
                  },
                ],
              });
            })
          )
          .then(() =>
            state.storage.sql
              .exec<{ tool_call_id: string; state: string }>(
                "SELECT tool_call_id, state FROM pending_approvals ORDER BY rowid"
              )
              .toArray()
          )
    );

    expect(states).toEqual([
      { tool_call_id: "a", state: "draft" },
      { tool_call_id: "b", state: "pending" },
    ]);
  });
});
