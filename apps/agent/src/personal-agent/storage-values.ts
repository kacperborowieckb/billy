export const eventKinds = [
  "OwnerMessage",
  "ScheduleFired",
  "ApprovalAnswered",
] as const;

export const approvalAnswers = ["approve", "reject"] as const;

export const approvalRunResults = [
  "executed",
  "failed",
  "unconfirmed",
] as const;

export const inboxStates = ["pending", "done", "failed"] as const;

export const conversationRowKinds = [
  "input",
  "step",
  "reply",
  "write_back",
  "approval_status",
  "summary",
] as const;

export type ConversationRowKind = (typeof conversationRowKinds)[number];

export const writeBackKinds = [
  "Brief",
  "Follow-up",
  "Scheduled Task",
  "Reminder",
  "Schedule",
] as const;

export type WriteBackKind = (typeof writeBackKinds)[number];

export const trustLevels = ["owner", "untrusted"] as const;

export const noteChanges = ["text", "links", "text_and_links"] as const;

export const openLoopStates = ["open", "closed"] as const;

export const openLoopClosedReasons = ["done", "dropped", "replaced"] as const;

export const profileEntryKinds = ["fact", "style_rule"] as const;

export const ownerPreferenceKeys = [
  "time_zone",
  "quiet_hours",
  "muted_proactive_messages",
  "proactive_message_budget",
] as const;

export const ownerPreferenceSources = ["owner"] as const;

export const turnResults = [
  "model_replied",
  "model_failed",
  "reminder_delivered",
  "reminder_delivery_failed",
  "scheduled_task_replied",
  "scheduled_task_failed",
  "scheduled_task_skipped",
  "proactive_message_sent",
  "proactive_message_failed",
  "proactive_message_held",
  "proactive_message_folded",
  "proactive_message_skipped",
] as const;

export const outcomeKinds = ["reply", "reaction", "silent"] as const;

export type OutcomeKind = (typeof outcomeKinds)[number];

export const scheduleActions = ["send_text", "run_prompt"] as const;

export const scheduleSetBy = ["owner", "agent"] as const;

export const scheduleStates = ["active", "done", "cancelled"] as const;

export const modelTasks = [
  "reply",
  "scheduled_task",
  "proactive",
  "eval_judge",
  "compaction",
  "auto_review",
] as const;

export const turnModelTasks = ["reply", "scheduled_task", "proactive"] as const;

export type TurnModelTask = (typeof turnModelTasks)[number];

export const sessionTasks = [...turnModelTasks, "compaction"] as const;

export type SessionTask = (typeof sessionTasks)[number];

export const historyBreaks = ["compaction", "stub_in_turn_before"] as const;

export type HistoryBreak = (typeof historyBreaks)[number];

export const plannedMisses = [
  "no_earlier_call",
  "cache_lifetime",
  "deploy",
  "owner_context_changed",
  ...historyBreaks,
] as const;

export type PlannedMiss = (typeof plannedMisses)[number];

export const proactiveOutcomes = [
  "acted",
  "replied",
  "muted",
  "ignored",
] as const;

export const proactiveHoldReasons = ["quiet_hours"] as const;

export const proactiveFoldReasons = [
  "muted",
  "message_budget",
  "token_budget",
  "brief_soon",
] as const;

export const proactiveMuteChanges = ["muted", "unmuted"] as const;

export type ProactiveOutcome = (typeof proactiveOutcomes)[number];

export const reviewAnswers = ["allow", "ask", "refuse"] as const;

export const reviewFallbacks = [
  "operator_secret",
  "no_owner_words",
  "over_budget",
  "timed_out",
  "model_failed",
  "invalid_answer",
  "review_failed",
] as const;

export type ReviewFallback = (typeof reviewFallbacks)[number];

export const pendingApprovalStates = [
  "draft",
  "pending",
  "approved",
  "rejected",
  "expired",
  "executed",
  "failed",
  "unconfirmed",
] as const;

export const modelTurnTasks = ["reply", "scheduled_task", "proactive"] as const;

export type ModelTurnTask = (typeof modelTurnTasks)[number];

export const requestPartKinds = [
  "system",
  "tool_definitions",
  "owner_context",
] as const;

export type RequestPartKind = (typeof requestPartKinds)[number];

export const mcpConnectionStates = [
  "authenticating",
  "ready",
  "failed",
  "needs_sign_in",
] as const;

export type McpConnectionState = (typeof mcpConnectionStates)[number];

export const mcpCallStatuses = ["done", "failed", "timed_out"] as const;

export type McpCallStatus = (typeof mcpCallStatuses)[number];
