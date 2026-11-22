import { env, runInDurableObject } from "cloudflare:test";
import { DateTime, Effect } from "effect";

import { Notes } from "../src/notes/notes.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { OwnerPreferences } from "../src/preferences/owner-preferences.ts";
import { Schedules } from "../src/schedule/schedules.ts";
import { addOwner } from "./telegram-requests.ts";

export const seededNoteText = "Seeded task";

export const seededReminderText = "Seeded reminder";

export const ownerInWarsaw = async (telegramUserId: number) => {
  const ownerId = await addOwner(telegramUserId);
  await runInDurableObject(
    await personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId)),
    (instance) =>
      instance.runtime.runPromise(
        OwnerPreferences.pipe(
          Effect.flatMap((preferences) =>
            preferences.setTimeZone("Europe/Warsaw", "setup")
          )
        )
      )
  );
  return ownerId;
};

export const seedNoteAndReminder = async (
  ownerId: string,
  { withOpenLoop = true }: { readonly withOpenLoop?: boolean } = {}
) =>
  runInDurableObject(
    await personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId)),
    (instance) =>
      instance.runtime.runPromise(
        Effect.gen(function* seedEffect() {
          const notes = yield* Notes;
          const schedules = yield* Schedules;
          const { note } = yield* notes.capture({
            text: seededNoteText,
            source: {
              eventId: "seed-event",
              channel: "telegram",
              conversationId: "1",
              channelMessageId: "1",
              trustLevel: "owner",
            },
            ...(withOpenLoop ? { openLoop: { kind: "task" } } : {}),
          });
          const { schedule } = yield* schedules.set({
            action: { _tag: "SendText", text: seededReminderText },
            setBy: "owner",
            dueAt: DateTime.makeUnsafe("2099-11-26T08:00:00Z"),
            sourceEventId: "seed-event",
          });
          return { noteId: note.noteId, scheduleId: schedule.scheduleId };
        })
      )
  );

export const closeSeededOpenLoop = async (ownerId: string, noteId: string) =>
  runInDurableObject(
    await personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId)),
    (instance) =>
      instance.runtime.runPromise(
        Notes.pipe(
          Effect.flatMap((notes) =>
            notes.closeOpenLoop({
              noteId,
              eventId: "seed-close-event",
              reason: "done",
            })
          )
        )
      )
  );

export const seedScheduledTasks = async (ownerId: string, count: number) =>
  runInDurableObject(
    await personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId)),
    (instance) =>
      instance.runtime.runPromise(
        Schedules.pipe(
          Effect.flatMap((schedules) =>
            Effect.forEach(Array.from({ length: count }), (_, index) =>
              schedules.set({
                action: { _tag: "RunPrompt", prompt: `Seeded task ${index}` },
                setBy: "owner",
                dueAt: DateTime.makeUnsafe("2099-11-26T08:00:00Z"),
                sourceEventId: `seed-task-${index}`,
              })
            )
          )
        )
      )
  );
