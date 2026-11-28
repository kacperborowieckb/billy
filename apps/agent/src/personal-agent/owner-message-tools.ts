import { Effect } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import type { Journal } from "../journal/journal.ts";
import { callMcpToolTool } from "../mcp/call-mcp-tool-tool.ts";
import { connectMcpServerTool } from "../mcp/connect-mcp-server-tool.ts";
import { disconnectMcpConnectionTool } from "../mcp/disconnect-mcp-connection-tool.ts";
import { findMcpToolsTool } from "../mcp/find-mcp-tools-tool.ts";
import {
  callMcpToolToolName,
  connectMcpServerToolName,
  disconnectMcpConnectionToolName,
  findMcpToolsToolName,
} from "../mcp/mcp-tool-names.ts";
import type { McpToolServices } from "../mcp/mcp-tool-services.ts";
import type { NoteToolServices } from "../notes/note-tool-services.ts";
import { noteToolsFor } from "../notes/note-tools.ts";
import { OwnerPreferences } from "../preferences/owner-preferences.ts";
import {
  proactiveMessageBudgetTool,
  proactiveMessageBudgetToolName,
} from "../preferences/proactive-message-budget-tool.ts";
import {
  quietHoursTool,
  quietHoursToolName,
} from "../preferences/quiet-hours-tool.ts";
import {
  setTimeZoneTool,
  setTimeZoneToolName,
} from "../preferences/set-time-zone-tool.ts";
import {
  muteProactiveMessageTool,
  muteProactiveMessageToolName,
} from "../proactive/mute-proactive-message-tool.ts";
import { mutedAmong } from "../proactive/muted-open-loops.ts";
import type { ProactiveMessages } from "../proactive/proactive-messages.ts";
import type { Profile } from "../profile/profile.ts";
import {
  updateProfileTool,
  updateProfileToolName,
} from "../profile/update-profile-tool.ts";
import {
  cancelScheduleTool,
  cancelScheduleToolName,
} from "../schedule/cancel-schedule-tool.ts";
import {
  changeScheduleTool,
  changeScheduleToolName,
} from "../schedule/change-schedule-tool.ts";
import {
  listSchedulesTool,
  listSchedulesToolName,
} from "../schedule/list-schedules-tool.ts";
import type { ScheduleToolServices } from "../schedule/schedule-tool-services.ts";
import type { Schedules } from "../schedule/schedules.ts";
import {
  setScheduleTool,
  setScheduleToolName,
} from "../schedule/set-schedule-tool.ts";
import { ownerTimeZone } from "../time/owner-current-time.ts";
import { turnEventOf } from "./burst.ts";
import type { Burst } from "./burst.ts";
import { reactTool, reactToolName } from "./react-tool.ts";
import { staySilentTool, staySilentToolName } from "./stay-silent-tool.ts";

export interface OwnerMessageToolServices extends Omit<
  NoteToolServices,
  "ownerTimeZone"
> {
  readonly journal: Journal["Service"];
  readonly profile: Profile["Service"];
  readonly preferences: OwnerPreferences["Service"];
  readonly proactiveMessages: ProactiveMessages["Service"];
  readonly schedules: Schedules["Service"];
  readonly behavior: BehaviorConfig;
  readonly mcp: Omit<
    McpToolServices,
    "behavior" | "journal" | "progress" | "redactor"
  >;
}

export const scheduleToolServicesOf = (
  {
    schedules,
    preferences,
    notes,
    behavior,
    progress,
    redactor,
  }: Pick<
    OwnerMessageToolServices,
    "behavior" | "notes" | "preferences" | "progress" | "redactor" | "schedules"
  >,
  turnOrigin: ScheduleToolServices["turnOrigin"]
): ScheduleToolServices => ({
  schedules,
  notes,
  ownerTimeZone: ownerTimeZone(behavior).pipe(
    Effect.provideService(OwnerPreferences, preferences),
    Effect.orDie
  ),
  mutedAmong: (noteIds) => mutedAmong({ preferences, notes }, noteIds),
  progress,
  redactor,
  maxActiveScheduledTasks: behavior.maxActiveScheduledTasks,
  maxActiveAgentSchedules: behavior.maxActiveAgentSchedules,
  turnOrigin,
});

export const ownerMessageTools = (
  burst: Burst,
  {
    journal,
    profile,
    preferences,
    proactiveMessages,
    schedules,
    behavior,
    mcp,
    ...noteServices
  }: OwnerMessageToolServices,
  eventId = turnEventOf(burst).eventId
) => {
  const { progress, redactor } = noteServices;
  const scheduleServices = scheduleToolServicesOf(
    {
      schedules,
      preferences,
      notes: noteServices.notes,
      behavior,
      progress,
      redactor,
    },
    "owner-message"
  );
  const mcpServices: McpToolServices = {
    ...mcp,
    journal,
    progress,
    redactor,
    behavior,
  };
  return {
    ...noteToolsFor(
      { ...noteServices, ownerTimeZone: scheduleServices.ownerTimeZone },
      burst,
      eventId
    ),
    [updateProfileToolName]: updateProfileTool(
      {
        profile,
        progress,
        redactor,
        characterLimit: behavior.maxProfileCharacters,
      },
      eventId
    ),
    [setTimeZoneToolName]: setTimeZoneTool(
      {
        preferences,
        schedules,
        journal,
        progress,
        redactor,
        defaultQuietHours: behavior.quietHours,
      },
      eventId
    ),
    [quietHoursToolName]: quietHoursTool(
      {
        preferences,
        schedules,
        journal,
        progress,
        redactor,
        defaultQuietHours: behavior.quietHours,
      },
      eventId
    ),
    [proactiveMessageBudgetToolName]: proactiveMessageBudgetTool(
      {
        preferences,
        progress,
        redactor,
        defaultSends: behavior.proactiveMessageBudget,
      },
      eventId
    ),
    [muteProactiveMessageToolName]: muteProactiveMessageTool(
      {
        preferences,
        notes: noteServices.notes,
        proactiveMessages,
        progress,
        redactor,
      },
      eventId,
      burst.map((event) => event.eventId)
    ),
    [setScheduleToolName]: setScheduleTool(scheduleServices, eventId),
    [listSchedulesToolName]: listSchedulesTool(scheduleServices, eventId),
    [changeScheduleToolName]: changeScheduleTool(scheduleServices, eventId),
    [cancelScheduleToolName]: cancelScheduleTool(scheduleServices, eventId),
    [findMcpToolsToolName]: findMcpToolsTool(mcpServices, eventId),
    [callMcpToolToolName]: callMcpToolTool(mcpServices, eventId),
    [connectMcpServerToolName]: connectMcpServerTool(mcpServices, eventId),
    [disconnectMcpConnectionToolName]: disconnectMcpConnectionTool(
      mcpServices,
      eventId
    ),
    [staySilentToolName]: staySilentTool,
    [reactToolName]: reactTool,
  };
};
