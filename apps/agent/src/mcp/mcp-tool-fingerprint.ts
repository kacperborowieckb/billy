import { fingerprintTools, jsonSchema } from "ai";

import type { McpToolCopy } from "./mcp-tool-copy.ts";

export type McpToolDefinition = Pick<
  McpToolCopy,
  "name" | "description" | "inputSchema"
>;

export type FingerprintedMcpToolCopy = McpToolCopy & {
  readonly fingerprint: string;
};

export const mcpFingerprintsOf = (tools: readonly McpToolDefinition[]) =>
  fingerprintTools(
    Object.fromEntries(
      tools.map(({ name, description, inputSchema }) => [
        name,
        { description, inputSchema: jsonSchema(inputSchema) },
      ])
    )
  );

export const fingerprintedMcpCopiesOf = async (
  tools: readonly McpToolCopy[]
): Promise<readonly FingerprintedMcpToolCopy[]> => {
  const fingerprints = await mcpFingerprintsOf(tools);
  return tools.map((tool) => ({
    ...tool,
    fingerprint: fingerprints[tool.name] ?? "",
  }));
};
