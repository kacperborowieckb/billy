import { Agent, getAgentByName } from "agents";
import type { Layer } from "effect";
import { DateTime, Effect, ManagedRuntime, Option } from "effect";

import { defaultBehaviorConfig } from "../behavior/behavior-config.ts";
import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import type { Channel } from "../channels/channel.ts";
import type { Event } from "../event.ts";
import type { McpCatalog } from "../mcp/mcp-catalog.ts";
import type { McpHubPort } from "../mcp/mcp-hub-contract.ts";
import { mcpCatalogFor } from "../mcp/mcp-test-catalog.ts";
import type { McpToolCopy } from "../mcp/mcp-tool-copy.ts";
import {
  receiveMcpConnectionState,
  receiveMcpToolCatalog,
} from "../mcp/receive-mcp-copy.ts";
import { noTools } from "../model-gateway/agent-tool.ts";
import type { AgentTools } from "../model-gateway/agent-tool.ts";
import type { ModelGateway } from "../model-gateway/model-gateway.ts";
import type { UsageLedger } from "../model-gateway/usage-ledger.ts";
import { OwnerIdSchema } from "../owner-id.ts";
import type { OwnerId } from "../owner-id.ts";
import { Schedules } from "../schedule/schedules.ts";
import type { AlarmClock } from "../schedule/schedules.ts";
import type { OperatorMetrics } from "../tracing/operator-metrics.ts";
import type { Redactor } from "../tracing/redactor.ts";
import {
  retentionRetryAfterFailure,
  runTraceRetentionWhenDue,
} from "../tracing/trace-retention.ts";
import { showTypingOnce } from "./acknowledge.ts";
import { showApprovalDetails } from "./approval-details.ts";
import type { ApprovalDetailsPress } from "./approval-details.ts";
import { burstWaitOf } from "./burst-wait.ts";
import { fireDueSchedulesThen } from "./due-schedule-events.ts";
import { expireDueApprovals } from "./expire-due-approvals.ts";
import { Inbox } from "./inbox.ts";
import { recordOutcomesDueAtAlarm } from "./outcome-records.ts";
import { personalAgentLayer } from "./personal-agent-layer.ts";
import { receiveEvent } from "./receive-event.ts";
import type { McpConnectionState } from "./storage-values.ts";
import { liveTurnServices } from "./turn-services.ts";
import { takeTurn } from "./turn.ts";

export type TurnServices = Layer.Layer<
  Channel | McpHubPort | ModelGateway | OperatorMetrics | Redactor,
  unknown,
  UsageLedger
>;

export type StoreConfirmation = "stored";

export class PersonalAgent extends Agent<Env> {
  readonly ownerId = OwnerIdSchema.make(this.name);

  protected readonly turnServices: (
    env: Env,
    ownerId: OwnerId
  ) => TurnServices = liveTurnServices;

  protected readonly turnTools: AgentTools = noTools;

  protected readonly behavior: BehaviorConfig = defaultBehaviorConfig;

  protected readonly mcpCatalog: McpCatalog = mcpCatalogFor(this.env);

  private traceRetentionRetryNotBefore: Option.Option<DateTime.Utc> =
    Option.none();

  protected readonly alarmClock: AlarmClock = {
    setAt: (dueAt) => this.setAlarmAt(dueAt),
  };

  readonly runtime = ManagedRuntime.make(
    personalAgentLayer(this.ctx.storage, this.ownerId, {
      clock: this.alarmClock,
      burstWait: () => burstWaitOf(this.behavior),
      traceRetention: () => ({
        days: this.behavior.traceRetentionDays,
        retryNotBefore: this.traceRetentionRetryNotBefore,
      }),
      storedFormLimits: () => this.behavior,
      mcpCatalog: this.mcpCatalog,
    })
  );

  async receive(event: Event): Promise<StoreConfirmation> {
    await this.runtime.runPromise(receiveEvent(event));
    if (event._tag === "OwnerMessage") {
      await this.runtime.runPromise(
        Schedules.pipe(Effect.flatMap((schedules) => schedules.rearm))
      );
    }
    const { burstIsDue } = await this.queueTurnWhenDue();
    if (event._tag === "OwnerMessage" && !burstIsDue) {
      this.ctx.waitUntil(
        this.runtime.runPromise(
          showTypingOnce(
            event.conversationId,
            this.behavior.typingRepeatMillis
          ).pipe(Effect.provide(this.turnServices(this.env, this.ownerId)))
        )
      );
    }
    return "stored";
  }

