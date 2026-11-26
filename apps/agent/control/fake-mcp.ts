import { Option, Schema } from "effect";

export const fakeMcpPrefix = "mcp: ";

const connection = "test_server";

const toolCall = (id: string, name: string, input: unknown) => ({
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(input) },
    },
  ],
});

const CallOutputSchema = Schema.fromJsonString(
  Schema.Struct({ result: Schema.String })
);

const decodeCallOutput = Schema.decodeUnknownOption(CallOutputSchema);

const titlesOf = (result: string) => {
  const start = result.indexOf("{");
  const end = result.lastIndexOf("}");
  const parsed: unknown = JSON.parse(result.slice(start, end + 1));
  return typeof parsed === "object" && parsed !== null && "results" in parsed
    ? (parsed.results as readonly { readonly title: string }[]).map(
        ({ title }) => title
      )
    : [];
};

export const isFakeMcpMessage = (ownerText: string) =>
  ownerText.startsWith(fakeMcpPrefix);

export const fakeMcpMessage = (
  ownerText: string,
  toolResult: string | undefined
) => {
  if (toolResult === undefined) {
    return toolCall("call-mcp-find", "find_mcp_tools", {
      connection,
      query: ownerText.slice(fakeMcpPrefix.length),
    });
  }
  const output = decodeCallOutput(toolResult);
  if (Option.isNone(output)) {
    return toolCall("call-mcp-read", "call_mcp_tool", {
      connection,
      tool: "search",
      arguments: { query: ownerText.slice(fakeMcpPrefix.length) },
    });
  }
  return {
    role: "assistant",
    content: `Pages: ${titlesOf(output.value.result).join(", ")}`,
  };
};
