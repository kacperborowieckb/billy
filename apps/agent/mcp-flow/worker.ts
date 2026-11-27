import { Schema } from "effect";

import { edge } from "../src/edge/edge.ts";
import { bearerToken, matchesSecret } from "../src/edge/secret.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import {
  FlowObservationRequestSchema,
  flowObservationRoute,
} from "./flow-contract.ts";
import type { FlowMcpHub } from "./flow-mcp-hub.ts";
import { flowPersonalAgentFor } from "./flow-personal-agent.ts";

export { FlowMcpHub as McpHub } from "./flow-mcp-hub.ts";
export { FlowPersonalAgent as PersonalAgent } from "./flow-personal-agent.ts";

const observe = async (request: Request, env: Env) => {
  if (!matchesSecret(bearerToken(request), env.OPERATOR_TOKEN)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const { ownerId } = Schema.decodeUnknownSync(FlowObservationRequestSchema)(
    await request.json()
  );
  const agent = await flowPersonalAgentFor(env, OwnerIdSchema.make(ownerId));
  const hub = env.MCP_HUB.getByName(
    ownerId
  ) as unknown as DurableObjectStub<FlowMcpHub>;
  return Response.json({
    journal: JSON.parse(await agent.journal()),
    serverCalls: JSON.parse(await hub.serverCalls()),
  });
};

export default {
  fetch: (request, env, context) =>
    request.method === "POST" &&
    new URL(request.url).pathname === flowObservationRoute
      ? observe(request, env)
      : edge.fetch(request, env, context),
} satisfies ExportedHandler<Env>;
