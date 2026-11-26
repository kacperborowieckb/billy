import { Schema } from "effect";

import { riskClasses } from "../approval/risk-class.ts";
import {
  approvalAnswers,
  mcpCallStatuses,
  approvalRunResults,
  noteChanges,
  openLoopClosedReasons,
  proactiveFoldReasons,
  proactiveHoldReasons,
  proactiveMuteChanges,
  ownerPreferenceKeys,
  proactiveOutcomes,
  profileEntryKinds,
} from "../personal-agent/storage-values.ts";

export const RestartRecordSchema = Schema.Struct({
  coveredEventIds: Schema.Array(Schema.String),
  newEventIds: Schema.Array(Schema.String),
});

export const JournalRecordSchema = Schema.TaggedUnion({
  EventReceived: {
    eventId: Schema.String,
    restart: Schema.optionalKey(RestartRecordSchema),
  },
  AnsweredByTurn: { eventId: Schema.String, turnEventId: Schema.String },
  TurnFailed: { eventId: Schema.String, reason: Schema.String },
  ReplyPlanned: {
    eventId: Schema.String,
    text: Schema.String,
    reaction: Schema.optionalKey(
      Schema.Struct({
        conversationId: Schema.String,
        channelMessageId: Schema.String,
        emoji: Schema.String,
      })
    ),
  },
  SendStarted: { eventId: Schema.String },
  ReplySent: { eventId: Schema.String, channelMessageId: Schema.String },
  ReplyFailed: { eventId: Schema.String, reason: Schema.String },
  StayedSilent: { eventId: Schema.String },
  NoteCaptured: { eventId: Schema.String, noteId: Schema.String },
  NoteUpdated: {
    eventId: Schema.String,
    noteId: Schema.String,
    change: Schema.Literals(noteChanges),
  },
  OpenLoopOpened: {
    eventId: Schema.String,
    noteId: Schema.String,
    kind: Schema.String,
    dueAt: Schema.NullOr(Schema.String),
  },
  OpenLoopChanged: {
    eventId: Schema.String,
    noteId: Schema.String,
    kind: Schema.String,
    dueAt: Schema.NullOr(Schema.String),
  },
  OpenLoopClosed: {
    eventId: Schema.String,
    noteId: Schema.String,
    reason: Schema.Literals(openLoopClosedReasons),
  },
  ProfileEntryAdded: {
    eventId: Schema.String,
    entryId: Schema.String,
    kind: Schema.Literals(profileEntryKinds),
  },
  ProfileEntryRemoved: { eventId: Schema.String, entryId: Schema.String },
  ScheduleSet: { eventId: Schema.String, scheduleId: Schema.String },
  ScheduleChanged: { eventId: Schema.String, scheduleId: Schema.String },
  ScheduleCancelled: { eventId: Schema.String, scheduleId: Schema.String },
  ScheduleFired: {
    eventId: Schema.String,
    scheduleId: Schema.String,
    dueAt: Schema.String,
  },
  ReminderLate: {
    eventId: Schema.String,
    scheduleId: Schema.String,
    dueAt: Schema.String,
    lateByMillis: Schema.Number,
  },
  ScheduledTaskSkipped: {
    eventId: Schema.String,
    scheduleId: Schema.String,
    dueAt: Schema.String,
    dailyTokenBudget: Schema.Number,
    tokensSpent: Schema.Number,
  },
  BriefCreated: { eventId: Schema.String, scheduleId: Schema.String },
  ProactiveMessageHeld: {
    eventId: Schema.String,
    scheduleId: Schema.String,
    fromDueAt: Schema.String,
    toDueAt: Schema.String,
    reason: Schema.Literals(proactiveHoldReasons),
  },
  ProactiveMessageFolded: {
    eventId: Schema.String,
    scheduleId: Schema.String,
    openLoopIds: Schema.Array(Schema.String),
    reason: Schema.Literals(proactiveFoldReasons),
  },
  ProactiveMessageSkipped: {
    eventId: Schema.String,
    scheduleId: Schema.String,
    openLoopIds: Schema.Array(Schema.String),
    reason: Schema.Literals(proactiveFoldReasons),
  },
  ProactiveMessagePlanned: { eventId: Schema.String },
  ProactiveMessageMerged: {
    eventId: Schema.String,
    merged: Schema.Array(
      Schema.Struct({ scheduleId: Schema.String, dueAt: Schema.String })
    ),
  },
  ProactiveMuteChanged: {
    eventId: Schema.String,
    change: Schema.Literals(proactiveMuteChanges),
    openLoopIds: Schema.Array(Schema.String),
    kinds: Schema.Array(Schema.String),
  },
  ProactiveMessageOutcome: {
    eventId: Schema.String,
    outcome: Schema.Literals(proactiveOutcomes),
    connectedEventId: Schema.NullOr(Schema.String),
  },
  ScheduleCompleted: { eventId: Schema.String, scheduleId: Schema.String },
  ScheduleRescheduled: {
    eventId: Schema.String,
    scheduleId: Schema.String,
    nextDueAt: Schema.String,
  },
  ApprovalPending: {
    eventId: Schema.String,
    pendingApprovalId: Schema.String,
    toolName: Schema.String,
  },
  ApprovalAnswered: {
    eventId: Schema.String,
    pendingApprovalId: Schema.String,
    answer: Schema.Literals(approvalAnswers),
  },
  ApprovalExpired: {
    eventId: Schema.String,
    pendingApprovalId: Schema.String,
  },
  ApprovalRun: {
    eventId: Schema.String,
    pendingApprovalId: Schema.String,
    result: Schema.Literals(approvalRunResults),
    reason: Schema.optionalKey(Schema.String),
  },
  McpToolCalled: {
    eventId: Schema.String,
    catalogId: Schema.String,
    tool: Schema.String,
    riskClass: Schema.Literals(riskClasses),
    status: Schema.Literals(mcpCallStatuses),
  },
  OwnerPreferenceChanged: {
    eventId: Schema.String,
    preference: Schema.Literals(ownerPreferenceKeys),
    value: Schema.String,
  },
});

export type JournalRecord = typeof JournalRecordSchema.Type;
