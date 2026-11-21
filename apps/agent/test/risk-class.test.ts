import type { ModelMessage, ToolResultPart } from "ai";
import { env, runInDurableObject } from "cloudflare:test";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { riskClasses, riskClassified } from "../src/approval/risk-class.ts";
import type { RiskClass } from "../src/approval/risk-class.ts";
import {
  blockedCallReason,
  gateDecisionOf,
} from "../src/approval/tool-gate.ts";
import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";
import { agentTool } from "../src/model-gateway/agent-tool.ts";
import type { AgentTools } from "../src/model-gateway/agent-tool.ts";
import type { ModelStep } from "../src/model-gateway/model-step.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { agentToolServices } from "../src/personal-agent/agent-tool-services.ts";
import type { Burst } from "../src/personal-agent/burst.ts";
import { refusalOfOutcomeTool } from "../src/personal-agent/outcome-refusal.ts";
import { ownerMessageTools } from "../src/personal-agent/owner-message-tools.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { proactiveTools } from "../src/personal-agent/proactive-tools.ts";
import { scheduledTaskTools } from "../src/personal-agent/scheduled-task-tools.ts";
import {
  silenceAfterFailureMessage,
  staySilentTool,
  staySilentToolName,
} from "../src/personal-agent/stay-silent-tool.ts";
import { Redactor } from "../src/tracing/redactor.ts";

const readTools = new Set([
  "search_notes",
  "list_linked_notes",
  "list_open_loops",
  "list_schedules",
  "stay_silent",
  "react",
]);

const expectedRiskClassOf = (toolName: string): RiskClass =>
  readTools.has(toolName) ? "read" : "change";

const burstOf = (forwardOrigin?: string): Burst => [
  {
    _tag: "OwnerMessage",
    eventId: "event-1",
    receivedAt: "2026-11-21T09:00:00.000Z",
    state: "pending",
    channel: "telegram",
    channelUpdateId: "update-1",
    conversationId: "1",
    channelMessageId: "1",
    text: "hello",
    sentAt: "2026-11-21T09:00:00.000Z",
    ...(forwardOrigin === undefined ? {} : { forwardOrigin }),
  },
];

const everyToolSet = async (): Promise<Record<string, AgentTools>> =>
  runInDurableObject(
    await personalAgentFor(
      env.PERSONAL_AGENT,
      OwnerIdSchema.make("risk-class-owner")
    ),
    (instance) =>
      instance.runtime.runPromise(
        Effect.gen(function* everyToolSetEffect() {
          const services = {
            ...(yield* agentToolServices),
            behavior: defaultBehaviorConfig,
          };
          return {
            ownerMessage: ownerMessageTools(burstOf(), services),
            forwardedMessage: ownerMessageTools(burstOf("Ana"), services),
            proactive: proactiveTools("event-1", services),
            scheduledTask: scheduledTaskTools("event-1", services),
          };
        }).pipe(Effect.provide(Redactor.layer([env.AI_GATEWAY_TOKEN])))
      )
  );

describe("Risk Class", () => {
  it("is declared by every tool in every tool set, read for reading and outcome tools and change for the rest", async () => {
    const toolSets = await everyToolSet();

    for (const [toolSetName, tools] of Object.entries(toolSets)) {
      expect(Object.keys(tools).length, toolSetName).toBeGreaterThan(0);
      for (const [toolName, tool] of Object.entries(tools)) {
        const where = `${toolName} in ${toolSetName}`;
        expect(riskClasses, where).toContain(tool.riskClass);
        expect(tool.riskClass, where).toBe(expectedRiskClassOf(toolName));
      }
    }
  });

  it("can be raised by the input function", () => {
    const tool = riskClassified<{ readonly wide: boolean }>("read", (input) =>
      input.wide ? "approve" : "read"
    );

    expect(tool.riskClassOf({ wide: true })).toBe("approve");
    expect(tool.riskClassOf({ wide: false })).toBe("read");
  });

  it("is never lowered by the input function", () => {
    const tool = riskClassified("blocked", () => "read");

    expect(tool.riskClassOf({})).toBe("blocked");
    expect(gateDecisionOf({ tool, input: {}, trustLevel: "owner" })).toEqual({
      _tag: "Deny",
      reason: blockedCallReason,
    });
  });
});

