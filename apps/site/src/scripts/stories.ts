// The conversations the page plays. Every name, time and price is an example
// of the kind of thing Billy does; the facts about Billy (Telegram, $5 a
// month, Forget) are on the page itself.
import type { Outfit } from "../art";
import { brief, card, chips } from "./markup";
import type { Step } from "./markup";

/** The hero's three times of day. */
export const scenes: readonly {
  sky: "dawn" | "day" | "dusk";
  time: string;
  /** Where the sun stands, as shares of the stage's width and height. */
  sun: readonly [number, number];
  outfit: Outfit;
  say: string;
  script: readonly Step[];
}[] = [
  {
    sky: "dawn",
    time: "08:00",
    sun: [0.12, 0.62],
    outfit: "sports",
    say: "Morning!",
    script: [
      { stamp: "Today 08:00" },
      { him: `Good morning. Three things today:${brief()}`, after: 700 },
      { tick: 520, after: 1600 },
    ],
  },
  {
    sky: "day",
    time: "12:40",
    sun: [0.5, 0.04],
    outfit: "forest",
    say: "Filed it.",
    script: [
      { you: "What did Anna want for her birthday?" },
      { typing: 900 },
      {
        him: `The green notebook and a ceramics class. You told me in May.${card("note", "Anna · Gift ideas")}${chips("Remind me a week before")}`,
      },
      { tap: ".chat-chip" },
      {
        him: `Done. I'll remind you on 7 June.${card("reminder", "Anna's gift · 7 Jun")}`,
        after: 1800,
      },
    ],
  },
  {
    sky: "dusk",
    time: "18:20",
    sun: [0.84, 0.5],
    outfit: "office",
    say: "Booked.",
    script: [
      { you: "Book dinner for four on Friday" },
      { typing: 900 },
      {
        him: `Dinner for four, Fri 19:30. Book it?${chips("Book it", "Not now")}`,
        after: 800,
      },
      { tap: ".chat-chip" },
      {
        him: `Booked.${card("calendar", "Dinner for four · Fri 19:30", true)}`,
        after: 2000,
      },
    ],
  },
];

/** The Notes card in "What Billy keeps": two short exchanges, in turn. */
export const noteLoops: readonly (readonly Step[])[] = [
  [
    { you: "Packing list for Lisbon: charger, passport, sandals", after: 500 },
    { typing: 700 },
    {
      him: `Saved as a Note.${card("note", "Packing list · Lisbon")}`,
      after: 2200,
    },
  ],
  [
    { you: "What did I need for Lisbon?", after: 500 },
    { typing: 700 },
    {
      him: `Charger, passport and sandals.${card("note", "From your Packing list")}`,
      after: 2200,
    },
  ],
];
