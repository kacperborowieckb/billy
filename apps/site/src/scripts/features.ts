// The app explorer's features (src/components/explorer.astro). Every name,
// time and price is an example of the kind of thing Billy does.
import type { IconName, Outfit } from "../art";
import { brief, card, chips } from "./markup";
import type { Step } from "./markup";

export interface Feature {
  id: string;
  icon: IconName;
  title: string;
  line: string;
  outfit: Outfit;
  soon?: boolean;
  script: readonly Step[];
}

/** The app explorer: what Billy does today, then what is coming. */
export const today: readonly Feature[] = [
  {
    id: "notes",
    icon: "note",
    title: "Notes",
    line: "Say it once. Billy files it.",
    outfit: "forest",
    script: [
      {
        you: "Packing list for Lisbon: charger, passport, sandals and the blue jacket",
      },
      { typing: 900 },
      { him: `Saved as a Note.${card("note", "Packing list · Lisbon")}` },
    ],
  },
  {
    id: "recall",
    icon: "search",
    title: "Recall",
    line: "Ask, and he finds it, naming the Note.",
    outfit: "forest",
    script: [
      { you: "What did Anna want for her birthday?" },
      { typing: 900 },
      {
        him: `The green notebook and a ceramics class. You told me in May.${card("note", "Anna · Gift ideas")}${chips("Remind me a week before")}`,
      },
      { tap: ".chat-chip" },
      { typing: 700 },
      {
        him: `Done. I'll remind you on 7 June.${card("reminder", "Anna's gift · 7 Jun")}`,
      },
    ],
  },
  {
    id: "reminders",
    icon: "reminder",
    title: "Reminders",
    line: "A nudge at the right time, in plain words.",
    outfit: "sports",
    script: [
      { you: "Remind me to renew my passport before Lisbon" },
      { typing: 1000 },
      {
        him: `It runs out five weeks before you fly. I'll remind you Monday at 9:00.${card("reminder", "Renew passport · Mon 9:00", true)}${chips("Make it Sunday", "Undo")}`,
      },
      { tap: ".chat-chip" },
      { typing: 700 },
      {
        him: `Moved to Sunday at 10:00.${card("reminder", "Renew passport · Sun 10:00")}`,
      },
    ],
  },
  {
    id: "brief",
    icon: "brief",
    title: "Morning Brief",
    line: "Your day in one message, at 8:00.",
    outfit: "sports",
    script: [
      { stamp: "Today 08:00" },
      { him: `Good morning. Three things today:${brief()}` },
      { tick: 700 },
      { typing: 700 },
      { him: "That's all three. Enjoy your evening." },
    ],
  },
  {
    id: "follow",
    icon: "email",
    title: "Follow-ups",
    line: "He notices what is still open and asks.",
    outfit: "office",
    script: [
      { stamp: "Wednesday 10:15" },
      {
        him: `Tom still hasn't sent the flat contract. Should I nudge him?${chips("Nudge Tom", "Wait a day")}`,
      },
      { tap: ".chat-chip" },
      { typing: 800 },
      {
        him: `Done. I'll message Tom at 9:00 tomorrow.${card("reminder", "Nudge Tom · Thu 9:00")}`,
      },
    ],
  },
  {
    id: "actions",
    icon: "web",
    title: "Actions, with your yes",
    line: "He searches, drafts and books, and asks first.",
    outfit: "office",
    script: [
      { you: "Book dinner for four on Friday" },
      { typing: 900 },
      { him: card("search", "Searched the web · 3 options"), after: 500 },
      {
        him: `Dinner for four, Fri 19:30. Book it?${chips("Book it", "Not now")}`,
      },
      { tap: ".chat-chip" },
      { typing: 700 },
      {
        him: `Booked.${card("calendar", "Dinner for four · Fri 19:30", true)}`,
      },
    ],
  },
  {
    id: "tools",
    icon: "calendar",
    title: "Your tools",
    line: "Calendar, email and the web, in one chat.",
    outfit: "office",
    script: [
      { you: "What does Friday look like?" },
      { typing: 1000 },
      {
        him: `Dinner for four at 19:30. Marta replied about the invoice. Want me to draft an answer?${chips("Draft it", "Later")}`,
      },
      { tap: ".chat-chip" },
      { typing: 800 },
      {
        him: `Drafted. Sending waits for your yes.${card("email", "Reply to Marta · Draft")}`,
      },
    ],
  },
  {
    id: "forget",
    icon: "connector",
    title: "Forget",
    line: "Deleted for good, not hidden.",
    outfit: "forest",
    script: [
      { you: "Forget the packing list" },
      { typing: 900 },
      { him: `Deleted.${card("note", "Packing list · Lisbon")}`, after: 700 },
      { strike: true },
      { him: "It is gone, not hidden. Ask me what I keep any time." },
    ],
  },
];
