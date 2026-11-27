// A drawn iPhone chat that plays a short script: your message types into the
// composer and rises into the thread, Billy types and his answer grows out of
// his corner, and the thread slides up as each message lands. Every script
// can also be drawn at once, finished, so the page reads whole before (or
// without) any motion.
import { billy } from "../art";
import { lastGroup, pick, plain } from "./markup";
import type { Step } from "./markup";
import { frame, inSequence, wait } from "./timing";
import { isReduced } from "./watch";

export const createChat = (thread: HTMLElement, avatar = true) => {
  const screen = thread.parentElement;
  const field = screen?.querySelector<HTMLElement>("[data-field]");
  const send = screen?.querySelector<HTMLElement>("[data-send]");
  const placeholder = field?.textContent ?? "";
  let run = 0;
  let last: HTMLElement | null = null;

  const row = (who: "you" | "him", html: string) => {
    const element = document.createElement("div");
    element.className = `chat-row chat-row--${who}`;
    if (who === "him" && avatar) {
      element.insertAdjacentHTML(
        "beforeend",
        `<span class="chat-avatar"><img class="px" src="${billy.portrait}" alt="" width="26" height="26"></span>`
      );
    }
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble";
    bubble.innerHTML = html;
    element.append(bubble);
    // A group: one sender's messages in a row share a tail corner, and
    // Billy's avatar stays beside the last one.
    if (last?.classList.contains(`chat-row--${who}`)) {
      last.classList.add("is-grouped");
      bubble.classList.add("is-follow");
    }
    last = element;
    return element;
  };

  const stamp = (text: string) => {
    const element = document.createElement("div");
    element.className = "chat-stamp";
    element.textContent = text;
    last = element;
    return element;
  };

  // The thread slides up as a message lands: each older message starts where
  // it was and eases to its new place (transform only).
  const add = async (element: HTMLElement) => {
    const older = [...thread.children] as HTMLElement[];
    const before = older.map((child) => child.getBoundingClientRect().top);
    element.classList.add("is-entering");
    thread.append(element);
    if (!isReduced()) {
      for (const [index, child] of older.entries()) {
        const shift = (before[index] ?? 0) - child.getBoundingClientRect().top;
        if (shift) {
          child.animate(
            [{ transform: `translateY(${shift}px)` }, { transform: "none" }],
            { duration: 340, easing: "cubic-bezier(0.23, 1, 0.32, 1)" }
          );
        }
      }
    }
    await frame();
    element.classList.remove("is-entering");
  };

  const typeIn = async (text: string, live: () => boolean) => {
    if (!field || isReduced()) {
      return;
    }
    field.classList.add("is-typing");
    const ends = Array.from(
      { length: Math.ceil(text.length / 2) },
      (_, k) => (k + 1) * 2
    );
    await inSequence(ends, (end) => {
      if (live()) {
        field.textContent = text.slice(0, end);
      }
      return wait(Math.min(64, 1700 / text.length));
    });
    await wait(200);
    // A newer run owns the composer now: leave it alone.
    if (!live()) {
      return;
    }
    send?.classList.add("is-pressed");
    await wait(140);
    send?.classList.remove("is-pressed");
    if (live()) {
      field.classList.remove("is-typing");
      field.textContent = placeholder;
    }
  };

  const press = async (selector: string, live: () => boolean) => {
    const chip = lastGroup(thread)?.querySelector<HTMLElement>(selector);
    if (!chip) {
      return;
    }
    chip.classList.add("is-pressed");
    await wait(160);
    chip.classList.remove("is-pressed");
    // A stop during the press leaves the reply unpicked.
    if (!live()) {
      return;
    }
    pick(chip);
    await wait(520);
  };

  const typing = async (ms: number, live: () => boolean) => {
    const previous = thread.lastElementChild as HTMLElement | null;
    const dots = row(
      "him",
      '<span class="chat-dots"><i></i><i></i><i></i></span>'
    );
    await add(dots);
    await wait(ms);
    if (live()) {
      dots.remove();
      previous?.classList.remove("is-grouped");
      last = previous;
    }
  };

  const tickAll = (gap: number, live: () => boolean) =>
    inSequence(thread.querySelectorAll(".chat-task"), (item) => {
      if (!live()) {
        return;
      }
      item.classList.add("is-done");
      return wait(gap);
    });

  const strike = () =>
    [...thread.querySelectorAll(".chat-card")]
      .pop()
      ?.classList.add("is-struck");

  // A step's messages: a timestamp, your message, Billy typing, his answer.
  const say = async (step: Step, live: () => boolean) => {
    if (step.stamp) {
      await add(stamp(step.stamp));
      await wait(250);
    }
    if (step.you) {
      await typeIn(plain(step.you), live);
      if (live()) {
        await add(row("you", step.you));
        await wait(step.after ?? 650);
      }
    }
    if (step.typing && live()) {
      await typing(step.typing, live);
    }
    if (step.him && live()) {
      await add(row("him", step.him));
      await wait(step.after ?? 900);
    }
  };

  // A step's actions: a quick reply, ticking tasks, a strike, a pause.
  const act = async (step: Step, live: () => boolean) => {
    if (step.tap && live()) {
      await press(step.tap, live);
    }
    if (step.tick !== undefined && live()) {
      await tickAll(step.tick, live);
    }
    if (step.strike && live()) {
      strike();
      await wait(400);
    }
    if (step.after && !(step.you || step.him) && live()) {
      await wait(step.after);
    }
  };

  const play = async (step: Step, live: () => boolean) => {
    if (live()) {
      await say(step, live);
      await act(step, live);
    }
  };

  return {
    /** Draw the finished conversation at once. */
    fill(script: readonly Step[]) {
      thread.replaceChildren();
      last = null;
      for (const step of script) {
        if (step.stamp) {
          thread.append(stamp(step.stamp));
        }
        for (const [who, html] of [
          ["you", step.you],
          ["him", step.him],
        ] as const) {
          if (html) {
            const element = row(who, html);
            element.classList.add("is-still");
            thread.append(element);
          }
        }
        if (step.tap) {
          pick(lastGroup(thread)?.querySelector(step.tap) ?? undefined);
        }
        if (step.tick !== undefined) {
          for (const item of thread.querySelectorAll(".chat-task")) {
            item.classList.add("is-done");
          }
        }
        if (step.strike) {
          strike();
        }
      }
    },

    /** Play the conversation; a newer call stops an older one. */
    async play(script: readonly Step[]) {
      run += 1;
      const id = run;
      const live = () => id === run;
      if (field) {
        field.classList.remove("is-typing");
        field.textContent = placeholder;
      }
      if (isReduced()) {
        this.fill(script);
        return;
      }
      if (thread.children.length > 0) {
        thread.classList.add("is-clearing");
        await wait(200);
      }
      if (!live()) {
        return;
      }
      thread.classList.remove("is-clearing");
      thread.replaceChildren();
      last = null;
      await inSequence(script, (step) => play(step, live));
    },

    /** Stop playing: typing dots go, and the thread shows again. */
    stop() {
      run += 1;
      // The thread's animations (slide-ups, and pops and transitions inside
      // each message) stop with it.
      for (const child of thread.children) {
        for (const animation of child.getAnimations({ subtree: true })) {
          animation.cancel();
        }
      }
      for (const dots of thread.querySelectorAll(".chat-dots")) {
        dots.closest(".chat-row")?.remove();
      }
      thread.classList.remove("is-clearing");
      if (field) {
        field.classList.remove("is-typing");
        field.textContent = placeholder;
      }
    },
  };
};
