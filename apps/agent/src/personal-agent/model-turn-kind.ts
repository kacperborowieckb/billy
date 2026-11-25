import type { ModelMessage } from "ai";
import type { Effect, Option } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import type { AgentTools } from "../model-gateway/agent-tool.ts";
import type { TrustLevel } from "../notes/note.ts";
import type { OwnerId } from "../owner-id.ts";
import type { TurnTrace } from "../tracing/turn-trace.ts";
import type { InboxEvent } from "./inbox.ts";
import type { ModelTurnTask } from "./storage-values.ts";
import type { TurnPreparation } from "./turn-preparation.ts";
import type { ModelTraceInput } from "./turn-record.ts";
import type { Restart } from "./turn-restart.ts";
import type { TurnSession } from "./turn-session.ts";

export interface ModelTurnKind<Failure, Requirements> {
  readonly task: ModelTurnTask;
  readonly event: InboxEvent;
  readonly replyTo?: InboxEvent;
  readonly inputs: readonly ModelMessage[];
  readonly instructions?: readonly string[];
  readonly tools: AgentTools;
  readonly trustLevel: TrustLevel;
  readonly asksOwnerForApproval?: boolean;
  readonly traceOf: (model: ModelTraceInput) => TurnTrace;
  readonly restartSection?: string;
  readonly restartBeforeDelivery?: (
    restartsDone: number
  ) => Effect.Effect<Option.Option<Restart>, Failure, Requirements>;
  readonly prepare?: Effect.Effect<TurnPreparation, Failure, Requirements>;
  readonly tracesSendFailure?: boolean;
}

export interface ModelTurn<Failure, Requirements> {
  readonly ownerId: OwnerId;
  readonly behavior: BehaviorConfig;
  readonly session: TurnSession;
  readonly kind: ModelTurnKind<Failure, Requirements>;
}
