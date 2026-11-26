import { Data } from "effect";

export class McpConnectionNotAdded extends Data.TaggedError(
  "McpConnectionNotAdded"
)<{
  readonly status: number;
  readonly detail: string;
}> {
  override get message() {
    return `The Worker did not add the MCP Connection (${this.status}): ${this.detail}`;
  }
}
