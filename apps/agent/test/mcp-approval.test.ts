import {
  abortAllDurableObjects,
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeMcpInjection } from "../control/fake-mcp-server.ts";
import { blockedCallReason } from "../src/approval/tool-gate.ts";
import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";
import { testMcpCatalogId } from "../src/mcp/mcp-test-catalog.ts";
import { callMcpToolToolName } from "../src/mcp/mcp-tool-names.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import {
  fakeMcpServer,
  fakeModel,
  fakeTelegram,
  resetFakes,
  scriptModel,
} from "./fakes.ts";
import {
  addOwner,
  pressUpdate,
  telegramWebhook,
  textUpdate,
} from "./telegram-requests.ts";

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

interface ApprovalRow extends Record<string, SqlStorageValue> {
  pending_approval_id: string;
  tool_name: string;
  summary: string;
  state: string;
  channel_message_id: string | null;
}

const approvalsOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (_, state) =>
    state.storage.sql
      .exec<ApprovalRow>("SELECT * FROM pending_approvals ORDER BY position")
      .toArray()
  );

const statesOf = async (ownerId: string) => {
  const rows = await approvalsOf(ownerId);
  return rows.map((row) => row.state);
};

const ownerWithConnection = async (telegramUserId: number) => {
  const ownerId = await addOwner(telegramUserId);
  await env.MCP_HUB.getByName(ownerId).addConnection(
    testMcpCatalogId,
    defaultBehaviorConfig.mcpConnectTimeoutMillis
  );
  return ownerId;
};

const say = async (telegramUserId: number, text: string, sentSoFar: number) => {
  await telegramWebhook(textUpdate({ fromUserId: telegramUserId, text }));
  await vi.waitFor(() =>
    expect(fakeTelegram.sent.length).toBeGreaterThan(sentSoFar)
  );
};

const callOf = (tool: string, args: Record<string, unknown> = {}) => ({
  callTool: callMcpToolToolName,
  input: { connection: testMcpCatalogId, tool, arguments: args },
});

const toolOutputOf = () => {
  const prompt = fakeModel.doGenerateCalls.at(-1)?.prompt ?? [];
  const part = prompt
    .flatMap((message) => (message.role === "tool" ? message.content : []))
    .findLast(
      (candidate) =>
        candidate.type === "tool-result" &&
        candidate.toolName === callMcpToolToolName
    );
  return JSON.stringify(part?.type === "tool-result" ? part.output : undefined);
};

const askFor = async (
  userId: number,
  tool: string,
  args: Record<string, unknown>
) => {
  const ownerId = await ownerWithConnection(userId);
  scriptModel([callOf(tool, args), { say: "This waits for your Approval." }]);
  await say(userId, `run ${tool}`, 0);
  const [approval] = await vi.waitFor(async () => {
    const rows = await approvalsOf(ownerId);
    expect(rows.filter((row) => row.state === "pending")).toHaveLength(1);
    return rows;
  });
  return { ownerId, approval: approval as ApprovalRow };
};

const press = (userId: number, data: string, messageId: number) =>
  telegramWebhook(pressUpdate({ fromUserId: userId, data, messageId }));

beforeEach(() => {
  resetFakes();
});

