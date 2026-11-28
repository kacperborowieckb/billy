import { Effect } from "effect";

import { Journal } from "../src/journal/journal.ts";
import type { OwnerId } from "../src/owner-id.ts";
import {
  PersonalAgent,
  personalAgentFor,
} from "../src/personal-agent/personal-agent.ts";

export class FlowPersonalAgent extends PersonalAgent {
  journal(): Promise<string> {
    return this.runtime.runPromise(
      Journal.pipe(
        Effect.flatMap((journal) => journal.read),
        Effect.map((entries) =>
          JSON.stringify(entries.map(({ record }) => record))
        )
      )
    );
  }
}

export const flowPersonalAgentFor = (env: Env, ownerId: OwnerId) =>
  personalAgentFor(
    env.PERSONAL_AGENT as unknown as DurableObjectNamespace<FlowPersonalAgent>,
    ownerId
  );
