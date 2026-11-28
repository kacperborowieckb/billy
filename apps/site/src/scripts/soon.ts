// The app explorer's "Coming soon" features: errands Billy will run, in the
// same chat. Every name, time and price is an example.
import type { Feature } from "./features";
import { card, chips, task, tasks } from "./markup";

export const soon: readonly Feature[] = [
  {
    id: "watch",
    icon: "search",
    title: "Watch for me",
    line: "He keeps an eye on something and tells you when it changes.",
    outfit: "forest",
    soon: true,
    script: [
      { you: "Tell me if a spot opens in the ceramics class Anna wanted" },
      { typing: 900 },
      {
        him: `I'll check the class page every morning.${card("search", "Ceramics class · watching")}`,
      },
      { stamp: "Saturday 08:02" },
      {
        him: `A spot opened for Saturday 10:00. Book it for Anna?${chips("Book it", "Not now")}`,
      },
      { tap: ".chat-chip" },
      { typing: 700 },
      { him: `Booked.${card("calendar", "Ceramics class · Sat 10:00", true)}` },
    ],
  },
  {
    id: "trip",
    icon: "web",
    title: "Trip plans",
    line: "Your Notes, Reminders and bookings, in one plan.",
    outfit: "office",
    soon: true,
    script: [
      { you: "Put Lisbon together for me" },
      { typing: 1100 },
      {
        him: `Here is your trip, from what you told me:${tasks(task("Renew passport", "Mon"), task("Packing list", "4 items"), task("Dinner for four", "Fri 19:30"))}`,
      },
      { tick: 600 },
      { typing: 700 },
      {
        him: `Everything before you fly is done.${card("brief", "Lisbon · ready")}`,
      },
    ],
  },
  {
    id: "renew",
    icon: "email",
    title: "Renewals",
    line: "Spots a price going up before it renews.",
    outfit: "office",
    soon: true,
    script: [
      { stamp: "Monday 09:00" },
      {
        him: `Your phone plan renews on Friday, €4 a month more than now. Want me to ask for the old price?${chips("Ask them", "Leave it")}`,
      },
      { tap: ".chat-chip" },
      { typing: 800 },
      {
        him: `Drafted. Sending waits for your yes.${card("email", "Message to your carrier · Draft")}`,
      },
    ],
  },
  {
    id: "checkin",
    icon: "brief",
    title: "Check-ins",
    line: "A small daily goal, and a nudge that remembers it.",
    outfit: "sports",
    soon: true,
    script: [
      { you: "A 15-minute walk after lunch, every day" },
      { typing: 900 },
      {
        him: `I'll check in at 13:30.${card("reminder", "Walk · daily at 13:30")}`,
      },
      { stamp: "Today 13:30" },
      { him: `Walk time. Did you go?${chips("Done", "Skip today")}` },
      { tap: ".chat-chip" },
      { him: "Four days in a row." },
    ],
  },
];
