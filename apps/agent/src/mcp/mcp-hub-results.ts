import type { McpToolCopy } from "./mcp-tool-copy.ts";

const maxTransferredResultCharacters = 2_000_000;

const isTextPart = (
  part: unknown
): part is { readonly type: "text"; readonly text: string } =>
  typeof part === "object" &&
  part !== null &&
  "type" in part &&
  part.type === "text" &&
  "text" in part &&
  typeof part.text === "string";

export const resultTextOf = (content: unknown, structured: unknown): string => {
  if (!Array.isArray(content) || content.length === 0) {
    return structured === undefined || structured === null
      ? ""
      : JSON.stringify(structured).slice(0, maxTransferredResultCharacters);
  }
  return content
    .map((part: unknown) =>
      isTextPart(part) ? part.text : "[non-text content omitted]"
    )
    .join("\n")
    .slice(0, maxTransferredResultCharacters);
};

interface ServerTool {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema: unknown;
  readonly annotations?:
    | {
        readonly destructiveHint?: boolean | undefined;
        readonly readOnlyHint?: boolean | undefined;
      }
    | undefined;
}

export const toolCopyOf = (tool: ServerTool): McpToolCopy => ({
  name: tool.name,
  description: tool.description ?? "",
  inputSchema: { ...(tool.inputSchema as Record<string, unknown>) },
  annotations: {
    ...(tool.annotations?.destructiveHint === undefined
      ? {}
      : { destructiveHint: tool.annotations.destructiveHint }),
    ...(tool.annotations?.readOnlyHint === undefined
      ? {}
      : { readOnlyHint: tool.annotations.readOnlyHint }),
  },
});
