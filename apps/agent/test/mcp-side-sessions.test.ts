import { env, runInDurableObject } from "cloudflare:test";
import { DateTime, Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeMcpInjection, fakeMcpTools } from "../control/fake-mcp-server.ts";
import {
  blockedCallReason,
  untrustedChangeWithoutOwnerReason,
} from "../src/approval/tool-gate.ts";
import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";
import type { Journal } from "../src/journal/journal.ts";
import { McpConnections } from "../src/mcp/mcp-connections.ts";
import { testMcpCatalogId } from "../src/mcp/mcp-test-catalog.ts";
import {
  callMcpToolToolName,
  findMcpToolsToolName,
} from "../src/mcp/mcp-tool-names.ts";
import { closeOpenLoopToolName } from "../src/notes/close-open-loop-tool.ts";
import { Notes } from "../src/notes/notes.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import type { OwnerPreferences } from "../src/preferences/owner-preferences.ts";
import { setTimeZoneToolName } from "../src/preferences/set-time-zone-tool.ts";
import { briefPrompt } from "../src/schedule/brief-prompt.ts";
import { fixedFollowUpPrompt } from "../src/schedule/fixed-follow-up-prompt.ts";
import type { ScheduleAction } from "../src/schedule/schedule-action.ts";
import { Schedules } from "../src/schedule/schedules.ts";
import { setScheduleToolName } from "../src/schedule/set-schedule-tool.ts";
import {
  fakeMcpServer,
  fakeModel,
  fakeTelegram,
  resetFakes,
  scriptModel,
} from "./fakes.ts";
import { quietHoursAndBriefLaterToday } from "./quiet-hours-setup.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const inAgent = async <A, E>(
  ownerId: string,
  effect: Effect.Effect<
    A,
    E,
    Journal | McpConnections | Notes | OwnerPreferences | Schedules
  >
) =>
  runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.runtime.runPromise(effect)
  );

const rowsOf = async <Row extends Record<string, SqlStorageValue>>(
  ownerId: string,
  query: string
) =>
  runInDurableObject(await agentOf(ownerId), (_, state) =>
    state.storage.sql.exec<Row>(query).toArray()
  );

const ownerWithConnection = async (telegramUserId: number) => {
  const ownerId = await addOwner(telegramUserId);
  scriptModel([
    { callTool: setTimeZoneToolName, input: { timeZone: "Europe/Warsaw" } },
    { say: "Done" },
  ]);
  await telegramWebhook(
    textUpdate({ fromUserId: telegramUserId, text: "I live in Warsaw" })
  );
  await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
  await inAgent(ownerId, quietHoursAndBriefLaterToday("Europe/Warsaw"));
  expect(
    await env.MCP_HUB.getByName(ownerId).addConnection(
      testMcpCatalogId,
      defaultBehaviorConfig.mcpConnectTimeoutMillis
    )
  ).toEqual({ outcome: "added" });
  return ownerId;
};

const fire = async (ownerId: string, sendsAfter: number) => {
  await runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.fireDueSchedules()
  );
  await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(sendsAfter), {
    timeout: 10_000,
  });
};

const dueSchedule = async (ownerId: string, action: ScheduleAction) => {
  await inAgent(
    ownerId,
    Effect.gen(function* seedEffect() {
      const schedules = yield* Schedules;
      const now = yield* DateTime.now;
      yield* schedules.set({
        action,
        setBy: "owner",
        dueAt: DateTime.subtract(now, { seconds: 5 }),
        sourceEventId: `seed-${action._tag}`,
      });
    })
  );
};

const makeBriefDue = async (ownerId: string) => {
  await runInDurableObject(await agentOf(ownerId), (_, state) => {
    state.storage.sql.exec(
      "UPDATE schedules SET next_due_at = ? WHERE text = ?",
      DateTime.formatIso(
        DateTime.subtract(DateTime.nowUnsafe(), { seconds: 5 })
      ),
      briefPrompt
    );
  });
};

