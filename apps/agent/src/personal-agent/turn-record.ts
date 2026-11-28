import type { ModelMessage } from "ai";

import type { ReviewRecord } from "../auto-review/review-record.ts";
import {
  attemptTimeoutMillis,
  modelAttempts,
} from "../model-gateway/model-call-policy.ts";
import type { ModelReply } from "../model-gateway/model-gateway.ts";
import type { ModelStep } from "../model-gateway/model-step.ts";
import type { ModelUnavailable } from "../model-gateway/model-unavailable.ts";
import type { StepLimitReached } from "../model-gateway/step-limit-reached.ts";
import { sumUsage } from "../model-gateway/usage-ledger.ts";
import type { Usage } from "../model-gateway/usage-ledger.ts";
import type { Redactor } from "../tracing/redactor.ts";
import type { PointedRequest } from "../tracing/traced-request.ts";
import type {
  ProactiveTurnTrace,
  ReplyTurnTrace,
  ScheduledTaskTurnTrace,
} from "../tracing/turn-trace.ts";
import type { InboxEvent, ScheduleFiredEvent } from "./inbox.ts";
import type { OutcomeKind } from "./storage-values.ts";

export type ModelFailure = ModelUnavailable | StepLimitReached;

export const stepLimitReason = (stepLimit: number) =>
  `The model did not give a final answer in ${stepLimit} steps`;

export const modelFailureReason = (
  error: ModelFailure,
  redactor: Redactor["Service"]
) =>
  redactor.redact(
    error._tag === "StepLimitReached"
      ? stepLimitReason(error.stepLimit)
      : `The model failed ${modelAttempts} times: ${String(error.cause)}`
  );

export interface ReactionOutcome {
  readonly emoji: string;
  readonly requestedEmoji?: string;
}

export type ModelOutcome =
  | { readonly _tag: "Replied"; readonly reply: ModelReply }
  | { readonly _tag: "ModelFailed"; readonly error: ModelFailure };

export const stepsOf = (outcome: ModelOutcome): readonly ModelStep[] =>
  outcome._tag === "Replied" ? outcome.reply.steps : outcome.error.steps;

const unknownUsage: Usage = {
  inputTokens: undefined,
  outputTokens: undefined,
  cachedInputTokens: undefined,
  costUsd: undefined,
};

export const usageOfOutcome = (outcome: ModelOutcome): Usage | undefined => {
  if (outcome._tag === "Replied") {
    return outcome.reply.usage;
  }
  return outcome.error.steps.length === 0
    ? undefined
    : sumUsage(outcome.error.steps.map((step) => step.usage));
};

const traceUsageOf = (usage: Usage): ReplyTurnTrace["usage"] => ({
  inputTokens: usage.inputTokens ?? null,
  outputTokens: usage.outputTokens ?? null,
  cachedInputTokens: usage.cachedInputTokens ?? null,
  costUsd: usage.costUsd ?? null,
});

const traceStepsOf = (
  outcome: ModelOutcome,
  redactor: Redactor["Service"]
): ReplyTurnTrace["steps"] =>
  stepsOf(outcome).map((step) => ({
    toolCalls: step.toolCalls.map((call) => ({
      callId: call.callId,
      name: call.name,
      input: redactor.redact(call.input),
      output: redactor.redact(call.output),
      failed: call.failed,
    })),
    usage: traceUsageOf(step.usage),
  }));

export interface ModelTraceInput {
  readonly request: PointedRequest;
  readonly outcome: ModelOutcome;
  readonly modelLatencyMillis: number;
  readonly redactor: Redactor["Service"];
  readonly delivered?: boolean;
  readonly outcomeKind?: OutcomeKind | undefined;
  readonly reaction?: ReactionOutcome | undefined;
  readonly refusedOutcomeTools?: readonly string[];
  readonly rejectedStubReplies?: readonly string[];
  readonly reviews?: readonly ReviewRecord[];
  readonly restart?: ReplyTurnTrace["restart"];
  readonly trustLevelChange?: ReplyTurnTrace["trustLevelChange"];
}

const traceOutcomeOf = (
  outcomeKind: OutcomeKind | undefined,
  reaction: ReactionOutcome | undefined,
  redactor: Redactor["Service"]
): ReplyTurnTrace["outcome"] => {
  if (outcomeKind === undefined) {
    return null;
  }
  if (outcomeKind !== "reaction" || reaction === undefined) {
    return { kind: outcomeKind };
  }
  return {
    kind: outcomeKind,
    emoji: reaction.emoji,
    ...(reaction.requestedEmoji === undefined
      ? {}
      : { requestedEmoji: redactor.redact(reaction.requestedEmoji) }),
  };
};

