import type { ModelMessage, ToolResultPart } from "ai";
import { env, runInDurableObject } from "cloudflare:test";
import { Effect, Predicate } from "effect";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { riskClasses, riskClassified } from "../src/approval/risk-class.ts";
import type { RiskClass, RiskClassified } from "../src/approval/risk-class.ts";
import {
  blockedCallReason,
  decisionAfterReview,
  gateDecisionOf,
  untrustedChangeWithoutOwnerReason,
} from "../src/approval/tool-gate.ts";
import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";
import { mcpHubClient } from "../src/mcp/mcp-hub-client.ts";
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
  "find_mcp_tools",
  "call_mcp_tool",
  "connect_mcp_server",
  "stay_silent",
  "react",
  "quiet_hours",
  "proactive_message_budget",
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
        }).pipe(
          Effect.provide(Redactor.layer([env.AI_GATEWAY_TOKEN])),
          Effect.provide(
            mcpHubClient(env.MCP_HUB, OwnerIdSchema.make("risk-class-owner"))
          )
        )
      )
  );

const gatedTool = (tool: RiskClassified, hasCodeWrittenInput = false) => ({
  ...tool,
  marksItsWorkUntrusted: () => false,
  hasCodeWrittenInput,
});

const WideInput = z.object({ wide: z.boolean() });

const isWideInput = (value: unknown): value is z.infer<typeof WideInput> =>
  WideInput.safeParse(value).success;

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

  it("is read for quiet_hours and proactive_message_budget with no value to change, and change otherwise", async () => {
    const { ownerMessage } = await everyToolSet();
    const quietHours = ownerMessage?.["quiet_hours"];
    const budget = ownerMessage?.["proactive_message_budget"];

    expect(quietHours?.riskClassOf({})).toBe("read");
    expect(quietHours?.riskClassOf({ start: "22:00" })).toBe("change");
    expect(quietHours?.riskClassOf({ start: "22:00", end: "07:00" })).toBe(
      "change"
    );
    expect(budget?.riskClassOf({})).toBe("read");
    expect(budget?.riskClassOf({ sends: 3 })).toBe("change");
  });

  it("can be raised by the input function", () => {
    const tool = riskClassified("read", {
      isInput: isWideInput,
      of: (input) => (input.wide ? "approve" : "read"),
    });

    expect(tool.riskClassOf({ wide: true })).toBe("approve");
    expect(tool.riskClassOf({ wide: false })).toBe("read");
  });

  it("stays the declared class for an input that does not match the input schema", () => {
    const tool = riskClassified("read", {
      isInput: isWideInput,
      of: () => "approve",
    });

    expect(tool.riskClassOf(null)).toBe("read");
    expect(tool.riskClassOf({ wide: "yes" })).toBe("read");
  });

  it("is never lowered by the input function", () => {
    const tool = riskClassified("blocked", {
      isInput: Predicate.isNotUndefined,
      of: () => "read",
    });

    expect(tool.riskClassOf({})).toBe("blocked");
    expect(
      gateDecisionOf({
        tool: gatedTool(tool),
        input: {},
        trustLevel: "owner",
        asksOwnerForApproval: true,
      })
    ).toEqual({
      _tag: "Deny",
      reason: blockedCallReason,
    });
  });
});

const expectedDecision = {
  owner: {
    read: { _tag: "Run" },
    change: { _tag: "Run" },
    approve: { _tag: "AskOwner" },
    blocked: { _tag: "Deny", reason: blockedCallReason },
  },
  untrusted: {
    read: { _tag: "Run" },
    change: { _tag: "AskReviewer" },
    approve: { _tag: "AskOwner" },
    blocked: { _tag: "Deny", reason: blockedCallReason },
  },
} as const;

describe("The gate", () => {
  it("decides each Risk Class from the Trust Level of the Turn", () => {
    for (const trustLevel of ["owner", "untrusted"] as const) {
      for (const riskClass of riskClasses) {
        const decision = gateDecisionOf({
          tool: gatedTool(riskClassified(riskClass)),
          input: {},
          trustLevel,
          asksOwnerForApproval: true,
        });
        expect(decision, `${riskClass} in ${trustLevel}`).toEqual(
          expectedDecision[trustLevel][riskClass]
        );
      }
    }
  });

  it("runs a change call of a tool that marks its work untrusted in an untrusted Turn, and asks for any higher class", () => {
    const tool = {
      ...riskClassified("change", {
        isInput: isWideInput,
        of: (input) => (input.wide ? "approve" : "change"),
      }),
      marksItsWorkUntrusted: () => true,
      hasCodeWrittenInput: false,
    };
    const untrustedCall = {
      tool,
      trustLevel: "untrusted",
      asksOwnerForApproval: true,
    } as const;

    expect(
      gateDecisionOf({ ...untrustedCall, input: { wide: false } })
    ).toEqual({ _tag: "RunMarkedUntrusted" });
    expect(gateDecisionOf({ ...untrustedCall, input: { wide: true } })).toEqual(
      {
        _tag: "AskOwner",
      }
    );
  });
});

