import { TraceRetentionDaysSchema } from "../tracing/trace-retention-days.ts";
import type { TraceRetentionDays } from "../tracing/trace-retention-days.ts";

export interface BehaviorConfig {
  readonly textingStyle: string;
  readonly maxToolSteps: number;
  readonly maxProfileCharacters: number;
  readonly maxStoredToolResultCharacters: number;
  readonly sideSessionRecentChatMessages: number;
  readonly reminderGraceMillis: number;
  readonly scheduledTaskDailyTokenBudget: number;
  readonly maxActiveScheduledTasks: number;
  readonly maxActiveAgentSchedules: number;
  readonly proactiveDailyTokenBudget: number;
  readonly proactiveResponseWindowMillis: number;
  readonly proactiveMessageBudget: number;
  readonly proactiveMergeWindowMillis: number;
  readonly typingRepeatMillis: number;
  readonly defaultReaction: string;
  readonly burstQuietMillis: number;
  readonly burstMaxWaitMillis: number;
  readonly burstMaxRestarts: number;
  readonly pendingApprovalExpiryMillis: number;
  readonly compactionHistoryTokenLimit: number;
  readonly compactionKeptTokens: number;
  readonly maxSummaryTokens: number;
  readonly traceRetentionDays: TraceRetentionDays;
  readonly quietHours: { readonly start: string; readonly end: string };
  readonly defaultTimeZone?: string | undefined;
}

export const defaultBehaviorConfig: BehaviorConfig = {
  textingStyle:
    "Write like a person who texts: short messages in plain text. Do not use markdown, headings, or lists.",
  maxToolSteps: 8,
  maxProfileCharacters: 2000,
  maxStoredToolResultCharacters: 4000,
  sideSessionRecentChatMessages: 6,
  reminderGraceMillis: 5 * 60 * 1000,
  scheduledTaskDailyTokenBudget: 200_000,
  maxActiveScheduledTasks: 10,
  maxActiveAgentSchedules: 20,
  proactiveDailyTokenBudget: 200_000,
  proactiveResponseWindowMillis: 24 * 60 * 60 * 1000,
  proactiveMessageBudget: 3,
  proactiveMergeWindowMillis: 30 * 60 * 1000,
  typingRepeatMillis: 4000,
  defaultReaction: "👍",
  burstQuietMillis: 2500,
  burstMaxWaitMillis: 10_000,
  burstMaxRestarts: 2,
  pendingApprovalExpiryMillis: 24 * 60 * 60 * 1000,
  compactionHistoryTokenLimit: 30_000,
  compactionKeptTokens: 8000,
  maxSummaryTokens: 1500,
  traceRetentionDays: TraceRetentionDaysSchema.make(30),
  quietHours: { start: "22:00", end: "08:00" },
};
