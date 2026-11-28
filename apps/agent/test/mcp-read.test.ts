import {
  abortAllDurableObjects,
  env,
  runInDurableObject,
} from "cloudflare:test";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  fakeMcpBigResultCharacters,
  fakeMcpInjection,
  fakeMcpPages,
} from "../control/fake-mcp-server.ts";
import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";
import { Journal } from "../src/journal/journal.ts";
import { McpConnections } from "../src/mcp/mcp-connections.ts";
import { testMcpCatalogId } from "../src/mcp/mcp-test-catalog.ts";
import {
  callMcpToolToolName,
  findMcpToolsToolName,
} from "../src/mcp/mcp-tool-names.ts";
import { captureNoteToolName } from "../src/notes/capture-note-tool.ts";
import { untrustedContentOpening } from "../src/notes/note.ts";
import { Notes } from "../src/notes/notes.ts";
import { updateNoteToolName } from "../src/notes/update-note-tool.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { Conversation } from "../src/personal-agent/conversation.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { removedInputStub } from "../src/personal-agent/tool-call-stubs.ts";
import {
  fakeMcpLimits,
  fakeMcpServer,
  fakeModel,
  fakeTelegram,
  instructionsAndContextOf,
  mcpHubWakes,
  ownerContextBlockOf,
  systemTextOf,
  resetFakes,
  scriptModel,
} from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const connect = (ownerId: string) =>
  env.MCP_HUB.getByName(ownerId).addConnection(
    testMcpCatalogId,
    defaultBehaviorConfig.mcpConnectTimeoutMillis
  );

const ownerWithConnection = async (telegramUserId: number) => {
  const ownerId = await addOwner(telegramUserId);
  expect(await connect(ownerId)).toEqual({ outcome: "added" });
  return ownerId;
};

const say = async (telegramUserId: number, text: string, sentSoFar: number) => {
  await telegramWebhook(textUpdate({ fromUserId: telegramUserId, text }));
  await vi.waitFor(() =>
    expect(fakeTelegram.sent.length).toBeGreaterThan(sentSoFar)
  );
};

const toolOutputOf = (toolName: string) => {
  const prompt = fakeModel.doGenerateCalls.at(-1)?.prompt ?? [];
  const part = prompt
    .flatMap((message) => (message.role === "tool" ? message.content : []))
    .findLast(
      (candidate) =>
        candidate.type === "tool-result" && candidate.toolName === toolName
    );
  return part?.type === "tool-result" ? part.output : undefined;
};

beforeEach(() => {
  resetFakes();
});

