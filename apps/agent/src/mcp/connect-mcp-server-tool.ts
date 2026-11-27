import { Effect, Schema } from "effect";

import { ToolFailed } from "../model-gateway/agent-tool.ts";
import { recordedTool } from "../personal-agent/recorded-tool.ts";
import { connectMcpServerToolName } from "./mcp-tool-names.ts";
import { entryOrFail } from "./mcp-tool-services.ts";
import type { McpToolServices } from "./mcp-tool-services.ts";

const ConnectMcpServerInput = Schema.Struct({
  connection: Schema.String.pipe(
    Schema.annotate({
      description:
        "The catalog id of the service that the Owner wants to connect, as listed in the Owner Context Block.",
    })
  ),
});

export const connectMcpServerTool = (
  services: McpToolServices,
  eventId: string
) =>
  recordedTool(
    { eventId, progress: services.progress, redactor: services.redactor },
    {
      name: connectMcpServerToolName,
      description:
        "Offer the Owner a Connect button for a supported service that is not ready. It changes nothing. Code sends the button after your reply, and the Owner signs in at the service. Without a successful call of this tool in this Turn, no button comes, so call it each time the Owner asks to connect, also after an earlier button. Never write a link yourself. After the call, tell the Owner to tap the button.",
      inputSchema: ConnectMcpServerInput,
      riskClass: "read",
      failureMessage: "The Connect button could not be prepared.",
      work: Effect.fnUntraced(function* connectWork({
        connection,
      }: {
        readonly connection: string;
      }) {
        const entry = yield* entryOrFail(services.catalog, connection);
        if (services.states.get(entry.catalogId) === "ready") {
          return yield* Effect.fail(
            new ToolFailed({
              message: `${entry.displayName} is already connected. Tell the Owner.`,
            })
          );
        }
        if (!services.states.has(entry.catalogId)) {
          yield* services.hub.acknowledgeRemoval(entry.catalogId);
        }
        yield* services.requestConnect(eventId, entry.catalogId);
        return {
          connection: entry.displayName,
          notice: `Code sends a Connect button for ${entry.displayName} after your reply. Tell the Owner to tap it and agree at ${entry.displayName}. Do not write a link.`,
        };
      }),
    }
  );
