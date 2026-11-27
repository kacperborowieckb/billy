const range = "[ from {timeMin}][ to {timeMax}]";

export const notionCalendarSummaries = {
  "notion-calendar-list-calendars": "list calendars",
  "notion-calendar-list-events": `list calendar events${range}`,
  "notion-calendar-list-coworkers-events": `read events of coworkers${range}`,
  "notion-calendar-list-calendar-resources": `find rooms and calendar resources${range}`,
  "notion-calendar-list-contacts": "find contacts[ matching {query}]",
  "notion-calendar-create-events":
    "create calendar event {events.summary|events.title}[ at {events.start|events.start.dateTime}][ with {events.attendees.email|events.attendees}]",
  "notion-calendar-update-events":
    "change calendar event {updates.event.eventId|updates.event}[: {updates.updateType}][ with {updates.attendees.email|updates.attendees}]",
  "notion-calendar-cancel-events":
    "cancel calendar event {events.eventId|events}",
} as const;
