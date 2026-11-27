// The pieces of a chat message, as HTML: confirmation cards, task lists and
// quick replies (styled in src/styles/chat.css). Shared by the stories and
// the cards that build them; safe to import where there is no window (the
// DOM helpers at the end touch the document only when called).
import { icons } from "../art";
import type { IconName } from "../art";

export interface Step {
  /** A centred timestamp. */
  stamp?: string;
  /** Your message (HTML). It types into the composer first. */
  you?: string;
  /** Billy types for this many milliseconds. */
  typing?: number;
  /** Billy's message (HTML). */
  him?: string;
  /** Press the last quick reply matching this selector. */
  tap?: string;
  /** Tick every task in the thread, this many milliseconds apart. */
  tick?: number;
  /** Strike through the last card. */
  strike?: boolean;
  /** Pause after the step. */
  after?: number;
}

const tickSvg =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>';

export const card = (icon: IconName, text: string, undo = false) =>
  `<span class="chat-card"><img class="px" src="${icons[icon]}" alt="" width="32" height="32"><span>${text}</span>${undo ? '<span class="chat-undo">Undo</span>' : ""}</span>`;

export const task = (title: string, time: string) =>
  `<span class="chat-task"><span class="chat-tick">${tickSvg}</span><span class="chat-task-title">${title}</span><span class="chat-time">${time}</span></span>`;

export const tasks = (...items: string[]) =>
  `<span class="chat-tasks">${items.join("")}</span>`;

export const chips = (...labels: string[]) =>
  `<span class="chat-chips">${labels.map((label) => `<span class="chat-chip">${tickSvg}${label}</span>`).join("")}</span>`;

export const brief = () =>
  tasks(
    task("Invoice to Marta", "14:00"),
    task("Dentist", "17:30"),
    task("Call mum", "18:00")
  );

// DOM helpers for the chat player (src/scripts/chat.ts).

export const plain = (html: string) => {
  const box = document.createElement("div");
  box.innerHTML = html;
  return box.textContent ?? "";
};

export const pick = (chip: Element | undefined) => {
  chip?.classList.add("is-picked");
  for (const other of chip?.parentElement?.children ?? []) {
    if (other !== chip) {
      other.classList.add("is-dim");
    }
  }
};

// The quick replies in the newest message that has any.
export const lastGroup = (thread: HTMLElement) =>
  [...thread.querySelectorAll(".chat-chips")].pop();
