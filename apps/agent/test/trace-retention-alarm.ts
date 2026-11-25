import { env, runInDurableObject } from "cloudflare:test";
import { DateTime, Effect, Option } from "effect";

import { OwnerIdSchema } from "../src/owner-id.ts";
import { AgentStorage } from "../src/personal-agent/agent-storage.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { traceRetentionAlarmAt } from "../src/tracing/trace-retention.ts";
import { fakeTraceRetention } from "./fakes.ts";

export const onlyTheRetentionAlarm = async (
  ownerId: string,
  retryNotBefore: Option.Option<DateTime.Utc> = Option.none()
) =>
  runInDurableObject(
    await personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId)),
    (instance) =>
      instance.runtime.runPromise(
        AgentStorage.pipe(
          Effect.flatMap(({ database }) =>
            traceRetentionAlarmAt(database, {
              days: fakeTraceRetention.days,
              retryNotBefore,
            })
          ),
          Effect.map(Option.toArray),
          Effect.map((instants) =>
            instants.map((instant) =>
              Math.ceil(DateTime.toEpochMillis(instant) / 1000)
            )
          )
        )
      )
  );
