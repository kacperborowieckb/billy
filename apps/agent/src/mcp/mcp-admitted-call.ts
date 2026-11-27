import type { McpCallRequest } from "./mcp-hub-contract.ts";

export interface AdmittedCall {
  readonly request: McpCallRequest;
  readonly epoch: number;
}
