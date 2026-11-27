import {
  createFakeNotion,
  fakeNotionOrigin,
} from "../control/mcp-flow/fake-notion.ts";
import { McpHub } from "../src/mcp/mcp-hub.ts";
import type { FetchFunction } from "../src/mcp/mcp-outbound-guard.ts";

const fakeNotion = createFakeNotion();

export class FlowMcpHub extends McpHub {
  private readonly notion = fakeNotion;

  protected override readonly send: FetchFunction = async (input, init) => {
    const request = new Request(input, init);
    return new URL(request.url).origin === fakeNotionOrigin
      ? await this.notion.fetch(request)
      : new Response(`The flow has no network: ${request.url}`, {
          status: 503,
        });
  };

  serverCalls() {
    return Promise.resolve(JSON.stringify(this.notion.calls));
  }
}
