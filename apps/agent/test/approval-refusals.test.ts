import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { closeOpenLoopToolName } from "../src/notes/close-open-loop-tool.ts";
import { updateNoteToolName } from "../src/notes/update-note-tool.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { proactiveMessageBudgetToolName } from "../src/preferences/proactive-message-budget-tool.ts";
import { quietHoursToolName } from "../src/preferences/quiet-hours-tool.ts";
import { setTimeZoneToolName } from "../src/preferences/set-time-zone-tool.ts";
import { updateProfileToolName } from "../src/profile/update-profile-tool.ts";
import { cancelScheduleToolName } from "../src/schedule/cancel-schedule-tool.ts";
import { setScheduleToolName } from "../src/schedule/set-schedule-tool.ts";
import { fakeModel, fakeTelegram, resetFakes, scriptModel } from "./fakes.ts";
import {
  closeSeededOpenLoop,
  ownerInWarsaw,
  seedNoteAndReminder,
} from "./owner-with-data.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

const forwardedFromAna = {
  type: "user",
  sender_user: { id: 5, is_bot: false, first_name: "Ana", last_name: "Kowal" },
  date: 1_794_000_000,
};

const forward = (userId: number) =>
  telegramWebhook(
    textUpdate({
      fromUserId: userId,
      text: "Dinner on Friday",
      forwardOrigin: forwardedFromAna,
    })
  );

const pendingApprovalCount = async (ownerId: string) =>
  runInDurableObject(
    await personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId)),
    (_, state) =>
      state.storage.sql
        .exec<{ count: number }>(
          "SELECT count(*) AS count FROM pending_approvals"
        )
        .one().count
  );

const toolResultsSentToModel = () =>
  JSON.stringify(
    fakeModel.doGenerateCalls.flatMap((call) =>
      call.prompt.filter((message) => message.role === "tool")
    )
  );

const refusedWith = async (
  { userId, ownerId }: { readonly userId: number; readonly ownerId: string },
  call: { readonly tool: string; readonly input: Record<string, unknown> },
  reason: string
) => {
  scriptModel([
    { callTool: call.tool, input: call.input },
    { say: "I could not do that." },
  ]);

  await forward(userId);
  await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1), {
    timeout: 10_000,
  });

  expect(await pendingApprovalCount(ownerId)).toBe(0);
  expect(fakeTelegram.sent[0]?.body.reply_markup).toBeUndefined();
  expect(toolResultsSentToModel()).toContain(reason);
};

beforeEach(() => {
  resetFakes();
});

describe("A call that its tool would refuse", () => {
  it("gets no Pending Approval for a Schedule when the time zone of the Owner is not known", async () => {
    const ownerId = await addOwner(9301);

    await refusedWith(
      { userId: 9301, ownerId },
      {
        tool: setScheduleToolName,
        input: {
          action: { _tag: "SendText", text: "Call Ana" },
          localDueTime: "2099-11-26T09:00",
          ownerAskedForSchedule: true,
        },
      },
      "time zone of the Owner is not known"
    );
  });

  it("gets no Pending Approval for a Schedule with no due time", async () => {
    const ownerId = await ownerInWarsaw(9302);

    await refusedWith(
      { userId: 9302, ownerId },
      {
        tool: setScheduleToolName,
        input: {
          action: { _tag: "SendText", text: "Call Ana" },
          ownerAskedForSchedule: true,
        },
      },
      "Neither a local due time nor a repeat rule was given"
    );
  });

  it("gets no Pending Approval to cancel an unknown Schedule", async () => {
    const ownerId = await ownerInWarsaw(9303);

    await refusedWith(
      { userId: 9303, ownerId },
      { tool: cancelScheduleToolName, input: { scheduleId: "unknown" } },
      "No active Schedule has the id unknown"
    );
  });

  it("gets no Pending Approval to change an unknown Note", async () => {
    const ownerId = await ownerInWarsaw(9304);

    await refusedWith(
      { userId: 9304, ownerId },
      {
        tool: updateNoteToolName,
        input: { noteId: "unknown", text: "new text" },
      },
      "No Note of the Owner has the id unknown"
    );
  });

  it("gets no Pending Approval for a time zone that is not an IANA name", async () => {
    const ownerId = await addOwner(9305);

    await refusedWith(
      { userId: 9305, ownerId },
      { tool: setTimeZoneToolName, input: { timeZone: "Not/AZone" } },
      "is not an IANA time zone name"
    );
  });

  it("gets no Pending Approval for Quiet Hours with a start and no end", async () => {
    const ownerId = await addOwner(9306);

    await refusedWith(
      { userId: 9306, ownerId },
      { tool: quietHoursToolName, input: { start: "22:00" } },
      "Give both start and end as HH:mm"
    );
  });

  it("gets no Pending Approval for a Budget that is not a whole number in range", async () => {
    const ownerId = await addOwner(9307);

    await refusedWith(
      { userId: 9307, ownerId },
      { tool: proactiveMessageBudgetToolName, input: { sends: 2.5 } },
      "Give sends as a whole number"
    );
  });

  it("gets no Pending Approval to remove an unknown Profile entry", async () => {
    const ownerId = await addOwner(9308);

    await refusedWith(
      { userId: 9308, ownerId },
      {
        tool: updateProfileToolName,
        input: { action: "remove", entryId: "x" },
      },
      "The Profile has no entry with the id x"
    );
  });

  it("gets no Pending Approval to close the Open Loop of a Note that has none", async () => {
    const ownerId = await ownerInWarsaw(9309);
    const { noteId } = await seedNoteAndReminder(ownerId, {
      withOpenLoop: false,
    });

    await refusedWith(
      { userId: 9309, ownerId },
      { tool: closeOpenLoopToolName, input: { noteId, reason: "done" } },
      "has no open Open Loop"
    );
  });

  it("gets no Pending Approval to close an Open Loop that an earlier Event closed", async () => {
    const ownerId = await ownerInWarsaw(9310);
    const { noteId } = await seedNoteAndReminder(ownerId);
    await closeSeededOpenLoop(ownerId, noteId);

    await refusedWith(
      { userId: 9310, ownerId },
      { tool: closeOpenLoopToolName, input: { noteId, reason: "done" } },
      "has no open Open Loop"
    );
  });
});
