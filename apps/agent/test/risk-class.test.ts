import { env, runInDurableObject } from "cloudflare:test";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { riskClasses, riskClassified } from "../src/approval/risk-class.ts";
import type { RiskClass } from "../src/approval/risk-class.ts";
import {
  blockedCallReason,
  gateDecisionOf,
} from "../src/approval/tool-gate.ts";
import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";
import type { AgentTools } from "../src/model-gateway/agent-tool.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { agentToolServices } from "../src/personal-agent/agent-tool-services.ts";
import type { Burst } from "../src/personal-agent/burst.ts";
import { ownerMessageTools } from "../src/personal-agent/owner-message-tools.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { proactiveTools } from "../src/personal-agent/proactive-tools.ts";
import { scheduledTaskTools } from "../src/personal-agent/scheduled-task-tools.ts";
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
