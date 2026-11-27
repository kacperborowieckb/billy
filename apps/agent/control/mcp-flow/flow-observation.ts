import { Effect, Schema } from "effect";

import {
  flowObservationRoute,
  FlowObservationSchema,
} from "../../mcp-flow/flow-contract.ts";
import { McpFlowFailed } from "./flow-failed.ts";

export const readFlowObservation = Effect.fnUntraced(
  function* readFlowObservation({
    workerUrl,
    token,
    ownerId,
  }: {
    readonly workerUrl: URL;
    readonly token: string;
    readonly ownerId: string;
  }) {
    const response = yield* Effect.promise(async () => {
      const answer = await fetch(new URL(flowObservationRoute, workerUrl), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ownerId }),
      });
      return { status: answer.status, text: await answer.text() };
    });
    if (response.status !== 200) {
      return yield* new McpFlowFailed({
        step: "read the Journal",
        detail: `${response.status} ${response.text}`,
      });
    }
    return Schema.decodeUnknownSync(
      Schema.fromJsonString(FlowObservationSchema)
    )(response.text);
  }
);