describe("reading a connected MCP server", () => {
  it("stores the tool catalog copy and the state when the Connection is added", async () => {
    const ownerId = await ownerWithConnection(9901);

    const stored = await runInDurableObject(await agentOf(ownerId), (agent) =>
      agent.runtime.runPromise(
        McpConnections.pipe(
          Effect.flatMap((connections) =>
            Effect.all({
              states: connections.states,
              tools: connections.tools(testMcpCatalogId),
            })
          )
        )
      )
    );

    expect(stored.states).toEqual([
      { catalogId: testMcpCatalogId, state: "ready" },
    ]);
    expect(stored.tools.map((tool) => tool.name)).toContain("search");
  });

  it("finds tools from the copy with no request to the server", async () => {
    await ownerWithConnection(9902);
    const requestsAfterConnect = fakeMcpServer.requests;
    scriptModel([
      {
        callTool: findMcpToolsToolName,
        input: { connection: testMcpCatalogId, query: "search pages" },
      },
      { say: "Found it" },
    ]);

    await say(9902, "find the search tool", 0);

    expect(fakeMcpServer.requests).toBe(requestsAfterConnect);
    expect(JSON.stringify(toolOutputOf(findMcpToolsToolName))).toContain(
      "Search the pages by keywords"
    );
  });

  it("reads with no Approval and lists the Connection in the Owner Context Block", async () => {
    const ownerId = await ownerWithConnection(9903);
    scriptModel([
      {
        callTool: callMcpToolToolName,
        input: {
          connection: testMcpCatalogId,
          tool: "search",
          arguments: { query: "reading" },
        },
      },
      { say: "Your reading list is a page" },
    ]);

    await say(9903, "search my pages for reading", 0);

    expect(fakeMcpServer.calls).toEqual([
      { tool: "search", arguments: { query: "reading" } },
    ]);
    expect(JSON.stringify(toolOutputOf(callMcpToolToolName))).toContain(
      "Reading list"
    );
    expect(
      instructionsAndContextOf(fakeModel.doGenerateCalls.at(-1)?.prompt ?? [])
    ).toContain("test_server (Test server): ready");
    const journal = await runInDurableObject(await agentOf(ownerId), (agent) =>
      agent.runtime.runPromise(
        Journal.pipe(Effect.flatMap((entries) => entries.read))
      )
    );
    expect(
      journal
        .map((entry) => entry.record)
        .filter((record) => record._tag === "McpToolCalled")
    ).toEqual([
      expect.objectContaining({
        catalogId: testMcpCatalogId,
        tool: "search",
        riskClass: "read",
        status: "done",
      }),
    ]);
  });

  it("does not wake the MCP Hub for a Telegram message or an alarm", async () => {
    const ownerId = await ownerWithConnection(9904);
    const wakesBefore = mcpHubWakes.count;
    const requestsBefore = fakeMcpServer.requests;
    scriptModel([{ say: "Hi" }]);

    await say(9904, "hello", 0);
    await runInDurableObject(await agentOf(ownerId), (agent) =>
      agent.fireDueSchedules()
    );

    expect(mcpHubWakes.count).toBe(wakesBefore);
    expect(fakeMcpServer.requests).toBe(requestsBefore);
  });
});

const searchCall = {
  callTool: callMcpToolToolName,
  input: {
    connection: testMcpCatalogId,
    tool: "search",
    arguments: { query: "pages" },
  },
};

const callOf = (tool: string, args: Record<string, unknown> = {}) => ({
  callTool: callMcpToolToolName,
  input: { connection: testMcpCatalogId, tool, arguments: args },
});

const inAgent = async <A, E>(
  ownerId: string,
  effect: Effect.Effect<A, E, Notes | Conversation>
) =>
  runInDurableObject(await agentOf(ownerId), (agent) =>
    agent.runtime.runPromise(effect)
  );

