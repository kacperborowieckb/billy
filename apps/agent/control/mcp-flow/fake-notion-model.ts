import { Option, Schema } from "effect";

import { fakeNotionPageIds } from "./fake-notion.ts";

export const fakeNotionPrefix = "notion ";

const connection = "notion";

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

const say = (content: string) => ({ role: "assistant", content });

const notionCall = (
  id: string,
  tool: string,
  args: Readonly<Record<string, unknown>>
) => toolCall(id, "call_mcp_tool", { connection, tool, arguments: args });

const ToolOutputSchema = Schema.fromJsonString(
  Schema.Struct({
    tool: Schema.optionalKey(Schema.String),
    result: Schema.optionalKey(Schema.String),
    resultIds: Schema.optionalKey(
      Schema.Array(Schema.Struct({ id: Schema.String }))
    ),
    tools: Schema.optionalKey(Schema.String),
    index: Schema.optionalKey(Schema.String),
    notice: Schema.optionalKey(Schema.String),
  })
);

const decodeOutput = Schema.decodeUnknownOption(ToolOutputSchema);

const toolNamesIn = (text: string) => [
  ...new Set(text.match(/notion-[a-z-]+/gu)),
];

const jsonIn = (text: string): Readonly<Record<string, unknown>> => {
  try {
    return JSON.parse(
      text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)
    ) as Record<string, unknown>;
  } catch {
    return {};
  }
};

type Step = (
  rest: string,
  toolResult: string | undefined
) => ReturnType<typeof say> | ReturnType<typeof toolCall>;

const connect: Step = (_rest, toolResult) =>
  toolResult === undefined
    ? toolCall("notion-connect", "connect_mcp_server", { connection })
    : say("Tap the button to connect Notion.");

const find: Step = (query, toolResult) => {
  if (toolResult === undefined) {
    return toolCall("notion-find", "find_mcp_tools", { connection, query });
  }
  const output = Option.getOrUndefined(decodeOutput(toolResult));
  return say(
    `Found tools: ${toolNamesIn(output?.tools ?? output?.index ?? "").join(", ")}`
  );
};

const read: Step = (query, toolResult) => {
  if (toolResult === undefined) {
    return notionCall("notion-search", "notion-search", { query });
  }
  const output = Option.getOrUndefined(decodeOutput(toolResult));
  if (output?.tool === "notion-search") {
    return notionCall("notion-fetch", "notion-fetch", {
      id: output.resultIds?.[0]?.id ?? fakeNotionPageIds.readingList,
    });
  }
  const page = jsonIn(output?.result ?? "");
  return say(`Read page ${String(page["title"])}: ${String(page["text"])}`);
};

const create: Step = (title, toolResult) =>
  toolResult === undefined
    ? notionCall("notion-create", "notion-create-pages", {
        parent: { page_id: fakeNotionPageIds.readingList },
        pages: [
          {
            properties: { title },
            content: `Notes about ${title}`,
          },
        ],
      })
    : say("I asked for your Approval.");

const disconnect: Step = (_rest, toolResult) => {
  if (toolResult === undefined) {
    return toolCall("notion-disconnect", "disconnect_mcp_connection", {
      connection,
    });
  }
  const output = Option.getOrUndefined(decodeOutput(toolResult));
  return say(output?.notice ?? "Notion was not disconnected.");
};

const steps: Readonly<Record<string, Step>> = {
  connect,
  find,
  read,
  create,
  disconnect,
};

const commandOf = (ownerText: string) => {
  const [command = "", ...rest] = ownerText
    .slice(fakeNotionPrefix.length)
    .split(" ");
  return { step: steps[command], rest: rest.join(" ") };
};

export const isFakeNotionMessage = (ownerText: string) =>
  ownerText.startsWith(fakeNotionPrefix) &&
  commandOf(ownerText).step !== undefined;

export const fakeNotionMessage = (
  ownerText: string,
  toolResult: string | undefined
) => {
  const { step, rest } = commandOf(ownerText);
  return step === undefined
    ? say("Unknown Notion command.")
    : step(rest, toolResult);
};
