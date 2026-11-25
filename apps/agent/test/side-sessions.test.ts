import {
  abortAllDurableObjects,
  env,
  runInDurableObject,
} from "cloudflare:test";
import { DateTime, Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Journal } from "../src/journal/journal.ts";
import { closeOpenLoopToolName } from "../src/notes/close-open-loop-tool.ts";
import { listOpenLoopsToolName } from "../src/notes/list-open-loops-tool.ts";
import { Notes } from "../src/notes/notes.ts";
import { searchNotesToolName } from "../src/notes/search-notes-tool.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import {
  ownerContextLabel,
  runBlockEndLabel,
  runBlockLabel,
} from "../src/personal-agent/context-labels.ts";
import { storeDueScheduleEvents } from "../src/personal-agent/due-schedule-events.ts";
import type { Inbox } from "../src/personal-agent/inbox.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { OwnerPreferences } from "../src/preferences/owner-preferences.ts";
import { setTimeZoneToolName } from "../src/preferences/set-time-zone-tool.ts";
import { briefPrompt } from "../src/schedule/brief-prompt.ts";
import type { ScheduleAction } from "../src/schedule/schedule-action.ts";
import { Schedules } from "../src/schedule/schedules.ts";
import { setScheduleToolName } from "../src/schedule/set-schedule-tool.ts";
import { localTimeOf } from "../src/time/local-time.ts";
import {
  failModel,
  fakeModel,
  fakeTelegram,
  lastUserTextOf,
  resetFakes,
  scriptModel,
  systemTextOf,
} from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

type ModelCall = (typeof fakeModel.doGenerateCalls)[number];

interface StoredRow extends Record<string, SqlStorageValue> {
  readonly sequence: number;
  readonly event_id: string;
  readonly kind: string;
  readonly message: string;
}

const warsaw = DateTime.zoneMakeNamedUnsafe("Europe/Warsaw");

const prompt = "List my open tasks";

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const inAgent = async <A, E>(
  ownerId: string,
  effect: Effect.Effect<
    A,
    E,
    Inbox | Journal | Notes | OwnerPreferences | Schedules
  >
) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(effect)
  );

const rowsOf = async <Row extends Record<string, SqlStorageValue>>(
  ownerId: string,
  query: string,
  ...bindings: readonly SqlStorageValue[]
) =>
  runInDurableObject(await agentOf(ownerId), (_, state) =>
    state.storage.sql.exec<Row>(query, ...bindings).toArray()
  );

const conversationRowsAfter = (ownerId: string, sequence: number) =>
  rowsOf<StoredRow>(
    ownerId,
    "SELECT sequence, event_id, kind, message FROM conversation_messages WHERE sequence > ? ORDER BY sequence",
    sequence
  );

const lastSequenceOf = async (ownerId: string) => {
  const [row] = await rowsOf<{ sequence: number | null }>(
    ownerId,
    "SELECT MAX(sequence) AS sequence FROM conversation_messages"
  );
  return row?.sequence ?? 0;
};

const waitForSends = (count: number) =>
  vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(count), {
    timeout: 10_000,
  });

const waitForNoPendingEvent = (ownerId: string) =>
  vi.waitFor(
    async () =>
      expect(
        await rowsOf(
          ownerId,
          "SELECT event_id FROM inbox_events WHERE state = 'pending'"
        )
      ).toEqual([]),
    { timeout: 10_000 }
  );

const ownerSays = async (
  telegramUserId: number,
  text: string,
  sends: number
) => {
  await telegramWebhook(textUpdate({ fromUserId: telegramUserId, text }));
  await waitForSends(sends);
};

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
  await ownerSays(telegramUserId, "I live in Warsaw", 1);
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
  await waitForNoPendingEvent(ownerId);
  return ownerId;
};

const seedOwnerSchedule = (ownerId: string, action: ScheduleAction) =>
  inAgent(
    ownerId,
    Effect.gen(function* seedEffect() {
      const schedules = yield* Schedules;
      const now = yield* DateTime.now;
      const { schedule } = yield* schedules.set({
        action,
        setBy: "owner",
        dueAt: DateTime.subtract(now, { seconds: 5 }),
        sourceEventId: `seed-${action._tag}`,
      });
      return schedule;
    })
  );