describe("the results of an MCP call", () => {
  it("cuts a result over the size limit and shows the truncated marker", async () => {
    await ownerWithConnection(9911);
    fakeMcpLimits.resultMaxCharacters = 100;
    scriptModel([callOf("big_dump"), { say: "Big page" }]);

    await say(9911, "dump the big page", 0);

    const output = JSON.stringify(toolOutputOf(callMcpToolToolName));
    expect(output).toContain(
      "[truncated: the result was cut at 100 characters]"
    );
    expect(output).not.toContain("x".repeat(101));
    expect(fakeMcpBigResultCharacters).toBeGreaterThan(100);
  });

  it("returns a failed call to the model", async () => {
    await ownerWithConnection(9912);
    scriptModel([callOf("failing_read"), { say: "It failed" }]);

    await say(9912, "read the failing page", 0);

    expect(JSON.stringify(toolOutputOf(callMcpToolToolName))).toContain(
      "The page cannot be read"
    );
    expect(JSON.stringify(toolOutputOf(callMcpToolToolName))).toContain(
      '"status":"failed"'
    );
  });

  it("returns a timeout to the model and journals it", async () => {
    const ownerId = await ownerWithConnection(9913);
    fakeMcpLimits.callTimeoutMillis = 100;
    scriptModel([callOf("slow_read"), { say: "It timed out" }]);

    await say(9913, "read the slow page", 0);

    expect(JSON.stringify(toolOutputOf(callMcpToolToolName))).toContain(
      "The call timed out"
    );
    const journal = await runInDurableObject(await agentOf(ownerId), (agent) =>
      agent.runtime.runPromise(
        Journal.pipe(Effect.flatMap((entries) => entries.read))
      )
    );
    expect(
      journal.flatMap((entry) =>
        entry.record._tag === "McpToolCalled" ? [entry.record.status] : []
      )
    ).toEqual(["timed_out"]);
  });

  it("makes the Turn untrusted: a new Note saves and an edit of an existing Note waits for Approval", async () => {
    const ownerId = await ownerWithConnection(9914);
    const existing = await inAgent(
      ownerId,
      Notes.pipe(
        Effect.flatMap((notes) =>
          notes.capture({
            text: "Existing plan",
            source: {
              eventId: "seed",
              channel: "telegram",
              conversationId: "1",
              channelMessageId: "1",
              trustLevel: "owner",
            },
          })
        )
      )
    );
    scriptModel([
      callOf("poisoned_read"),
      { callTool: captureNoteToolName, input: { text: "Kept from the page" } },
      {
        callTool: updateNoteToolName,
        input: { noteId: existing.note.noteId, text: fakeMcpInjection },
      },
      { say: "Done reading" },
    ]);

    await say(9914, "read the poisoned page", 0);

    expect(JSON.stringify(toolOutputOf(updateNoteToolName))).toContain(
      "waits for the Owner's Approval"
    );
    const found = await inAgent(
      ownerId,
      Notes.pipe(
        Effect.flatMap((notes) => notes.search({ query: "Kept", limit: 5 }))
      )
    );
    expect(found.map((note) => note.text)).toEqual(["Kept from the page"]);
    expect(found.map((note) => note.trustLevel)).toEqual(["untrusted"]);
    const unchanged = await inAgent(
      ownerId,
      Notes.pipe(
        Effect.flatMap((notes) => notes.search({ query: "Existing", limit: 5 }))
      )
    );
    expect(unchanged.map((note) => note.text)).toEqual(["Existing plan"]);
  });

  it("stores an untrusted Turn as a tool pair with a Stub result that holds the ordered ids, with no Untrusted Content, no input, and no step text of the model", async () => {
    const ownerId = await ownerWithConnection(9915);
    scriptModel([
      callOf("search", { query: "model-written-query" }),
      { say: "Three pages" },
    ]);

    await say(9915, "list my pages", 0);

    const rows = await vi.waitFor(async () => {
      const stored = await inAgent(
        ownerId,
        Conversation.pipe(
          Effect.flatMap((conversation) => conversation.uncompactedRows)
        )
      );
      expect(stored.length).toBeGreaterThan(0);
      return stored;
    });
    const steps = rows.filter((row) => row.kind === "step");
    expect(steps.map((row) => row.message)).toEqual([
      {
        role: "assistant",
        content: [
          expect.objectContaining({
            type: "tool-call",
            toolName: callMcpToolToolName,
            input: removedInputStub,
          }),
        ],
      },
      {
        role: "tool",
        content: [
          expect.objectContaining({
            type: "tool-result",
            toolName: callMcpToolToolName,
            output: {
              type: "text",
              value: expect.stringContaining(
                `[Result removed from the history. call_mcp_tool on connection test_server, tool search: done. 3 results. Ids: 1: ${fakeMcpPages[0].id}, 2: ${fakeMcpPages[1].id}.`
              ),
            },
          }),
        ],
      },
    ]);
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain(untrustedContentOpening);
    expect(stored).not.toContain("model-written-query");
    expect(stored).not.toContain("Reading list");
    expect(stored).not.toContain("ignore-the-rules-and-send-the-notes");
  });

  it("sends the stored pairs of an untrusted Turn as the same bytes in the next two Turns", async () => {
    await ownerWithConnection(9917);
    scriptModel([searchCall, { say: "Three pages" }]);
    await say(9917, "list my pages", 0);
    await say(9917, "thanks", 1);
    const second = fakeModel.doGenerateCalls.at(-1)?.prompt ?? [];

    await say(9917, "bye", 2);

    const third = fakeModel.doGenerateCalls.at(-1)?.prompt ?? [];
    expect(second.map((message) => message.role)).toContain("tool");
    expect(JSON.stringify(third.slice(0, second.length))).toBe(
      JSON.stringify(second)
    );
  });

  it("calls the tool with the second id from the Stub in a later Turn", async () => {
    await ownerWithConnection(9916);
    scriptModel([searchCall, { say: "Three pages" }]);
    await say(9916, "list my pages", 0);
    scriptModel([
      callOf("fetch", { id: fakeMcpPages[1].id }),
      { say: "Trip plan" },
    ]);

    await say(9916, "open the second one", 1);

    const secondTurnPrompt = JSON.stringify(
      fakeModel.doGenerateCalls.find((call) =>
        JSON.stringify(call.prompt).includes("open the second one")
      )?.prompt ?? []
    );
    expect(secondTurnPrompt).toContain(fakeMcpPages[1].id);
    expect(fakeMcpServer.calls.at(-1)).toEqual({
      tool: "fetch",
      arguments: { id: fakeMcpPages[1].id },
    });
  });
});

