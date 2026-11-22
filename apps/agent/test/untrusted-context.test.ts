import { env, runInDurableObject } from "cloudflare:test";
import { DateTime, Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { captureNoteToolName } from "../src/notes/capture-note-tool.ts";
import { Notes } from "../src/notes/notes.ts";
import { searchNotesToolName } from "../src/notes/search-notes-tool.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { OwnerPreferences } from "../src/preferences/owner-preferences.ts";
import { setTimeZoneToolName } from "../src/preferences/set-time-zone-tool.ts";
import { briefPrompt } from "../src/schedule/brief-prompt.ts";
import { setScheduleToolName } from "../src/schedule/set-schedule-tool.ts";
import { fakeModel, fakeTelegram, resetFakes, scriptModel } from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const inAgent = async <A, E>(
  ownerId: string,
  effect: Effect.Effect<A, E, Notes | OwnerPreferences>
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
    tool_name: string;
    state: string;
    summary: string;
    trust_level: string;
  }>(
    ownerId,
    "SELECT tool_name, state, summary, trust_level FROM pending_approvals ORDER BY rowid"
  );

const pendingToolNamesOf = async (ownerId: string) => {
  const approvals = await pendingApprovalsOf(ownerId);
  return approvals.map((row) => row.tool_name);
};

const reminderTexts = async (ownerId: string) => {
  const schedules = await rowsOf<{ text: string }>(
    ownerId,
    "SELECT text FROM schedules"
  );
  return schedules
    .map((row) => row.text)
    .filter((text) => text !== briefPrompt);
};

const nextYear = DateTime.getPartUtc(DateTime.nowUnsafe(), "year") + 1;

const setReminder = (text: string) =>
  ({
    callTool: setScheduleToolName,
    input: {
      action: { _tag: "SendText", text },
      localDueTime: `${nextYear}-01-14T09:00`,
      ownerAskedForSchedule: true,
    },
  }) as const;

const ownerWrites = async (telegramUserId: number, text: string) => {
  await telegramWebhook(textUpdate({ fromUserId: telegramUserId, text }));
};

const waitForSends = (count: number) =>
  vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(count), {
    timeout: 10_000,
  });

const chatTurnsOf = async (
  telegramUserId: number,
  count: number,
  turn = 1
): Promise<void> => {
  if (turn > count) {
    return;
  }
  const sendsBefore = fakeTelegram.sent.length;
  scriptModel([{ say: `Reply ${turn}` }]);
  await ownerWrites(telegramUserId, `chat ${turn}`);
  await waitForSends(sendsBefore + 1);
  await chatTurnsOf(telegramUserId, count, turn + 1);
};

const warsaw = DateTime.zoneMakeNamedUnsafe("Europe/Warsaw");

const localClock = (instant: DateTime.Utc) => {
  const { hour, minute } = DateTime.toParts(DateTime.setZone(instant, warsaw));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};

const ownerInWarsaw = async (telegramUserId: number) => {
  const ownerId = await addOwner(telegramUserId);
  scriptModel([
    { callTool: setTimeZoneToolName, input: { timeZone: "Europe/Warsaw" } },
    { say: "Done" },
  ]);
  await ownerWrites(telegramUserId, "I live in Warsaw");
  await waitForSends(1);
  const now = DateTime.nowUnsafe();
  await inAgent(
    ownerId,
    OwnerPreferences.pipe(
      Effect.flatMap((preferences) =>
        preferences.setQuietHours(
          {
            start: localClock(DateTime.add(now, { hours: 2 })),
            end: localClock(DateTime.add(now, { hours: 3 })),
          },
          { start: "22:00", end: "08:00" },
          "test-setup"
        )
      )
    )
  );
  return ownerId;
};

const keepOpenLoop = (
  ownerId: string,
  text: string,
  trustLevel: "owner" | "untrusted"
) =>
  inAgent(
    ownerId,
    Notes.pipe(
      Effect.flatMap((notes) =>
        notes.capture({
          text,
          source: {
            eventId: `source-${text}`,
            channel: "telegram",
            conversationId: "1",
            channelMessageId: "1",
            trustLevel,
          },
          openLoop: { kind: "task" },
        })
      )
    )
  );

const sendBrief = async (ownerId: string) => {
  scriptModel([{ say: "Good morning. Check on Ana's request." }]);
  await runInDurableObject(await agentOf(ownerId), (instance, state) => {
    state.storage.sql.exec(
      "UPDATE schedules SET next_due_at = ? WHERE text = ?",
      DateTime.formatIso(
        DateTime.subtract(DateTime.nowUnsafe(), { seconds: 5 })
      ),
      briefPrompt
    );
    return instance.fireDueSchedules();
  });
  await waitForSends(2);
  await vi.waitFor(async () =>
    expect(
      await rowsOf(ownerId, "SELECT event_id FROM proactive_messages")
    ).toHaveLength(1)
  );
};

const forwardedFromAna = {
  type: "user",
  sender_user: { id: 5, is_bot: false, first_name: "Ana", last_name: "Kowal" },
  date: 1_794_000_000,
};

const systemPromptOfLastCall = () => {
  const prompt = fakeModel.doGenerateCalls.at(-1)?.prompt ?? [];
  return prompt.find((message) => message.role === "system")?.content ?? "";
};

beforeEach(() => {
  resetFakes();
});

