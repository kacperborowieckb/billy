import { Effect } from "effect";

import type { AgentStorage } from "../personal-agent/agent-storage.ts";
import {
  traceRequestParts,
  traceRequestPartUses,
} from "./trace-storage-schema.ts";
import type { RequestPart } from "./traced-request.ts";

interface PartsOfTrace {
  readonly parts: readonly RequestPart[];
  readonly traceSequence: number;
  readonly usedAt: string;
}

export const storeRequestParts = (
  database: AgentStorage["Service"]["database"],
  { parts, traceSequence, usedAt }: PartsOfTrace
) =>
  Effect.forEach(
    parts,
    ({ kind, task, hash, content }) =>
      database
        .insert(traceRequestParts)
        .values({ kind, task, hash, content, lastUsedAt: usedAt })
        .onConflictDoUpdate({
          target: [
            traceRequestParts.kind,
            traceRequestParts.task,
            traceRequestParts.hash,
          ],
          set: { lastUsedAt: usedAt },
        })
        .pipe(
          Effect.andThen(
            database
              .insert(traceRequestPartUses)
              .values({ traceSequence, kind, task, hash })
          )
        ),
    { discard: true }
  );
