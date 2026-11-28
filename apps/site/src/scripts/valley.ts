// The hero valley: the light moves from dawn to day to dusk while Billy
// works through the day in the phone beside him. It runs only while the hero
// is on screen, the tab is visible and motion is allowed (./watch.ts);
// otherwise it rests on the finished morning.
import { outfits } from "../art";
import { createChat } from "./chat";
import { scenes } from "./stories";
import { repeat } from "./timing";
import { isReduced, whenActive } from "./watch";

type Scene = (typeof scenes)[number];

export const startValley = () => {
  const stage = document.querySelector<HTMLElement>("[data-valley]");
  const thread = stage?.querySelector<HTMLElement>("[data-thread]");
  const sun = stage?.querySelector<HTMLElement>("[data-sun]");
  const say = stage?.querySelector<HTMLElement>("[data-say]");
  const clock = stage?.querySelector<HTMLElement>("[data-clock]");
  const outfit = stage?.querySelector<HTMLImageElement>("[data-outfit]");
  const skies = [...(stage?.querySelectorAll<HTMLElement>("[data-sky]") ?? [])];
  const [first] = scenes;
  if (!(stage && thread && sun && say && clock && outfit && first)) {
    return;
  }
  const chat = createChat(thread);
  let current: Scene = first;
  let loop = 0;
  // The greeting bubble changes a beat after the scene; the scene owns that
  // timer, so a stop or the next scene cancels it.
  let greeting = 0;

  const placeSun = () => {
    const box = stage.getBoundingClientRect();
    const [x, y] = current.sun;
    sun.style.transform = `translate(${x * box.width - 44}px, ${30 + y * (box.height - 260)}px)`;
  };

  const show = (scene: Scene, instant: boolean) => {
    current = scene;
    for (const sky of skies) {
      sky.classList.toggle("is-on", sky.dataset.sky === scene.sky);
    }
    placeSun();
    clock.textContent = scene.time;
    outfit.src = outfits[scene.outfit];
    window.clearTimeout(greeting);
    if (instant) {
      say.textContent = scene.say;
      say.classList.remove("is-out");
      return;
    }
    say.classList.add("is-out");
    greeting = window.setTimeout(() => {
      say.textContent = scene.say;
      say.classList.remove("is-out");
    }, 700);
  };

  // The resting picture: the finished morning.
  const rest = () => {
    loop += 1;
    window.clearTimeout(greeting);
    chat.stop();
    if (isReduced()) {
      show(first, true);
      chat.fill(first.script);
    } else {
      say.classList.remove("is-out");
    }
  };

  show(first, true);
  chat.fill(first.script);
  window.addEventListener("resize", placeSun);

  whenActive(stage, (active) => {
    if (!active) {
      rest();
      return;
    }
    loop += 1;
    const id = loop;
    const start = scenes.indexOf(current);
    repeat(
      () => id === loop,
      (turn) => {
        const scene = scenes[(start + turn) % scenes.length] ?? first;
        show(scene, false);
        return chat.play(scene.script);
      }
    );
  });
};
