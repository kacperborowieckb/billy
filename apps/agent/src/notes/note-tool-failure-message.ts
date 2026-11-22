import { Cause, Option } from "effect";

import { UnknownNotes } from "./unknown-notes.ts";

export const unknownNotesMessage = (
  noteIds: readonly string[],
  consequence: string
) =>
  `No Note of the Owner has the id ${noteIds.join(", ")}. ${consequence} Use a Note id that search_notes or capture_note returned.`;

export const noteToolFailureMessage = (
  cause: Cause.Cause<unknown>,
  messages: {
    readonly unknownNotesConsequence: string;
    readonly otherwise: string;
  }
) => {
  const error = Cause.findErrorOption(cause);
  return Option.isSome(error) && error.value instanceof UnknownNotes
    ? unknownNotesMessage(error.value.noteIds, messages.unknownNotesConsequence)
    : messages.otherwise;
};
