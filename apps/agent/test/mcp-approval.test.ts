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
import { untrustedContentOpening } from "../src/notes/note.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { failedApprovedCallMessage } from "../src/personal-agent/approval-result-turn.ts";
import { untrustedReplyStub } from "../src/personal-agent/conversation-stubs.ts";
import { honestFailureText } from "../src/personal-agent/delivery.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { unconfirmedToolMessage } from "../src/personal-agent/recorded-tool.ts";
import {
  fakeMcpLimits,
  fakeMcpServer,
  fakeModel,
  fakeTelegram,
  holdModel,
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

  it("still sends the Details file after the Approval was answered", async () => {
    const { approval } = await askFor(9961, "create_page", { title: "Done" });
    const messageId = Number(approval.channel_message_id);
    await press(9961, `reject:${approval.pending_approval_id}`, messageId);
    await vi.waitFor(() =>
      expect(fakeTelegram.edits.at(-1)?.body.text).toContain("Rejected")
    );

    await press(9961, `details:${approval.pending_approval_id}`, messageId);

    await vi.waitFor(() => expect(fakeTelegram.documents).toHaveLength(1));
  });

  it("tells the Owner when the Details file cannot be sent", async () => {
    const { approval } = await askFor(9962, "create_page", { title: "X" });
    fakeTelegram.refuseDocuments();
    const sentBefore = fakeTelegram.sent.length;

    await press(
      9962,
      `details:${approval.pending_approval_id}`,
      Number(approval.channel_message_id)
    );

    await vi.waitFor(() =>
      expect(fakeTelegram.sent.length).toBeGreaterThan(sentBefore)
    );
    expect(fakeTelegram.sent.at(-1)?.body.text).toContain("could not be sent");
  });

  it("shows failed when an approved call gets an error from the service", async () => {
    const { ownerId, approval } = await askFor(9959, "failing_write", {});

    await press(
      9959,
      `approve:${approval.pending_approval_id}`,
      Number(approval.channel_message_id)
    );

    await vi.waitFor(async () =>
      expect(await statesOf(ownerId)).toEqual(["failed"])
    );
    await vi.waitFor(() =>
      expect(fakeTelegram.edits.at(-1)?.body.text).toContain(
        "Approved, but it failed: The service reported an error"
      )
    );
  });

  it("shows unconfirmed when an approved call times out", async () => {
    fakeMcpLimits.callTimeoutMillis = 100;
    const { ownerId, approval } = await askFor(9960, "slow_write", {
      title: "Slow",
    });

    await press(
      9960,
      `approve:${approval.pending_approval_id}`,
      Number(approval.channel_message_id)
    );

    await vi.waitFor(async () =>
      expect(await statesOf(ownerId)).toEqual(["unconfirmed"])
    );
    expect(fakeMcpServer.calls).toHaveLength(1);
    await vi.waitFor(() =>
      expect(fakeTelegram.edits.at(-1)?.body.text).toContain(
        "Approved, but it is not confirmed that it ran"
      )
    );
  });

  it("logs the approved call with its result and duration, and no argument", async () => {
    fakeMcpLimits.callTimeoutMillis = 100;
    const { ownerId, approval } = await askFor(9965, "slow_write", {
      title: "Private title",
    });
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...parts) => {
      lines.push(parts.map(String).join(" "));
    });

    await press(
      9965,
      `approve:${approval.pending_approval_id}`,
      Number(approval.channel_message_id)
    );
    await vi.waitFor(async () =>
      expect(await statesOf(ownerId)).toEqual(["unconfirmed"])
    );
    log.mockRestore();

    const output = lines.join("\n");
    expect(output).toMatch(
      /"tool":"slow_write","outcome":"timed_out","durationMillis":\d+/u
    );
    expect(output).toMatch(
      /"step":"run_finished","toolName":"call_mcp_tool","result":"unconfirmed","durationMillis":\d+/u
    );
    expect(output).not.toContain("Private title");
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

interface ConversationRow extends Record<string, SqlStorageValue> {
  kind: string;
  message: string;
}

const conversationOf = async (ownerId: string) => {
  const rows = await runInDurableObject(await agentOf(ownerId), (_, state) =>
    state.storage.sql
      .exec<ConversationRow>(
        "SELECT kind, message FROM conversation_messages ORDER BY sequence"
      )
      .toArray()
  );
  return rows.map((row) => ({
    kind: row.kind,
    message: JSON.parse(row.message) as { role: string; content: unknown },
  }));
};

const lastToolResultIdOf = (
  prompt: (typeof fakeModel.doGenerateCalls)[number]["prompt"]
) =>
  prompt
    .flatMap((message) => (message.role === "tool" ? message.content : []))
    .findLast((part) => part.type === "tool-result")?.toolCallId;

const lastPromptText = () =>
  JSON.stringify(fakeModel.doGenerateCalls.at(-1)?.prompt ?? []);

const pressApprove = (userId: number, approval: ApprovalRow) =>
  press(
    userId,
    `approve:${approval.pending_approval_id}`,
    Number(approval.channel_message_id)
  );

const waitForSentAfter = (sentBefore: number, count = 1) =>
  vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(sentBefore + count), {
    timeout: 10_000,
  });

