import { beforeEach, describe, expect, it, vi } from "vitest";

import { connectMcpServerToolName } from "../src/mcp/mcp-tool-names.ts";
import { reactToolName } from "../src/personal-agent/react-tool.ts";
import { staySilentToolName } from "../src/personal-agent/stay-silent-tool.ts";
import { fakeModel, fakeTelegram, fakeTool, resetFakes } from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

const firstCall = () => fakeModel.doGenerateCalls[0];

const systemPromptOfFirstCall = () => {
  const system = firstCall()?.prompt.find(
    (message) => message.role === "system"
  );
  return system?.role === "system" ? system.content : "";
};

const toolNamesOfFirstCall = () =>
  (firstCall()?.tools ?? [])
    .map((tool) => tool.name)
    .filter((name) => name !== fakeTool.name);

const descriptionOfFirstCall = (toolName: string) => {
  const tool = (firstCall()?.tools ?? []).find(
    (candidate) => candidate.name === toolName
  );
  return tool?.type === "function" ? tool.description : "";
};

beforeEach(() => {
  resetFakes();
});

describe("Capabilities in the system prompt", () => {
  it("names every tool of an Owner message Turn and says what the agent cannot do", async () => {
    await addOwner(8301);
    await telegramWebhook(
      textUpdate({ fromUserId: 8301, text: "what can you do?" })
    );
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1), {
      timeout: 10_000,
    });

    const prompt = systemPromptOfFirstCall();
    const toolNames = toolNamesOfFirstCall();
    expect(toolNames.length).toBeGreaterThan(0);
    for (const toolName of toolNames) {
      expect(prompt).toContain(toolName);
    }
    expect(prompt).toContain("never from your earlier replies");
    expect(prompt).toContain("You cannot open links");
    expect(prompt).toContain(
      "a tool that the catalog does not list, a tool whose definition is not pinned, and a tool that the server marks destructive wait for the Owner to approve them"
    );
    expect(prompt).not.toContain("Only reading tools run now");
  });

  it("tells the model that only a call of connect_mcp_server sends the Connect button", async () => {
    await addOwner(8306);
    await telegramWebhook(
      textUpdate({ fromUserId: 8306, text: "connect the test server" })
    );
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1), {
      timeout: 10_000,
    });

    const prompt = systemPromptOfFirstCall();
    expect(prompt).toContain(
      `Code sends the Connect or Reconnect button of a service only after a call of ${connectMcpServerToolName} succeeded in this Turn`
    );
    expect(prompt).toContain(
      "never say that a Connect or Reconnect button comes"
    );
    expect(prompt).toContain("any service whose state is not ready");
    expect(descriptionOfFirstCall(connectMcpServerToolName)).toContain(
      "Without a successful call of this tool in this Turn, no Connect button comes"
    );
  });

  it("offers stay_silent and react in an Owner message Turn, also for an untrusted Event", async () => {
    await addOwner(8302);
    await telegramWebhook(textUpdate({ fromUserId: 8302, text: "ok" }));
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1), {
      timeout: 10_000,
    });
    expect(toolNamesOfFirstCall()).toContain(staySilentToolName);
    expect(systemPromptOfFirstCall()).toContain(staySilentToolName);
    expect(toolNamesOfFirstCall()).toContain(reactToolName);
    expect(systemPromptOfFirstCall()).toContain(`call ${reactToolName}`);

    resetFakes();
    await addOwner(8303);
    await telegramWebhook(
      textUpdate({
        fromUserId: 8303,
        text: "ok",
        forwardOrigin: {
          type: "user",
          sender_user: { id: 5, is_bot: false, first_name: "Ana" },
          date: 1_794_000_000,
        },
      })
    );
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1), {
      timeout: 10_000,
    });
    expect(toolNamesOfFirstCall()).toContain(staySilentToolName);
    expect(systemPromptOfFirstCall()).toContain(staySilentToolName);
    expect(toolNamesOfFirstCall()).toContain(reactToolName);
    expect(systemPromptOfFirstCall()).toContain(`call ${reactToolName}`);
  });
});
