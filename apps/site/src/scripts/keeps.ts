// "What Billy keeps": three small windows that loop while the section is on
// screen. Notes: a message is filed. Reminders: a new one lands on top and
// the others step down. Brief: the tasks tick and the bar fills. Under
// reduced motion each rests on its finished picture.
import { icons } from "../art";
import type { IconName } from "../art";
import { createChat } from "./chat";
import { brief } from "./markup";
import { noteLoops } from "./stories";
import { after, inSequence, repeat, wait } from "./timing";

const reminders: readonly {
  icon: IconName;
  title: string;
  line: string;
  time: string;
}[] = [
  {
    icon: "reminder",
    line: "before Lisbon",
    time: "Mon 9:00",
    title: "Renew passport",
  },
  { icon: "calendar", line: "in your Brief", time: "17:30", title: "Dentist" },
  {
    icon: "email",
    line: "in your Brief",
    time: "14:00",
    title: "Invoice to Marta",
  },
  {
    icon: "reminder",
    line: "a week before",
    time: "7 Jun",
    title: "Anna's gift",
  },
  {
    icon: "connector",
    line: "flat contract",
    time: "Thu 9:00",
    title: "Nudge Tom",
  },
];

const reminderRow = (item: (typeof reminders)[number], slot: number) => {
  const row = document.createElement("div");
  row.className = "keep-row";
  row.style.setProperty("--slot", String(slot));
  row.innerHTML = `<img class="px" src="${icons[item.icon]}" alt="" width="32" height="32"><span><b>${item.title}</b><small>${item.line}</small></span><time>${item.time}</time>`;
  return row;
};

const startRows = (rows: HTMLElement) => {
  const list = reminders
    .slice(1, 4)
    .map((item, slot) => reminderRow(item, slot));
  rows.append(...list);
  let next = 4;
  // One turn: the oldest leaves, the rest step down, a new one lands on top.
  return async () => {
    const item = reminders[next % reminders.length];
    next += 1;
    const leaving = list.pop();
    leaving?.classList.add("is-leaving");
    window.setTimeout(() => leaving?.remove(), 320);
    for (const [slot, row] of list.entries()) {
      row.style.setProperty("--slot", String(slot + 1));
      row.classList.remove("is-fresh");
    }
    if (item) {
      const row = reminderRow(item, 0);
      row.classList.add("is-new", "is-fresh");
      rows.append(row);
      list.unshift(row);
      await wait(260);
      row.classList.remove("is-new");
    }
    await wait(2600);
  };
};

export const startKeeps = () => {
  const section = document.querySelector<HTMLElement>("[data-keeps]");
  const notes = section?.querySelector<HTMLElement>("[data-notes]");
  const rows = section?.querySelector<HTMLElement>("[data-rows]");
  const list = section?.querySelector<HTMLElement>("[data-brief]");
  const bar = section?.querySelector<HTMLElement>("[data-bar]");
  const done = section?.querySelector<HTMLElement>("[data-done]");
  if (!(section && notes && rows && list && bar && done)) {
    return;
  }
  const notesChat = createChat(notes, false);
  notesChat.fill(noteLoops[0] ?? []);
  const rowsTurn = startRows(rows);

  const resetBrief = (finished: boolean) => {
    list.innerHTML = brief().replaceAll(
      /^<span class="chat-tasks">|<\/span>$/gu,
      ""
    );
    for (const item of list.children) {
      item.classList.toggle("is-done", finished);
    }
    bar.style.setProperty("--progress", finished ? "1" : "0");
    done.classList.toggle("is-on", finished);
  };
  resetBrief(window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  const briefTurn = async (live: () => boolean) => {
    resetBrief(false);
    await wait(900);
    const items = [...list.children];
    await inSequence(items, (item, count) => {
      if (!live()) {
        return;
      }
      item.classList.add("is-done");
      bar.style.setProperty("--progress", String((count + 1) / items.length));
      return wait(900);
    });
    done.classList.add("is-on");
    await wait(2400);
  };

  let running = false;
  let loop = 0;
  const setRunning = (on: boolean) => {
    if (
      on === running ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    running = on;
    loop += 1;
    if (!on) {
      notesChat.stop();
      return;
    }
    const id = loop;
    const live = () => running && id === loop;
    repeat(live, (turn) =>
      notesChat.play(noteLoops[turn % noteLoops.length] ?? [])
    );
    after(1400, () => repeat(live, rowsTurn));
    after(700, () => repeat(live, () => briefTurn(live)));
  };

  let visible = false;
  new IntersectionObserver(
    ([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      setRunning(visible && !document.hidden);
    },
    { threshold: 0.25 }
  ).observe(section);
  document.addEventListener("visibilitychange", () =>
    setRunning(visible && !document.hidden)
  );
};