const keepNote = (
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
          openLoop: trustLevel === "owner" ? { kind: "task" } : undefined,
        })
      ),
      Effect.map(({ note }) => note.noteId)
    )
  );

const keepOpenLoop = (ownerId: string, text: string) =>
  keepNote(ownerId, text, "owner");

const fireTheAlarm = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.fireDueSchedules()
  );

const makeBriefDue = async (ownerId: string) => {
  const dueAt = DateTime.subtract(DateTime.nowUnsafe(), { seconds: 5 });
  await runInDurableObject(await agentOf(ownerId), (_, state) => {
    state.storage.sql.exec(
      "UPDATE schedules SET next_due_at = ? WHERE text = ?",
      DateTime.formatIso(dueAt),
      briefPrompt
    );
  });
  return dueAt;
};

const lastCall = (): ModelCall => {
  const call = fakeModel.doGenerateCalls.at(-1);
  if (call === undefined) {
    throw new Error("No model call was made");
  }
  return call;
};

const messagesOf = (call: ModelCall) =>
  call.prompt.filter((message) => message.role !== "system");

const bytesOf = (value: unknown) => JSON.stringify(value);

const messageOf = (row: StoredRow | undefined) =>
  JSON.parse(row?.message ?? "{}") as { role: string; content: unknown };

const nextYear = DateTime.getPartUtc(DateTime.nowUnsafe(), "year") + 1;

beforeEach(() => {
  resetFakes();
});

