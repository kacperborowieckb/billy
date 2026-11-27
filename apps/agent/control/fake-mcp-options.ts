import type { FakeMcpTool } from "./fake-mcp-tools.ts";

export const textResult = (text: string, isError = false) => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

export interface FakeMcpServerOptions {
  readonly tools?: readonly FakeMcpTool[];
  readonly answerTool?: (
    name: string,
    args: Record<string, unknown>
  ) => ReturnType<typeof textResult> | undefined;
}
