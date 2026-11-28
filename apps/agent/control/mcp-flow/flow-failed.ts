import { Data } from "effect";

export class McpFlowFailed extends Data.TaggedError("McpFlowFailed")<{
  readonly step: string;
  readonly detail: string;
}> {
  override get message() {
    return `The MCP flow failed at "${this.step}": ${this.detail}`;
  }
}