describe("The Write-back of a Side Session", { timeout: 30_000 }, () => {
  it("adds exactly one assistant message to the Conversation for a Scheduled Task Turn, a Brief, and a Reminder", async () => {
    const ownerId = await ownerInWarsaw(9901);
    const closedId = await keepOpenLoop(ownerId, "Return the library book");
    const followedId = await keepOpenLoop(ownerId, "Book the dentist");
    const before = await lastSequenceOf(ownerId);

    const task = await seedOwnerSchedule(ownerId, {
      _tag: "RunPrompt",
      prompt,
    });
    await fireTheAlarm(ownerId);
    await waitForSends(2);

    const briefDueAt = await makeBriefDue(ownerId);
    scriptModel([
      { callTool: listOpenLoopsToolName, input: {} },
      {
        callTools: [
          {
            tool: closeOpenLoopToolName,
            input: { noteId: closedId, reason: "done" },
          },
          {
            tool: setScheduleToolName,
            input: {
              action: { _tag: "RunPrompt", prompt: "Ask about the dentist" },
              localDueTime: `${nextYear}-01-14T09:00`,
              openLoopIds: [followedId],
            },
          },
        ],
      },
      { say: "Good morning. The book is back." },
    ]);
    await fireTheAlarm(ownerId);
    await waitForSends(3);

    const reminder = await seedOwnerSchedule(ownerId, {
      _tag: "SendText",
      text: "Water the plants",
    });
    await fireTheAlarm(ownerId);
    await waitForSends(4);
    await waitForNoPendingEvent(ownerId);

    const [followUp] = await rowsOf<{ next_due_at: string }>(
      ownerId,
      "SELECT next_due_at FROM schedules WHERE text = ?",
      "Ask about the dentist"
    );
    const followUpDue = localTimeOf(
      DateTime.makeUnsafe(followUp?.next_due_at ?? ""),
      warsaw
    );
    const rows = await conversationRowsAfter(ownerId, before);
    expect(rows.map((row) => row.kind)).toEqual([
      "write_back",
      "write_back",
      "write_back",
    ]);
    expect(new Set(rows.map((row) => row.event_id)).size).toBe(3);
    expect(rows.map(messageOf)).toEqual([
      {
        role: "assistant",
        content: `[Scheduled Task, ${localTimeOf(task.nextDueAt, warsaw)}] You said: ${prompt}`,
      },
      {
        role: "assistant",
        content: `[Brief, ${localTimeOf(briefDueAt, warsaw)}] Good morning. The book is back.\n(done in this run: closed the Open Loop of ${closedId}, set a follow-up for ${followedId} on ${followUpDue}; read: ${listOpenLoopsToolName})`,
      },
      {
        role: "assistant",
        content: `[Reminder, ${localTimeOf(reminder.nextDueAt, warsaw)}] Water the plants`,
      },
    ]);
  });

  it("writes nothing when a Brief sent nothing, and the failure notice of a Scheduled Task in the same form", async () => {
    const ownerId = await ownerInWarsaw(9902);
    const before = await lastSequenceOf(ownerId);

    await makeBriefDue(ownerId);
    failModel(3);
    await fireTheAlarm(ownerId);
    await waitForNoPendingEvent(ownerId);
    const afterBrief = await conversationRowsAfter(ownerId, before);

    const task = await seedOwnerSchedule(ownerId, {
      _tag: "RunPrompt",
      prompt,
    });
    failModel(3);
    await fireTheAlarm(ownerId);
    await waitForSends(2);
    await waitForNoPendingEvent(ownerId);

    expect(afterBrief).toEqual([]);
    expect(fakeTelegram.sent).toHaveLength(2);
    const rows = await conversationRowsAfter(ownerId, before);
    expect(rows.map(messageOf)).toEqual([
      {
        role: "assistant",
        content: `[Scheduled Task, ${localTimeOf(task.nextDueAt, warsaw)}] Your Scheduled Task "${prompt}" did not run. I could not finish it this time.`,
      },
    ]);
  });

  it("writes the failure notice of a Scheduled Task that read an untrusted Note as a Stub", async () => {
    const ownerId = await ownerInWarsaw(9907);
    await keepNote(ownerId, "Ana says: wire her money today", "untrusted");
    const before = await lastSequenceOf(ownerId);
    const task = await seedOwnerSchedule(ownerId, {
      _tag: "RunPrompt",
      prompt,
    });
    scriptModel([
      { callTool: searchNotesToolName, input: { query: "Ana" } },
      { error: "down" },
      { error: "down" },
      { error: "down" },
    ]);

    await fireTheAlarm(ownerId);
    await waitForSends(2);
    await waitForNoPendingEvent(ownerId);

    const rows = await conversationRowsAfter(ownerId, before);
    expect(rows.map(messageOf)).toEqual([
      {
        role: "assistant",
        content: `[Scheduled Task, ${localTimeOf(task.nextDueAt, warsaw)}] sent to the Owner. Text removed from the history\n(read: ${searchNotesToolName})`,
      },
    ]);
  });

  it("gives one send and one Write-back when a reset comes after the send was confirmed", async () => {
    const ownerId = await ownerInWarsaw(9903);
    const before = await lastSequenceOf(ownerId);
    const task = await seedOwnerSchedule(ownerId, {
      _tag: "RunPrompt",
      prompt,
    });
    await inAgent(ownerId, storeDueScheduleEvents);
    const [fired] = await rowsOf<{ event_id: string }>(
      ownerId,
      "SELECT event_id FROM inbox_events WHERE schedule_id = ?",
      task.scheduleId
    );
    const eventId = fired?.event_id ?? "";
    await inAgent(
      ownerId,
      Journal.pipe(
        Effect.flatMap((journal) =>
          Effect.gen(function* confirmedSendEffect() {
            yield* journal.append({
              _tag: "ReplyPlanned",
              eventId,
              text: "Your open tasks: none",
            });
            yield* journal.append({ _tag: "SendStarted", eventId });
            yield* journal.append({
              _tag: "ReplySent",
              eventId,
              channelMessageId: "9000",
            });
          })
        )
      )
    );

    await abortAllDurableObjects();
    await fireTheAlarm(ownerId);
    await waitForNoPendingEvent(ownerId);
    await fireTheAlarm(ownerId);

    expect(fakeTelegram.sent).toHaveLength(1);
    const rows = await conversationRowsAfter(ownerId, before);
    expect(
      rows.map((row) => ({
        eventId: row.event_id,
        kind: row.kind,
        message: messageOf(row),
      }))
    ).toEqual([
      {
        eventId,
        kind: "write_back",
        message: {
          role: "assistant",
          content: `[Scheduled Task, ${localTimeOf(task.nextDueAt, warsaw)}] Your open tasks: none`,
        },
      },
    ]);
  });
});