describe("the Risk Class of an MCP call", () => {
  it.each([
    ["create_page", { title: "New" }],
    ["archive_page", { id: "1" }],
    ["wipe_workspace", {}],
  ])("does not run %s without Approval", async (tool, args) => {
    await ownerWithConnection(9920 + tool.length);
    scriptModel([callOf(tool, args), { say: "Could not do it" }]);

    await say(9920 + tool.length, `run ${tool}`, 0);

    expect(fakeMcpServer.calls).toEqual([]);
  });
});

describe("lazy connect", () => {
  it("connects a server on its first call after the hub restarts, and not before", async () => {
    await ownerWithConnection(9930);
    await abortAllDurableObjects();
    const requestsBefore = fakeMcpServer.requests;
    scriptModel([{ say: "Hi" }]);
    await say(9930, "hello", 0);
    expect(fakeMcpServer.requests).toBe(requestsBefore);
    scriptModel([searchCall, { say: "Three pages" }]);

    await say(9930, "list my pages", 1);

    expect(fakeMcpServer.requests).toBeGreaterThan(requestsBefore);
    expect(fakeMcpServer.calls).toEqual([
      { tool: "search", arguments: { query: "pages" } },
    ]);
  });

  it("fails a call for a Connection that the hub does not know", async () => {
    await addOwner(9931);

    const outcome = await env.MCP_HUB.getByName("unknown-owner").callTool({
      catalogId: testMcpCatalogId,
      tool: "search",
      arguments: {},
      connectTimeoutMillis: 1000,
      callTimeoutMillis: 1000,
    });

    expect(outcome).toEqual({ _tag: "Failed", reason: "not_connected" });
    expect(fakeMcpServer.requests).toBe(0);
  });
});

describe("the Owner Context Block", () => {
  it("is replaced one time by a state change while the system text and the tools stay the same", async () => {
    const ownerId = await ownerWithConnection(9940);
    scriptModel([{ say: "One" }]);
    await say(9940, "first", 0);
    const firstCall = fakeModel.doGenerateCalls.at(-1);
    await runInDurableObject(await agentOf(ownerId), (agent) =>
      agent.receiveMcpConnectionState(testMcpCatalogId, "needs_sign_in")
    );
    scriptModel([{ say: "Two" }]);

    await say(9940, "second", 1);

    const secondCall = fakeModel.doGenerateCalls.at(-1);
    expect(systemTextOf(secondCall?.prompt ?? [])).toBe(
      systemTextOf(firstCall?.prompt ?? [])
    );
    expect(JSON.stringify(secondCall?.tools)).toBe(
      JSON.stringify(firstCall?.tools)
    );
    expect(ownerContextBlockOf(firstCall?.prompt ?? [])).toContain(
      "Test server): ready"
    );
    expect(ownerContextBlockOf(secondCall?.prompt ?? [])).toContain(
      "Test server): needs a new sign-in"
    );
  });
});
