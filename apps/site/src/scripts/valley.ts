// The hero valley: the light moves from dawn to day to dusk while Billy
// works through the day in the phone beside him. It runs only while the hero
// is on screen and the tab is visible; under reduced motion it rests on the
// finished morning.
import { outfits } from "../art";
import { createChat } from "./chat";
import { scenes } from "./stories";
import { repeat } from "./timing";

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
  let running = false;
  let loop = 0;

  const placeSun = () => {
    const box = stage.getBoundingClientRect();
    const [x, y] = current.sun;
    sun.style.transform = `translate(${x * box.width - 44}px, ${30 + y * (box.height - 260)}px)`;
  };

  const show = (scene: Scene) => {
    current = scene;
    for (const sky of skies) {
      sky.classList.toggle("is-on", sky.dataset.sky === scene.sky);
    }
    placeSun();
    clock.textContent = scene.time;
    outfit.src = outfits[scene.outfit];
    say.classList.add("is-out");
    window.setTimeout(() => {
      say.textContent = scene.say;
      say.classList.remove("is-out");
    }, 700);
  };

  show(first);
  chat.fill(first.script);
  window.addEventListener("resize", placeSun);
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }

  const setRunning = (on: boolean) => {
    if (on === running) {
      return;
    }
    running = on;
    loop += 1;
    if (!on) {
      chat.stop();
      return;
    }
    const id = loop;
    const start = scenes.indexOf(current);
    repeat(
      () => running && id === loop,
      (turn) => {
        const scene = scenes[(start + turn) % scenes.length] ?? first;
        show(scene);
        return chat.play(scene.script);
      }
    );
  };

  let visible = false;
  new IntersectionObserver(
    ([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      setRunning(visible && !document.hidden);
    },
    { threshold: 0.25 }
  ).observe(stage);
  document.addEventListener("visibilitychange", () =>
    setRunning(visible && !document.hidden)
  );
};
