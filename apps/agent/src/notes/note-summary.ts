import { Effect } from "effect";
import type { DateTime, Option } from "effect";

import { quoted } from "../approval/approval-summary.ts";
import { ToolFailed } from "../model-gateway/agent-tool.ts";
import { localDueTimeText } from "../time/local-time-text.ts";
import { unknownNotesMessage } from "./note-tool-failure-message.ts";
import type { Notes } from "./notes.ts";
import type { OpenLoopInput } from "./open-loop-input.ts";

export const notesNotReadMessage =
  "The Notes could not be read, so nothing waits for the Owner's Approval. Tell the Owner that you could not do it.";

export const storedNotes = (
  notes: Notes["Service"],
  noteIds: readonly string[],
  consequence: string
) =>
  notes.byIds(noteIds).pipe(
    Effect.mapError(() => new ToolFailed({ message: notesNotReadMessage })),
    Effect.flatMap((found) => {
      const unknown = noteIds.filter(
        (noteId) => !found.some((note) => note.noteId === noteId)
      );
      return unknown.length > 0
        ? Effect.fail(
            new ToolFailed({
              message: unknownNotesMessage(unknown, consequence),
            })
          )
        : Effect.succeed(
            noteIds.flatMap((noteId) =>
              found.filter((note) => note.noteId === noteId)
            )
          );
    })
  );

export const storedNoteTexts = (
  notes: Notes["Service"],
  noteIds: readonly string[],
  consequence: string
) =>
  storedNotes(notes, noteIds, consequence).pipe(
    Effect.map((found) => found.map((note) => `Note ${quoted(note.text)}`))
  );

export const openLoopText = (
  { kind, localDueTime }: OpenLoopInput,
  timeZone: Option.Option<DateTime.TimeZone>
) =>
  localDueTime === undefined
    ? `Open Loop ${quoted(kind)} with no due time`
    : `Open Loop ${quoted(kind)} due ${localDueTimeText(localDueTime, timeZone)}`;