  async showApprovalDetails(press: ApprovalDetailsPress): Promise<void> {
    await this.runtime.runPromise(
      showApprovalDetails(press).pipe(
        Effect.provide(this.turnServices(this.env, this.ownerId))
      )
    );
  }

  async receiveMcpToolCatalog(
    catalogId: string,
    tools: readonly McpToolCopy[]
  ): Promise<void> {
    await this.runtime.runPromise(
      receiveMcpToolCatalog(this.mcpCatalog, catalogId, tools)
    );
  }

  async receiveMcpConnectionState(
    catalogId: string,
    state: McpConnectionState
  ): Promise<void> {
    await this.runtime.runPromise(
      receiveMcpConnectionState(this.mcpCatalog, catalogId, state)
    );
  }

  async fireDueSchedules(): Promise<void> {
    await this.runtime.runPromise(
      runTraceRetentionWhenDue({
        days: this.behavior.traceRetentionDays,
        retryNotBefore: this.traceRetentionRetryNotBefore,
      }).pipe(
        Effect.map((run) =>
          run === "Ran" ? Option.none() : this.traceRetentionRetryNotBefore
        ),
        Effect.catchCause((cause) =>
          Effect.logError("The Trace retention step failed", cause).pipe(
            Effect.andThen(retentionRetryAfterFailure),
            Effect.map(Option.some)
          )
        ),
        Effect.flatMap((retryNotBefore) =>
          Effect.sync(() => {
            this.traceRetentionRetryNotBefore = retryNotBefore;
          })
        )
      )
    );
    await this.runtime.runPromise(
      expireDueApprovals.pipe(
        Effect.provide(this.turnServices(this.env, this.ownerId)),
        Effect.catchCause((cause) =>
          Effect.logError("The due Pending Approvals did not expire", cause)
        )
      )
    );
    await this.runtime.runPromise(
      recordOutcomesDueAtAlarm(
        this.ownerId,
        this.turnServices(this.env, this.ownerId)
      )
    );
    await this.runtime.runPromise(
      fireDueSchedulesThen(
        Effect.promise(() => this.queueTurnWhenDue()).pipe(Effect.asVoid)
      )
    );
  }

  private async setAlarmAt(dueAt: Option.Option<DateTime.Utc>): Promise<void> {
    const sdkSchedules = await this.listSchedules();
    const armed = sdkSchedules.filter(
      (schedule) => schedule.callback === "fireDueSchedules"
    );
    const dueSeconds = dueAt.pipe(
      Option.map((instant) => Math.ceil(DateTime.toEpochMillis(instant) / 1000))
    );
    const [only] = armed;
    if (
      armed.length === 1 &&
      only !== undefined &&
      Option.contains(dueSeconds, only.time)
    ) {
      return;
    }
    await Promise.all(
      armed.map((schedule) => this.cancelSchedule(schedule.id))
    );
    if (Option.isSome(dueSeconds)) {
      await this.schedule(
        new Date(dueSeconds.value * 1000),
        "fireDueSchedules",
        undefined,
        { retry: { maxAttempts: 3 } }
      );
    }
  }

  private async queueTurnWhenDue(): Promise<{ readonly burstIsDue: boolean }> {
    const { burstIsDue, otherEventIsPending } = await this.runtime.runPromise(
      Inbox.pipe(
        Effect.flatMap((inbox) =>
          Effect.all({
            burstIsDue: inbox.burstIsDue(burstWaitOf(this.behavior)),
            otherEventIsPending: inbox.pending.pipe(
              Effect.map((events) =>
                events.some((event) => event._tag !== "OwnerMessage")
              )
            ),
          })
        )
      )
    );
    if (burstIsDue || otherEventIsPending) {
      await this.queueTurn();
    }
    return { burstIsDue };
  }

  private async queueTurn(): Promise<void> {
    await this.schedule(0, "runTurn", undefined, {
      retry: { maxAttempts: 1 },
    });
  }

  async runTurn(): Promise<void> {
    const { nextBurstIsDue } = await this.runtime.runPromise(
      takeTurn(this.ownerId, this.behavior, { tools: this.turnTools }).pipe(
        Effect.provide(this.turnServices(this.env, this.ownerId))
      )
    );
    if (nextBurstIsDue) {
      await this.queueTurn();
    }
  }
}

export const personalAgentFor = <Kind extends PersonalAgent>(
  namespace: DurableObjectNamespace<Kind>,
  ownerId: OwnerId
) => getAgentByName<Env, Kind>(namespace, ownerId);