describe("The gate", () => {
  it("denies a blocked call and runs every other class in both Trust Levels", () => {
    for (const trustLevel of ["owner", "untrusted"] as const) {
      for (const riskClass of riskClasses) {
        const decision = gateDecisionOf({
          tool: riskClassified(riskClass),
          input: {},
          trustLevel,
        });
        expect(decision, `${riskClass} in ${trustLevel}`).toEqual(
          riskClass === "blocked"
            ? { _tag: "Deny", reason: blockedCallReason }
            : { _tag: "Run" }
        );
      }
    }
  });
});

const readWordTool = (
  riskClassOfInput?: (input: { readonly word: string }) => RiskClass
) =>
  agentTool({
    description: "Read a word",
    inputSchema: z.object({ word: z.string() }),
    riskClass: "read",
    ...(riskClassOfInput === undefined ? {} : { riskClassOfInput }),
    execute: ({ word }) => Effect.succeed({ word }),
  });

const refusalTools = {
  peek: readWordTool(({ word }) => (word === "secret" ? "blocked" : "read")),
  look: readWordTool(),
  [staySilentToolName]: staySilentTool,
};

const failedCall = (
  toolName: keyof typeof refusalTools,
  word: string,
  output: ToolResultPart["output"]
): readonly ModelMessage[] => [
  {
    role: "assistant",
    content: [
      { type: "tool-call", toolCallId: "call-1", toolName, input: { word } },
    ],
  },
  {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "call-1", toolName, output }],
  },
];

const deniedOutput = {
  type: "execution-denied",
  reason: blockedCallReason,
} as const;

const errorOutput = { type: "error-text", value: "The store is down" } as const;

const stepWith = (responseMessages: readonly ModelMessage[]): ModelStep => ({
  usage: {
    inputTokens: undefined,
    outputTokens: undefined,
    cachedInputTokens: undefined,
    costUsd: undefined,
  },
  toolCalls: [],
  responseMessages,
});

const silenceRefusalAfter = async (
  ownerId: string,
  calls: {
    readonly inThisRun?: readonly ModelMessage[];
    readonly recorded?: readonly ModelMessage[];
  }
) =>
  runInDurableObject(
    await personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId)),
    (instance) =>
      instance.runtime.runPromise(
        refusalOfOutcomeTool({
          eventId: "event-1",
          name: staySilentToolName,
          steps:
            calls.inThisRun === undefined ? [] : [stepWith(calls.inThisRun)],
          earlierMessages: calls.recorded ?? [],
          tools: refusalTools,
        })
      )
  );

describe("The outcome-refusal rules", () => {
  it("read the class of a call in this run from its input, so a read tool that its input raised to blocked refuses silence", async () => {
    const refusal = await silenceRefusalAfter("refusal-raised-owner", {
      inThisRun: failedCall("peek", "secret", deniedOutput),
    });

    expect(refusal).toBe(silenceAfterFailureMessage);
  });

  it("allow silence after a failed read call in this run", async () => {
    const refusal = await silenceRefusalAfter("refusal-read-owner", {
      inThisRun: failedCall("peek", "plain", errorOutput),
    });

    expect(refusal).toBeUndefined();
  });

  it("count a recorded failed call as changing when the class of its tool depends on the input, because the recorded input can differ", async () => {
    const refusal = await silenceRefusalAfter("refusal-recorded-owner", {
      recorded: failedCall("peek", "plain", errorOutput),
    });

    expect(refusal).toBe(silenceAfterFailureMessage);
  });

  it("allow silence after a recorded failed call of a tool that reads for every input", async () => {
    const refusal = await silenceRefusalAfter("refusal-recorded-read-owner", {
      recorded: failedCall("look", "plain", errorOutput),
    });

    expect(refusal).toBeUndefined();
  });
});
