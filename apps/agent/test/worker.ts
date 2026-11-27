import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { z } from "zod";

import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";
import { telegramChannel } from "../src/channels/telegram/telegram-channel.ts";
import { mcpHubClient } from "../src/mcp/mcp-hub-client.ts";
import { agentTool, ToolFailed } from "../src/model-gateway/agent-tool.ts";
import type { AgentTools } from "../src/model-gateway/agent-tool.ts";
import { ModelGateway } from "../src/model-gateway/model-gateway.ts";
import { ModelProvider } from "../src/model-gateway/model-provider.ts";
import type { OwnerId } from "../src/owner-id.ts";
import { PersonalAgent as LivePersonalAgent } from "../src/personal-agent/personal-agent.ts";
import type { TurnServices } from "../src/personal-agent/personal-agent.ts";
import { OperatorMetrics } from "../src/tracing/operator-metrics.ts";
import { Redactor } from "../src/tracing/redactor.ts";
import {
  fakeBurstWait,
  fakeCompletion,
  fakeMcpLimits,
  fakeMetrics,
  fakeModel,
  fakeTelegram,
  fakeTelegramApiUrl,
  fakeTool,
  fakeToolApprovalExpiryMillis,
  fakeTraceRetention,
  testTypingRepeatMillis,
} from "./fakes.ts";

export { default } from "../src/index.ts";
export { McpHub } from "./test-mcp-hub.ts";

const fakeTurnServicesOf = (ownerId: OwnerId): TurnServices =>
  Layer.mergeAll(
    OperatorMetrics.layer(fakeMetrics.dataset),
    Redactor.layer([
      env.TELEGRAM_BOT_TOKEN,
      env.AI_GATEWAY_TOKEN,
      env.TELEGRAM_WEBHOOK_SECRET,
      env.OPERATOR_TOKEN,
    ]),
    telegramChannel({
      apiUrl: fakeTelegramApiUrl,
      botToken: env.TELEGRAM_BOT_TOKEN,
      edgeUrl: env.EDGE_PUBLIC_URL,
      fetch: fakeTelegram.fetch,
    }),
    ModelGateway.layer.pipe(
      Layer.provide(
        Layer.succeed(ModelProvider, {
          route: () => ({ model: fakeModel, reasoningEffort: "none" }),
        })
      )
    ),
    mcpHubClient(env.MCP_HUB, ownerId)
  );

const keepWordTool = (description: string) =>
  agentTool({
    description,
    inputSchema: z.object({ word: z.string() }),
    riskClass: "change",
    approvalSummary: {
      isInput: (value): value is { word: string } =>
        z.object({ word: z.string() }).safeParse(value).success,
      of: ({ word }) => Effect.succeed(`Keep the word "${word}"`),
    },
    approvalExpiryMillis: fakeToolApprovalExpiryMillis,
    execute: ({ word }) =>
      fakeTool.failWith === undefined
        ? Effect.sync(() => {
            fakeTool.kept.push(word);
            return { kept: word };
          })
        : Effect.fail(new ToolFailed({ message: fakeTool.failWith })),
  });

const fakeTools: AgentTools = {
  get [fakeTool.name]() {
    return keepWordTool(fakeTool.description);
  },
};

const useFakeTurnServices = (_env: Env, ownerId: OwnerId) =>
  fakeTurnServicesOf(ownerId);

export class PersonalAgent extends LivePersonalAgent {
  override async receiveMcpConnected(
    ...args: Parameters<LivePersonalAgent["receiveMcpConnected"]>
  ) {
    if (fakeCompletion.failures > 0) {
      fakeCompletion.failures -= 1;
      throw new Error("The completion failed on purpose");
    }
    await super.receiveMcpConnected(...args);
    if (fakeCompletion.failuresAfterCommit > 0) {
      fakeCompletion.failuresAfterCommit -= 1;
      throw new Error("The completion result was lost");
    }
  }

  protected override readonly turnServices = useFakeTurnServices;
  protected override readonly turnTools = fakeTools;

  protected override readonly behavior = {
    ...defaultBehaviorConfig,
    typingRepeatMillis: testTypingRepeatMillis,
    get burstQuietMillis() {
      return fakeBurstWait.quietMillis;
    },
    get burstMaxWaitMillis() {
      return fakeBurstWait.maxWaitMillis;
    },
    get burstMaxRestarts() {
      return fakeBurstWait.maxRestarts;
    },
    get mcpCallTimeoutMillis() {
      return fakeMcpLimits.callTimeoutMillis;
    },
    get mcpResultMaxCharacters() {
      return fakeMcpLimits.resultMaxCharacters;
    },
    get traceRetentionDays() {
      return fakeTraceRetention.days;
    },
  };
}