const modelTraceOf = ({
  request,
  outcome,
  modelLatencyMillis,
  redactor,
  outcomeKind,
  reaction,
  refusedOutcomeTools = [],
  rejectedStubReplies = [],
  reviews = [],
  restart,
  trustLevelChange,
}: ModelTraceInput) => {
  const reasoningEffort =
    outcome._tag === "Replied"
      ? outcome.reply.reasoningEffort
      : outcome.error.reasoningEffort;
  const base = {
    modelSettings: {
      attempts: modelAttempts,
      attemptTimeoutMillis,
      reasoningEffort,
    },
    request,
    steps: traceStepsOf(outcome, redactor),
    modelLatencyMillis,
    outcome: traceOutcomeOf(outcomeKind, reaction, redactor),
    refusedOutcomeTools: [...refusedOutcomeTools],
    ...(rejectedStubReplies.length === 0
      ? {}
      : {
          rejectedStubReplies: rejectedStubReplies.map((text) =>
            redactor.redact(text)
          ),
        }),
    ...(reviews.length === 0 ? {} : { reviews: [...reviews] }),
    ...(restart === undefined ? {} : { restart }),
    ...(trustLevelChange === undefined ? {} : { trustLevelChange }),
  } as const;
  if (outcome._tag === "Replied") {
    return {
      ...base,
      modelId: outcome.reply.modelId,
      reply: redactor.redact(outcome.reply.text),
      error: null,
      usage: traceUsageOf(outcome.reply.usage),
    };
  }
  return {
    ...base,
    modelId: outcome.error.modelId,
    reply: null,
    error: modelFailureReason(outcome.error, redactor),
    usage: traceUsageOf(usageOfOutcome(outcome) ?? unknownUsage),
  };
};

interface TraceInput extends ModelTraceInput {
  readonly event: InboxEvent;
}

export const traceOf = ({ event, ...input }: TraceInput): ReplyTurnTrace => ({
  ...modelTraceOf(input),
  eventId: event.eventId,
  task: "reply",
  result: input.outcome._tag === "Replied" ? "model_replied" : "model_failed",
});

interface ScheduledTaskTraceInput extends ModelTraceInput {
  readonly event: ScheduleFiredEvent;
}

export const scheduledTaskTraceOf = ({
  event,
  ...input
}: ScheduledTaskTraceInput): ScheduledTaskTurnTrace => ({
  ...modelTraceOf(input),
  eventId: event.eventId,
  task: "scheduled_task",
  scheduleId: event.scheduleId,
  dueAt: event.dueAt,
  result:
    input.outcome._tag === "Replied"
      ? "scheduled_task_replied"
      : "scheduled_task_failed",
});

interface ProactiveTraceInput extends ModelTraceInput {
  readonly event: ScheduleFiredEvent;
  readonly dailyTokenBudget: number;
  readonly tokensSpentBefore: number;
}

export const proactiveTraceOf = ({
  event,
  dailyTokenBudget,
  tokensSpentBefore,
  delivered = false,
  ...input
}: ProactiveTraceInput): ProactiveTurnTrace => ({
  ...modelTraceOf(input),
  eventId: event.eventId,
  task: "proactive",
  scheduleId: event.scheduleId,
  dueAt: event.dueAt,
  dailyTokenBudget,
  tokensSpentBefore,
  result:
    input.outcome._tag === "Replied" && delivered
      ? "proactive_message_sent"
      : "proactive_message_failed",
});

export const responseMessagesOf = (outcome: ModelOutcome) =>
  stepsOf(outcome).flatMap((step) => step.responseMessages);

const isToolPart = (part: { readonly type: string }) =>
  part.type === "tool-call" || part.type === "tool-result";

export const toolPartsOf = (message: ModelMessage): readonly ModelMessage[] => {
  if (message.role === "tool") {
    return [message];
  }
  if (message.role !== "assistant" || typeof message.content === "string") {
    return [];
  }
  const content = message.content.filter(isToolPart);
  return content.length === 0 ? [] : [{ ...message, content }];
};

export const stepMessagesOfReply = (outcome: ModelOutcome) => {
  const steps = stepsOf(outcome);
  const last = steps.at(-1);
  return last === undefined
    ? []
    : [
        ...steps.slice(0, -1).flatMap((step) => step.responseMessages),
        ...last.responseMessages.flatMap(toolPartsOf),
      ];
};