const taskPrompt = "Tell me about my pages";

const runScheduledTask = async (ownerId: string) => {
  await dueSchedule(ownerId, { _tag: "RunPrompt", prompt: taskPrompt });
  await fire(ownerId, 2);
};

const runBrief = async (ownerId: string) => {
  await makeBriefDue(ownerId);
  await fire(ownerId, 2);
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

const callOf = (tool: string, args: Record<string, unknown> = {}) => ({
  callTool: callMcpToolToolName,
  input: { connection: testMcpCatalogId, tool, arguments: args },
});

const pendingApprovalCount = async (ownerId: string) => {
  const [row] = await rowsOf<{ count: number }>(
    ownerId,
    "SELECT COUNT(*) AS count FROM pending_approvals"
  );
  return row?.count;
};

const writeBacksOf = (ownerId: string) =>
  rowsOf<{ trust_level: string; message: string }>(
    ownerId,
    "SELECT trust_level, message FROM conversation_messages WHERE kind = 'write_back'"
  );

beforeEach(() => {
  resetFakes();
});

const multiTurnTimeout = { timeout: 30_000 };

describe("a read MCP call in a Side Session", multiTurnTimeout, () => {
  it("runs in a Scheduled Task Turn, reaches the model, and the untrusted Write-back keeps the sent text and names the Connection", async () => {
    const ownerId = await ownerWithConnection(9951);
    scriptModel([callOf("search", { query: "pages" }), { say: "Three pages" }]);

    await runScheduledTask(ownerId);

    expect(fakeMcpServer.calls).toEqual([
      { tool: "search", arguments: { query: "pages" } },
    ]);
    expect(JSON.stringify(toolOutputOf(callMcpToolToolName))).toContain(
      "Reading list"
    );
    expect(fakeTelegram.sent[1]?.body.text).toBe("Three pages");
    const [writeBack] = await writeBacksOf(ownerId);
    expect(writeBack?.trust_level).toBe("untrusted");
    expect(writeBack?.message).toContain("Three pages");
    expect(writeBack?.message).toContain("(read: Test server)");
    expect(writeBack?.message).not.toContain("Reading list");
  });

  it("runs in the Brief and reaches the model", async () => {
    const ownerId = await ownerWithConnection(9952);
    scriptModel([callOf("search", { query: "pages" }), { say: "Your day" }]);

    await runBrief(ownerId);

    expect(fakeMcpServer.calls).toEqual([
      { tool: "search", arguments: { query: "pages" } },
    ]);
    expect(JSON.stringify(toolOutputOf(callMcpToolToolName))).toContain(
      "Reading list"
    );
    expect(fakeTelegram.sent[1]?.body.text).toBe("Your day");
    const writeBacks = await writeBacksOf(ownerId);
    expect(writeBacks.map((row) => row.trust_level)).toEqual(["untrusted"]);
  });
});

describe(
  "an MCP call that is not read in a Side Session",
  multiTurnTimeout,
  () => {
    it.each([
      [9953, "an approve tool", callOf("create_page", { title: "Plan" })],
      [
        9957,
        "a change tool",
        callOf("rename_page", { id: "1", title: "Plan" }),
      ],
      [
        9958,
        "a read tool that the server marks destructive",
        callOf("archive_page", { id: "1" }),
      ],
      [9959, "a blocked tool", callOf("wipe_workspace")],
    ])(
      "denies %s in the Brief, with the reason and no Pending Approval",
      async (telegramUserId, _, call) => {
        const ownerId = await ownerWithConnection(telegramUserId);
        scriptModel([call, { say: "I could not do it" }]);

        await runBrief(ownerId);

        expect(toolOutputOf(callMcpToolToolName)).toEqual({
          type: "execution-denied",
          reason: blockedCallReason,
        });
        expect(fakeMcpServer.calls).toEqual([]);
        expect(await pendingApprovalCount(ownerId)).toBe(0);
        expect(fakeTelegram.sent[1]?.body.text).toBe("I could not do it");
      }
    );

    it("denies an approve tool in a Scheduled Task Turn", async () => {
      const ownerId = await ownerWithConnection(9954);
      scriptModel([callOf("create_page", { title: "Plan" }), { say: "No" }]);

      await runScheduledTask(ownerId);

      expect(toolOutputOf(callMcpToolToolName)).toEqual({
        type: "execution-denied",
        reason: blockedCallReason,
      });
      expect(fakeMcpServer.calls).toEqual([]);
      expect(await pendingApprovalCount(ownerId)).toBe(0);
    });
  }
);

describe(
  "a Brief that read an MCP result with instructions",
  multiTurnTimeout,
  () => {
    it("denies close_open_loop, stores the fixed prompt for set_schedule, and creates no Pending Approval", async () => {
      const ownerId = await ownerWithConnection(9955);
      const { note } = await inAgent(
        ownerId,
        Notes.pipe(
          Effect.flatMap((notes) =>
            notes.capture({
              text: "Buy a gift for Ana",
              source: {
                eventId: "seed",
                channel: "telegram",
                conversationId: "1",
                channelMessageId: "1",
                trustLevel: "owner",
              },
              openLoop: { kind: "task" },
            })
          )
        )
      );
      scriptModel([
        callOf("poisoned_read"),
        {
          callTool: setScheduleToolName,
          input: {
            action: { _tag: "RunPrompt", prompt: fakeMcpInjection },
            localDueTime: "2099-01-01T09:00",
            openLoopIds: [note.noteId],
          },
        },
        {
          callTool: closeOpenLoopToolName,
          input: { noteId: note.noteId, reason: "done" },
        },
        { say: "Good morning" },
      ]);

      await runBrief(ownerId);

      expect(toolOutputOf(closeOpenLoopToolName)).toEqual({
        type: "execution-denied",
        reason: untrustedChangeWithoutOwnerReason,
      });
      expect(
        await rowsOf<{ text: string }>(
          ownerId,
          `SELECT text FROM schedules WHERE set_by = 'agent' AND text != '${briefPrompt}'`
        )
      ).toEqual([{ text: fixedFollowUpPrompt([note.noteId]) }]);
      expect(
        await inAgent(
          ownerId,
          Notes.pipe(
            Effect.flatMap((notes) => notes.openLoopsAmong([note.noteId]))
          )
        )
      ).toHaveLength(1);
      expect(await pendingApprovalCount(ownerId)).toBe(0);
    });
  }
);

describe(
  "the Write-back of a Side Session that read server text",
  multiTurnTimeout,
  () => {
    it("names the Connection for a call that returned an error text", async () => {
      const ownerId = await ownerWithConnection(9960);
      scriptModel([callOf("failing_read"), { say: "Nothing to report" }]);

      await runBrief(ownerId);

      const [writeBack] = await writeBacksOf(ownerId);
      expect(writeBack?.trust_level).toBe("untrusted");
      expect(writeBack?.message).toContain("(read: Test server)");
    });

    it("names the Connection for a search that returned an unpinned definition, and not the tool", async () => {
      fakeMcpServer.useTools(
        fakeMcpTools.map((tool) =>
          tool.name === "search"
            ? { ...tool, description: "A changed search" }
            : tool
        )
      );
      const ownerId = await ownerWithConnection(9961);
      scriptModel([
        {
          callTool: findMcpToolsToolName,
          input: { connection: testMcpCatalogId, query: "search" },
        },
        { say: "Nothing to report" },
      ]);

      await runBrief(ownerId);

      const [writeBack] = await writeBacksOf(ownerId);
      expect(writeBack?.trust_level).toBe("untrusted");
      expect(writeBack?.message).toContain("(read: Test server)");
      expect(writeBack?.message).not.toContain("find_mcp_tools");
    });

    it("names no Connection for a search that returned only pinned definitions", async () => {
      const ownerId = await ownerWithConnection(9962);
      scriptModel([
        {
          callTool: findMcpToolsToolName,
          input: { connection: testMcpCatalogId, query: "search" },
        },
        { say: "Nothing to report" },
      ]);

      await runBrief(ownerId);

      const [writeBack] = await writeBacksOf(ownerId);
      expect(writeBack?.kind).toBe("write_back");
      expect(writeBack?.message).not.toContain("Test server");
    });
  }
);

describe(
  "a Side Session with a Connection that is not ready",
  multiTurnTimeout,
  () => {
    it("continues the Turn without it and still sends the message", async () => {
      const ownerId = await ownerWithConnection(9956);
      await inAgent(
        ownerId,
        McpConnections.pipe(
          Effect.flatMap((connections) =>
            connections.setState(testMcpCatalogId, "needs_sign_in")
          )
        )
      );
      scriptModel([
        callOf("search", { query: "pages" }),
        { say: "Without Notion" },
      ]);

      await makeBriefDue(ownerId);
      await fire(ownerId, 3);

      expect(fakeMcpServer.calls).toEqual([]);
      expect(JSON.stringify(toolOutputOf(callMcpToolToolName))).toContain(
        "in need of a new sign-in"
      );
      expect(fakeTelegram.sent[1]?.body.text).toBe("Without Notion");
      expect(fakeTelegram.sent[2]?.body.text).toBe("Reconnect Test server");

      const writeBacks = await writeBacksOf(ownerId);
      expect(writeBacks.map((row) => row.trust_level)).toEqual(["owner"]);
    });
  }
);

const markNeedsSignIn = (ownerId: string) =>
  inAgent(
    ownerId,
    McpConnections.pipe(
      Effect.flatMap((connections) =>
        connections.setState(testMcpCatalogId, "needs_sign_in")
      )
    )
  );

const reconnectButtonsOf = () =>
  fakeTelegram.sent.filter(({ body }) => body.text === "Reconnect Test server");

const fireDue = async (ownerId: string) => {
  await runInDurableObject(await agentOf(ownerId), (instance) =>
    instance.fireDueSchedules()
  );
  await vi.waitFor(() => expect(reconnectButtonsOf()).toHaveLength(1), {
    timeout: 10_000,
  });
};

describe(
  "a Connection that needs sign-in in a Side Session",
  multiTurnTimeout,
  () => {
    it("adds one reconnect button to the Brief message even when the model reads nothing", async () => {
      const ownerId = await ownerWithConnection(9981);
      await markNeedsSignIn(ownerId);
      scriptModel([{ say: "Your day, without the pages" }]);

      await makeBriefDue(ownerId);
      await fireDue(ownerId);

      expect(fakeTelegram.sent[1]?.body.text).toBe(
        "Your day, without the pages"
      );
      expect(fakeMcpServer.calls).toEqual([]);
      expect(reconnectButtonsOf()[0]?.body.reply_markup).toBeDefined();
    });

    it("adds one reconnect button to a Scheduled Task message, once, when the model also calls the Connection", async () => {
      const ownerId = await ownerWithConnection(9982);
      await markNeedsSignIn(ownerId);
      scriptModel([
        { ...callOf("search", { query: "pages" }), times: 2 },
        { say: "I could not read the pages, so this is not done" },
      ]);

      await dueSchedule(ownerId, { _tag: "RunPrompt", prompt: taskPrompt });
      await fireDue(ownerId);

      expect(fakeMcpServer.calls).toEqual([]);
      expect(JSON.stringify(toolOutputOf(callMcpToolToolName))).toContain(
        "Never say that it is done"
      );
      expect(reconnectButtonsOf()).toHaveLength(1);
    });
  }
);