const sideSessionCall = (
  trustLevel: "owner" | "untrusted",
  hasCodeWrittenInput: boolean
) => ({
  tool: gatedTool(riskClassified("change"), hasCodeWrittenInput),
  input: {},
  trustLevel,
  asksOwnerForApproval: false,
});

describe("The gate in a Turn that cannot ask the Owner for Approval", () => {
  it("runs a change call of an owner Side Session with the input of the model", () => {
    expect(gateDecisionOf(sideSessionCall("owner", true))).toEqual({
      _tag: "Run",
    });
  });

  it("runs a change call of an untrusted Side Session with the input that code writes, when the tool has one", () => {
    expect(gateDecisionOf(sideSessionCall("untrusted", true))).toEqual({
      _tag: "RunCodeWrittenInput",
    });
  });

  it("sends a change call of an untrusted Side Session to the reviewer, when the tool has no code-written input", () => {
    expect(gateDecisionOf(sideSessionCall("untrusted", false))).toEqual({
      _tag: "AskReviewer",
    });
  });
});

describe("The gate after Auto-review", () => {
  it("runs an allowed call, asks the Owner with the reason of the reviewer, and denies a refused call", () => {
    expect(decisionAfterReview({ _tag: "Allow" }, true)).toEqual({
      _tag: "Run",
    });
    expect(
      decisionAfterReview({ _tag: "Ask", reason: "Not clear" }, true)
    ).toEqual({ _tag: "AskOwner", reviewerReason: "Not clear" });
    expect(decisionAfterReview({ _tag: "Ask" }, true)).toEqual({
      _tag: "AskOwner",
    });
    expect(
      decisionAfterReview({ _tag: "Refuse", reason: "Refused" }, true)
    ).toEqual({ _tag: "Deny", reason: "Refused" });
  });

  it("only runs an allowed call in a Turn that cannot ask the Owner, and denies every other answer with the reason of that Turn", () => {
    expect(decisionAfterReview({ _tag: "Allow" }, false)).toEqual({
      _tag: "Run",
    });
    for (const verdict of [
      { _tag: "Ask", reason: "Not clear" },
      { _tag: "Refuse", reason: "Refused" },
    ] as const) {
      expect(decisionAfterReview(verdict, false)).toEqual({
        _tag: "Deny",
        reason: untrustedChangeWithoutOwnerReason,
      });
    }
  });
});

const WordInput = z.object({ word: z.string() });

const isWordInput = (value: unknown): value is z.infer<typeof WordInput> =>
  WordInput.safeParse(value).success;

const readWordTool = (
  riskClassOf?: (input: z.infer<typeof WordInput>) => RiskClass
) =>
  riskClassOf === undefined
    ? agentTool({
        description: "Read a word",
        inputSchema: WordInput,
        riskClass: "read",
        execute: ({ word }) => Effect.succeed({ word }),
      })
    : agentTool({
        description: "Read a word",
        inputSchema: WordInput,
        riskClass: "read",
        riskClassOfInput: { isInput: isWordInput, of: riskClassOf },
        approvalSummary: {
          isInput: isWordInput,
          of: ({ word }) => Effect.succeed(`Read the word "${word}"`),
        },
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
  calledAtMillis: 0,
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
          approvalWaits: false,
          textReplyNeeded: false,
        })
      )
  );

describe("An approved call", () => {
  it("never runs a frozen input whose input function gives blocked", async () => {
    const peek = readWordTool(({ word }) =>
      word === "secret" ? "blocked" : "read"
    );

    const blocked = await Effect.runPromise(
      Effect.flip(peek.executeApproved({ word: "secret" }, "approval-1"))
    );
    const allowed = await Effect.runPromise(
      peek.executeApproved({ word: "plain" }, "approval-2")
    );

    expect(blocked.message).toBe(blockedCallReason);
    expect(allowed).toEqual({ word: "plain" });
  });
});

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