describe("Approval for an MCP call that changes a service", () => {
  it("shows the template line with Approve, Reject, and Details and runs nothing", async () => {
    const { approval } = await askFor(9950, "create_page", { title: "New" });

    expect(approval.summary).toBe('Test server: create page "New"');
    const request = fakeTelegram.sent.at(-1);
    expect(request?.body.reply_markup?.inline_keyboard[0]).toEqual([
      {
        text: "Approve",
        callback_data: `approve:${approval.pending_approval_id}`,
      },
      {
        text: "Reject",
        callback_data: `reject:${approval.pending_approval_id}`,
      },
      {
        text: "Details",
        callback_data: `details:${approval.pending_approval_id}`,
      },
    ]);
    expect(fakeMcpServer.calls).toEqual([]);
  });

  it("uses the generic line for a tool that the catalog does not list", async () => {
    fakeMcpServer.listHiddenTools();

    const { approval } = await askFor(9951, "hidden_new_tool", {});

    expect(approval.summary).toBe("Test server: hidden new tool");
    expect(fakeMcpServer.calls).toEqual([]);
  });

  it("sends the full arguments as a file on Details and leaves the Approval pending", async () => {
    const { ownerId, approval } = await askFor(9952, "create_page", {
      title: "New page with a long title",
    });

    await press(
      9952,
      `details:${approval.pending_approval_id}`,
      Number(approval.channel_message_id)
    );
    await vi.waitFor(() => expect(fakeTelegram.documents).toHaveLength(1));

    expect(fakeTelegram.documents[0]?.filename).toBe(
      `approval-${approval.pending_approval_id}.txt`
    );
    expect(JSON.parse(fakeTelegram.documents[0]?.text ?? "")).toEqual({
      connection: testMcpCatalogId,
      tool: "create_page",
      arguments: { title: "New page with a long title" },
    });
    expect(await statesOf(ownerId)).toEqual(["pending"]);
    expect(fakeMcpServer.calls).toEqual([]);
  });

  it("runs the exact frozen call once on Approve and shows the done status", async () => {
    const { ownerId, approval } = await askFor(9953, "create_page", {
      title: "New",
    });

    await press(
      9953,
      `approve:${approval.pending_approval_id}`,
      Number(approval.channel_message_id)
    );
    await vi.waitFor(async () =>
      expect(await statesOf(ownerId)).toEqual(["executed"])
    );

    expect(fakeMcpServer.calls).toEqual([
      { tool: "create_page", arguments: { title: "New" } },
    ]);
    await vi.waitFor(() =>
      expect(fakeTelegram.edits.at(-1)?.body.text).toContain("Approved, done")
    );
  });

  it("needs Approval for a read tool that the server marks destructive", async () => {
    await askFor(9954, "archive_page", { id: "1" });

    expect(fakeMcpServer.calls).toEqual([]);
  });

  it("never runs a blocked tool and gives the model the reason", async () => {
    const ownerId = await ownerWithConnection(9955);
    scriptModel([callOf("wipe_workspace"), { say: "I cannot do that" }]);

    await say(9955, "wipe it", 0);

    expect(fakeMcpServer.calls).toEqual([]);
    expect(await approvalsOf(ownerId)).toEqual([]);
    expect(toolOutputOf()).toContain(blockedCallReason);
  });

  it("refuses arguments that do not match the cached input schema before the gate", async () => {
    const ownerId = await ownerWithConnection(9956);
    scriptModel([
      callOf("create_page", { title: 5 }),
      { say: "Bad arguments" },
    ]);

    await say(9956, "create a page", 0);

    expect(fakeMcpServer.calls).toEqual([]);
    expect(await approvalsOf(ownerId)).toEqual([]);
    expect(toolOutputOf()).toContain("do not match the input schema");
  });

  it("runs a change tool in an owner Turn and needs Approval after an MCP result", async () => {
    const ownerId = await ownerWithConnection(9957);
    const rename = callOf("rename_page", { id: "1", title: "Renamed" });
    scriptModel([rename, { say: "Renamed" }]);
    await say(9957, "rename page 1", 0);
    expect(fakeMcpServer.calls).toEqual([
      { tool: "rename_page", arguments: { id: "1", title: "Renamed" } },
    ]);
    expect(await approvalsOf(ownerId)).toEqual([]);
    scriptModel([
      callOf("poisoned_read"),
      callOf("rename_page", { id: "2", title: fakeMcpInjection }),
      { say: "Waiting" },
    ]);

    await say(9957, "read then rename", 1);

    await vi.waitFor(async () =>
      expect(await statesOf(ownerId)).toEqual(["pending"])
    );
    expect(fakeMcpServer.calls).toHaveLength(2);
  });

  it("runs the approved call once and shows unconfirmed after the Durable Object aborts during it", async () => {
    const { ownerId, approval } = await askFor(9958, "slow_write", {
      title: "Slow",
    });
    await press(
      9958,
      `approve:${approval.pending_approval_id}`,
      Number(approval.channel_message_id)
    );
    await vi.waitFor(() => expect(fakeMcpServer.calls).toHaveLength(1));

    await abortAllDurableObjects();
    await runDurableObjectAlarm(await agentOf(ownerId));

    await vi.waitFor(async () =>
      expect(await statesOf(ownerId)).toEqual(["unconfirmed"])
    );
    expect(fakeMcpServer.calls).toHaveLength(1);
  });
});
