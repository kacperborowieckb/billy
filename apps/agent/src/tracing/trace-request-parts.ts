import { Effect } from "effect";

import type { AgentStorage } from "../personal-agent/agent-storage.ts";
import { traceRequestParts } from "./trace-storage-schema.ts";
import type { RequestPart } from "./traced-request.ts";

export const storeRequestParts = (
  database: AgentStorage["Service"]["database"],
  parts: readonly RequestPart[],
  usedAt: string
) =>
  Effect.forEach(
    parts,
    (part) =>
      database
        .insert(traceRequestParts)
        .values({ ...part, lastUsedAt: usedAt })
        .onConflictDoUpdate({
          target: [
            traceRequestParts.kind,
            traceRequestParts.task,
            traceRequestParts.hash,
          ],
          set: { lastUsedAt: usedAt },
        }),
    { discard: true }
  );
