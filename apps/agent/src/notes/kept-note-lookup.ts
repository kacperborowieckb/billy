import { and, eq } from "drizzle-orm";
import { Effect, Option } from "effect";

import type { OwnerId } from "../owner-id.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { notes } from "../personal-agent/storage-schema.ts";
import { hashOfNoteText } from "./note-text-hash.ts";

export const makeKeptNoteLookup = Effect.fnUntraced(
  function* makeKeptNoteLookup(ownerId: OwnerId) {
    const { database } = yield* AgentStorage;

    const keptFrom = (sourceEventId: string, text: string) =>
      hashOfNoteText(text).pipe(
        Effect.flatMap((textHash) =>
          database
            .select({ noteId: notes.noteId, text: notes.text })
            .from(notes)
            .where(
              and(
                eq(notes.ownerId, ownerId),
                eq(notes.sourceEventId, sourceEventId),
                eq(notes.textHash, textHash)
              )
            )
        ),
        Effect.map(([row]) => Option.fromNullishOr(row))
      );

    return { keptFrom };
  }
);