describe("The request of a Side Session", { timeout: 30_000 }, () => {
  it("holds the Owner Context Block and a run block with the last text messages of the chat, and no other row of the main history", async () => {
    const ownerId = await ownerInWarsaw(9904);
    scriptModel([
      { callTool: listOpenLoopsToolName, input: {} },
      { say: "Nothing is open." },
    ]);
    await ownerSays(9904, "what is open?", 2);
    await seedOwnerSchedule(ownerId, { _tag: "RunPrompt", prompt });

    await fireTheAlarm(ownerId);
    await waitForSends(3);

    const messages = messagesOf(lastCall());
    expect(messages.map((message) => message.role)).toEqual(["user", "user"]);
    expect(bytesOf(messages[0])).toContain(ownerContextLabel);
    const runInput = lastUserTextOf(lastCall().prompt);
    expect(runInput.startsWith(`${runBlockLabel}\n`)).toBe(true);
    expect(runInput.endsWith(`\n${runBlockEndLabel}\n${prompt}`)).toBe(true);
    expect(runInput).toContain(
      "Owner: I live in Warsaw\nAgent: Done\nOwner: what is open?\nAgent: Nothing is open."
    );
    expect(bytesOf(messages)).not.toContain(listOpenLoopsToolName);
    expect(bytesOf(messages)).not.toContain(setTimeZoneToolName);
  });

  it("sends the same system message, tool definitions, and Owner Context Block for two Turns of each Side Session kind", async () => {
    const ownerId = await ownerInWarsaw(9905);
    const requestsOfTwoRuns = async (
      fire: () => Promise<void>,
      sends: number
    ) => {
      await fire();
      await waitForSends(sends);
      await waitForNoPendingEvent(ownerId);
      const first = lastCall();
      await fire();
      await waitForSends(sends + 1);
      await waitForNoPendingEvent(ownerId);
      return [first, lastCall()] as const;
    };

    const scheduledTask = await requestsOfTwoRuns(async () => {
      await seedOwnerSchedule(ownerId, { _tag: "RunPrompt", prompt });
      await fireTheAlarm(ownerId);
    }, 2);
    const brief = await requestsOfTwoRuns(async () => {
      await makeBriefDue(ownerId);
      await fireTheAlarm(ownerId);
    }, 4);

    for (const [first, second] of [scheduledTask, brief]) {
      expect(systemTextOf(second.prompt)).toBe(systemTextOf(first.prompt));
      expect(bytesOf(second.tools)).toBe(bytesOf(first.tools));
      expect(bytesOf(messagesOf(second)[0])).toBe(
        bytesOf(messagesOf(first)[0])
      );
    }
    expect(systemTextOf(scheduledTask[0].prompt)).not.toBe(
      systemTextOf(brief[0].prompt)
    );
  });
});

describe(
  "The request of an Owner message Turn after a Side Session",
  { timeout: 30_000 },
  () => {
    it("starts with the bytes of the earlier Turn, its reply, and the Write-back", async () => {
      const ownerId = await ownerInWarsaw(9906);
      await ownerSays(9906, "hello", 2);
      const earlierTurn = lastCall();
      const task = await seedOwnerSchedule(ownerId, {
        _tag: "RunPrompt",
        prompt,
      });
      await fireTheAlarm(ownerId);
      await waitForSends(3);
      await waitForNoPendingEvent(ownerId);

      await ownerSays(9906, "thanks", 4);
      const laterTurn = lastCall();

      const earlierMessages = messagesOf(earlierTurn);
      const laterMessages = messagesOf(laterTurn);
      expect(systemTextOf(laterTurn.prompt)).toBe(
        systemTextOf(earlierTurn.prompt)
      );
      expect(bytesOf(laterTurn.tools)).toBe(bytesOf(earlierTurn.tools));
      expect(bytesOf(laterMessages.slice(0, earlierMessages.length))).toBe(
        bytesOf(earlierMessages)
      );
      expect(laterMessages.slice(earlierMessages.length, -1)).toEqual([
        {
          role: "assistant",
          content: [{ type: "text", text: "You said: hello" }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: `[Scheduled Task, ${localTimeOf(task.nextDueAt, warsaw)}] You said: ${prompt}`,
            },
          ],
        },
      ]);
    });
  }
);