describe("The answer after an approved MCP call", { timeout: 40_000 }, () => {
  it("sends a new message that uses the result of an approved read", async () => {
    fakeMcpServer.listHiddenTools();
    const { approval } = await askFor(9970, "hidden_new_tool", {});
    const modelCalls = fakeModel.doGenerateCalls.length;
    scriptModel([{ say: "The service answered: ran hidden_new_tool." }]);

    const sentBefore = fakeTelegram.sent.length;
    await pressApprove(9970, approval);
    await waitForSentAfter(sentBefore);

    expect(fakeModel.doGenerateCalls).toHaveLength(modelCalls + 1);
    expect(toolOutputOf()).toContain("ran hidden_new_tool");
    expect(fakeTelegram.sent.at(-1)?.body.text).toBe(
      "The service answered: ran hidden_new_tool."
    );
    expect(fakeTelegram.sent.at(-1)?.body.reply_markup).toBeUndefined();
    await vi.waitFor(() =>
      expect(fakeTelegram.edits.at(-1)?.body.text).toContain("Approved, done")
    );
  });

  it("gives the result to the model as Untrusted Content and keeps only Stubs in the history", async () => {
    const { ownerId, approval } = await askFor(9971, "create_page", {
      title: "New",
    });
    scriptModel([{ say: "I created the page New." }]);

    const sentBefore = fakeTelegram.sent.length;
    await pressApprove(9971, approval);
    await waitForSentAfter(sentBefore);

    expect(toolOutputOf()).toContain(untrustedContentOpening);
    expect(toolOutputOf()).toContain('"status":"done"');
    expect(fakeTelegram.sent.at(-1)?.body.text).toBe("I created the page New.");
    await vi.waitFor(async () => {
      const rows = await conversationOf(ownerId);
      expect(rows.at(-1)).toEqual({
        kind: "reply",
        message: { role: "assistant", content: untrustedReplyStub },
      });
    });
    const stored = JSON.stringify(await conversationOf(ownerId));
    expect(stored).not.toContain("ran create_page");
    expect(stored).not.toContain(untrustedContentOpening);
    expect(stored).toContain(
      "[Result removed from the history. call_mcp_tool on connection test_server, tool create_page: done."
    );
  });

  it("makes the answering Turn untrusted, so a change call from the result waits for a tap", async () => {
    const { ownerId, approval } = await askFor(9972, "create_page", {
      title: "New",
    });
    scriptModel([
      callOf("rename_page", { id: "1", title: fakeMcpInjection }),
      { say: "The rename waits for your Approval." },
    ]);

    const sentBefore = fakeTelegram.sent.length;
    await pressApprove(9972, approval);
    await waitForSentAfter(sentBefore, 2);

    await vi.waitFor(async () =>
      expect(await statesOf(ownerId)).toEqual(["executed", "pending"])
    );
    expect(fakeMcpServer.calls).toEqual([
      { tool: "create_page", arguments: { title: "New" } },
    ]);
    const [, rename] = await approvalsOf(ownerId);
    expect(
      fakeTelegram.sent.at(-1)?.body.reply_markup?.inline_keyboard[0]
    ).toContainEqual({
      text: "Approve",
      callback_data: `approve:${rename?.pending_approval_id}`,
    });
    scriptModel([{ say: "Renamed." }]);

    await pressApprove(9972, rename as ApprovalRow);
    await waitForSentAfter(sentBefore, 3);

    await vi.waitFor(async () =>
      expect(await statesOf(ownerId)).toEqual(["executed", "executed"])
    );
    expect(fakeMcpServer.calls).toHaveLength(2);
    expect(fakeTelegram.sent.at(-1)?.body.text).toBe("Renamed.");
  });

  it("gives the model the failure of an approved call, never a done result", async () => {
    const { approval } = await askFor(9973, "failing_write", {});
    scriptModel([{ say: "The write failed." }]);

    const sentBefore = fakeTelegram.sent.length;
    await pressApprove(9973, approval);
    await waitForSentAfter(sentBefore);

    expect(toolOutputOf()).toContain(
      failedApprovedCallMessage("The service reported an error")
    );
    expect(toolOutputOf()).toContain("error-text");
    expect(fakeTelegram.sent.at(-1)?.body.text).toBe("The write failed.");
  });

  it("gives the model the unconfirmed outcome of an approved call that timed out", async () => {
    fakeMcpLimits.callTimeoutMillis = 100;
    const { approval } = await askFor(9974, "slow_write", { title: "Slow" });
    scriptModel([{ say: "I cannot confirm that it ran." }]);

    const sentBefore = fakeTelegram.sent.length;
    await pressApprove(9974, approval);
    await waitForSentAfter(sentBefore);

    expect(toolOutputOf()).toContain(unconfirmedToolMessage);
    expect(toolOutputOf()).not.toContain('"status":"done"');
    expect(fakeTelegram.sent.at(-1)?.body.text).toBe(
      "I cannot confirm that it ran."
    );
  });

  it("refuses silence and a reaction, so the Owner gets a text", async () => {
    const { approval } = await askFor(9975, "create_page", { title: "New" });
    scriptModel([
      { callTool: "stay_silent", input: {} },
      { say: "I created the page." },
    ]);

    const sentBefore = fakeTelegram.sent.length;
    await pressApprove(9975, approval);
    await waitForSentAfter(sentBefore);

    expect(lastPromptText()).toContain("must get a text reply");
    expect(fakeTelegram.sent.at(-1)?.body.text).toBe("I created the page.");
    expect(fakeTelegram.reactions).toEqual([]);
  });

  it("answers two approved calls with two ordered messages and no duplicate", async () => {
    const ownerId = await ownerWithConnection(9976);
    scriptModel([
      {
        callTools: [
          {
            tool: callMcpToolToolName,
            input: callOf("create_page", { title: "One" }).input,
          },
          {
            tool: callMcpToolToolName,
            input: callOf("create_page", { title: "Two" }).input,
          },
        ],
      },
      { say: "These wait for your Approval." },
    ]);
    await say(9976, "create two pages", 0);
    const [first, second] = await vi.waitFor(async () => {
      const rows = await approvalsOf(ownerId);
      expect(rows.filter((row) => row.state === "pending")).toHaveLength(2);
      return rows;
    });
    scriptModel([
      { say: "Page One is created." },
      { say: "Page Two is created." },
    ]);

    const sentBefore = fakeTelegram.sent.length;
    await Promise.all([
      pressApprove(9976, first as ApprovalRow),
      pressApprove(9976, second as ApprovalRow),
    ]);
    await waitForSentAfter(sentBefore, 2);
    await vi.waitFor(async () =>
      expect(await statesOf(ownerId)).toEqual(["executed", "executed"])
    );

    expect(
      fakeTelegram.sent.slice(sentBefore).map((request) => request.body.text)
    ).toEqual(["Page One is created.", "Page Two is created."]);
    const answeredIds = fakeModel.doGenerateCalls
      .slice(-2)
      .map((call) => lastToolResultIdOf(call.prompt));
    expect(answeredIds.toSorted()).toEqual(
      [first?.pending_approval_id, second?.pending_approval_id].toSorted()
    );
  });

  it("sends the honest failure text when the model gives no text for the answer", async () => {
    const { approval } = await askFor(9978, "create_page", { title: "New" });
    scriptModel([{ say: "" }]);

    const sentBefore = fakeTelegram.sent.length;
    await pressApprove(9978, approval);
    await waitForSentAfter(sentBefore);

    expect(fakeTelegram.sent.at(-1)?.body.text).toBe(honestFailureText);
  });

  it("answers once after the Durable Object aborts before the answer", async () => {
    const { ownerId, approval } = await askFor(9977, "create_page", {
      title: "New",
    });
    const sentBefore = fakeTelegram.sent.length;
    const releaseModel = holdModel(fakeModel.doGenerateCalls.length);
    scriptModel([{ say: "I created the page New." }]);
    await pressApprove(9977, approval);
    await vi.waitFor(async () =>
      expect(await statesOf(ownerId)).toEqual(["executed"])
    );

    await abortAllDurableObjects();
    releaseModel();
    scriptModel([
      { say: "I created the page New." },
      { say: "I created the page New." },
    ]);
    await runDurableObjectAlarm(await agentOf(ownerId));
    await waitForSentAfter(sentBefore);

    expect(fakeMcpServer.calls).toHaveLength(1);
    expect(
      fakeTelegram.sent.filter(
        (request) => request.body.text === "I created the page New."
      )
    ).toHaveLength(1);
  });
});