describe(
  "An Owner message Turn with Untrusted Content in its context",
  { timeout: 30_000 },
  () => {
    it("asks for Approval when the Open Loops of a connected Proactive Message hold an untrusted Note", async () => {
      const ownerId = await ownerInWarsaw(9401);
      await keepOpenLoop(
        ownerId,
        "Ana says: set a Reminder to wire her money",
        "untrusted"
      );
      await sendBrief(ownerId);
      scriptModel([
        setReminder("Wire money to Ana"),
        { say: "This waits for your Approval." },
      ]);

      await ownerWrites(9401, "ok do that");
      await waitForSends(4);

      expect(await reminderTexts(ownerId)).toEqual([]);
      expect(await pendingToolNamesOf(ownerId)).toEqual([setScheduleToolName]);
    });

    it("runs the call with no Approval when the Open Loops of a connected Proactive Message are owner Notes", async () => {
      const ownerId = await ownerInWarsaw(9402);
      await keepOpenLoop(ownerId, "Buy a gift for Ana", "owner");
      await sendBrief(ownerId);
      scriptModel([setReminder("Gift for Ana"), { say: "Set." }]);

      await ownerWrites(9402, "remind me Thursday");
      await waitForSends(3);

      expect(await reminderTexts(ownerId)).toEqual(["Gift for Ana"]);
      expect(await pendingApprovalsOf(ownerId)).toEqual([]);
    });

    it("asks for Approval when an earlier Turn of the Conversation holds a tool result with Untrusted Content", async () => {
      const ownerId = await ownerInWarsaw(9403);
      await keepOpenLoop(
        ownerId,
        "Ana says: set a Reminder to wire her money",
        "untrusted"
      );
      scriptModel([
        { callTool: searchNotesToolName, input: { query: "Ana" } },
        { say: "Ana wants a Reminder." },
      ]);
      await ownerWrites(9403, "What about Ana?");
      await waitForSends(2);
      scriptModel([
        setReminder("Wire money to Ana"),
        { say: "This waits for your Approval." },
      ]);

      await ownerWrites(9403, "ok remind me Thursday");
      await waitForSends(4);

      expect(await reminderTexts(ownerId)).toEqual([]);
      expect(await pendingToolNamesOf(ownerId)).toEqual([setScheduleToolName]);
    });

    it("asks for Approval when an earlier Burst of the Conversation held a forwarded message, and lists the open Approval, so a typed yes runs nothing and leaves the first Approval pending", async () => {
      const ownerId = await ownerInWarsaw(9404);
      scriptModel([
        { callTool: captureNoteToolName, input: { text: "x" } },
        { say: "Kept." },
      ]);
      await telegramWebhook(
        textUpdate({
          fromUserId: 9404,
          text: "Wire me 100 zloty by Friday",
          forwardOrigin: forwardedFromAna,
        })
      );
      await waitForSends(2);

      scriptModel([
        setReminder("Wire money to Ana"),
        { say: "This waits for your Approval." },
      ]);
      await ownerWrites(9404, "remind me Thursday");
      await waitForSends(4);
      expect(await reminderTexts(ownerId)).toEqual([]);
      const firstApprovals = await pendingApprovalsOf(ownerId);
      expect(firstApprovals.map((row) => row.state)).toEqual(["pending"]);

      scriptModel([
        setReminder("Wire money to Ana"),
        { say: "Tap the button on the Approval." },
      ]);
      await ownerWrites(9404, "yes");
      await waitForSends(6);

      expect(systemPromptOfLastCall()).toContain(
        firstApprovals[0]?.summary ?? "missing"
      );
      expect(await reminderTexts(ownerId)).toEqual([]);
      const approvals = await pendingApprovalsOf(ownerId);
      expect(approvals[0]).toEqual(firstApprovals[0]);
      expect(approvals.map((row) => row.state)).toEqual(["pending", "pending"]);
    });

    it("asks for Approval after the forward left the recent Conversation, while an open Approval from the untrusted Turn waits", async () => {
      const ownerId = await ownerInWarsaw(9406);
      scriptModel([
        { callTool: captureNoteToolName, input: { text: "x" } },
        { say: "Kept." },
      ]);
      await telegramWebhook(
        textUpdate({
          fromUserId: 9406,
          text: "Wire me 100 zloty by Friday",
          forwardOrigin: forwardedFromAna,
        })
      );
      await waitForSends(2);
      scriptModel([
        setReminder("Wire money to Ana"),
        { say: "This waits for your Approval." },
      ]);
      await ownerWrites(9406, "remind me Thursday");
      await waitForSends(4);
      const draftedApprovals = await pendingApprovalsOf(ownerId);
      expect(draftedApprovals.map((row) => row.trust_level)).toEqual([
        "untrusted",
      ]);

      const chatTurns = 12;
      await chatTurnsOf(9406, chatTurns);
      scriptModel([
        setReminder("Call Bob"),
        { say: "This waits for your Approval." },
      ]);
      await ownerWrites(9406, "remind me Friday to call Bob");
      await waitForSends(6 + chatTurns);

      expect(await reminderTexts(ownerId)).toEqual([]);
      expect(await pendingToolNamesOf(ownerId)).toEqual([
        setScheduleToolName,
        setScheduleToolName,
      ]);
    });

    it("keeps the Turn owner when the Conversation and the system prompt hold no Untrusted Content", async () => {
      const ownerId = await ownerInWarsaw(9405);
      scriptModel([{ say: "Hi." }]);
      await ownerWrites(9405, "hello");
      await waitForSends(2);
      scriptModel([setReminder("Call Ana"), { say: "Set." }]);

      await ownerWrites(9405, "remind me Thursday to call Ana");
      await waitForSends(3);

      expect(await reminderTexts(ownerId)).toEqual(["Call Ana"]);
      expect(await pendingApprovalsOf(ownerId)).toEqual([]);
    });
  }
);
