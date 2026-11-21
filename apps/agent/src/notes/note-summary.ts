import { Effect } from "effect";

import { quoted } from "../approval/approval-summary.ts";
import { localDueTimeText } from "../time/local-time-text.ts";
import type { Notes } from "./notes.ts";
import type { OpenLoopInput } from "./open-loop-input.ts";

export const storedNoteTexts = (
  notes: Notes["Service"],
  noteIds: readonly string[]
) =>
  notes.byIds(noteIds).pipe(
    Effect.map((found) =>
      noteIds.map((noteId) => {
        const note = found.find((candidate) => candidate.noteId === noteId);
        return note === undefined
          ? `Note ${noteId}`
          : `Note ${quoted(note.text)}`;
      })
    ),
    Effect.orElseSucceed(() => noteIds.map((noteId) => `Note ${noteId}`))
  );

export const storedNoteText = (notes: Notes["Service"], noteId: string) =>
  storedNoteTexts(notes, [noteId]).pipe(
    Effect.map((texts) => texts[0] ?? `Note ${noteId}`)
  );

export const openLoopText = ({ kind, localDueTime }: OpenLoopInput) =>
  localDueTime === undefined
    ? `Open Loop ${quoted(kind)}`
    : `Open Loop ${quoted(kind)} due ${localDueTimeText(localDueTime)}`;
