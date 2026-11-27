import { McpHub as LiveMcpHub } from "../src/mcp/mcp-hub.ts";
import { fakeMcpServer, mcpHubWakes } from "./fakes.ts";

const sendToFakeMcpServer = (input: RequestInfo | URL, init?: RequestInit) =>
  fakeMcpServer.fetch(new Request(input, init));

export class McpHub extends LiveMcpHub {
  constructor(...args: ConstructorParameters<typeof LiveMcpHub>) {
    super(...args);
    mcpHubWakes.count += 1;
  }

  protected override readonly send = sendToFakeMcpServer;

  completionsWaitingFor(catalogId: string) {
    return this.completer.completionsWaitingFor(catalogId);
  }
}
