import { Effect } from "effect";

import { ToolFailed } from "../model-gateway/agent-tool.ts";
import { unknownNotesMessage } from "./note-tool-failure-message.ts";
import type { Note, Notes } from "./notes.ts";

export interface KnownNotesMessages {
  readonly consequence: string;
  readonly readFailed: string;
}

export const knownNotesOf = Effect.fnUntraced(function* knownNotesOf(
  notes: Notes["Service"],
  noteIds: readonly string[],
  messages: KnownNotesMessages
) {
  const requested = [...new Set(noteIds)];
  const found = yield* notes
    .byIds(requested)
    .pipe(
      Effect.mapError(() => new ToolFailed({ message: messages.readFailed }))
    );
  const foundIds = new Set(found.map(({ noteId }) => noteId));
  const unknown = requested.filter((noteId) => !foundIds.has(noteId));
  if (unknown.length > 0) {
    return yield* new ToolFailed({
      message: unknownNotesMessage(unknown, messages.consequence),
    });
  }
  return found;
});

export const closedOpenLoopsAmong = Effect.fnUntraced(
  function* closedOpenLoopsAmong(
    notes: Notes["Service"],
    noteIds: readonly string[],
    readFailed: string
  ) {
    const lookup: Effect.Effect<readonly Note[], unknown> =
      notes.openLoopsAmong(noteIds);
    const open = yield* lookup.pipe(
      Effect.mapError(() => new ToolFailed({ message: readFailed }))
    );
    const openIds = new Set(open.map(({ noteId }) => noteId));
    return noteIds.filter((noteId) => !openIds.has(noteId));
  }
);
