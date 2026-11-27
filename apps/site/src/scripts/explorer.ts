// "See it in the app": the list on the left is a vertical tablist; picking a
// feature plays it in the phone on the right. The first one plays when the
// section comes into view; before that, and under reduced motion, the phone
// shows it finished.
import { outfits } from "../art";
import { createChat } from "./chat";
import { today } from "./features";
import { soon } from "./soon";
import { isReduced, whenActive } from "./watch";

const features = [...today, ...soon];

export const startExplorer = () => {
  const section = document.querySelector<HTMLElement>("[data-explorer]");
  const list = section?.querySelector<HTMLElement>("[data-features]");
  const marker = section?.querySelector<HTMLElement>("[data-marker]");
  const thread = section?.querySelector<HTMLElement>("[data-thread]");
  const panel = section?.querySelector<HTMLElement>("[data-panel]");
  const caption = section?.querySelector<HTMLElement>("[data-caption]");
  const outfit = section?.querySelector<HTMLImageElement>("[data-outfit]");
  const replay = section?.querySelector<HTMLButtonElement>("[data-replay]");
  const tabs = [
    ...(list?.querySelectorAll<HTMLButtonElement>("[role=tab]") ?? []),
  ];
  if (
    !(
      section &&
      list &&
      marker &&
      thread &&
      panel &&
      caption &&
      outfit &&
      replay
    )
  ) {
    return;
  }
  const chat = createChat(thread);
  let current = 0;
  let active = false;

  const place = () => {
    const tab = tabs[current];
    if (tab) {
      marker.style.setProperty("--y", `${tab.offsetTop}px`);
      marker.style.setProperty("--h", `${tab.offsetHeight}px`);
    }
  };

  const select = (index: number, play: boolean) => {
    const feature = features[index];
    const tab = tabs[index];
    if (!(feature && tab)) {
      return;
    }
    current = index;
    for (const [other, button] of tabs.entries()) {
      button.setAttribute("aria-selected", String(other === index));
      button.tabIndex = other === index ? 0 : -1;
    }
    panel.setAttribute("aria-labelledby", tab.id);
    caption.textContent = feature.title;
    outfit.src = outfits[feature.outfit];
    place();
    // Playback starts only while the section is active; otherwise the phone
    // shows the feature finished.
    if (play && active) {
      chat.play(feature.script);
    } else {
      chat.fill(feature.script);
    }
  };

  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => select(index, true));
    tab.addEventListener("keydown", (event) => {
      const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
      if (step) {
        event.preventDefault();
        const nextIndex = (index + step + tabs.length) % tabs.length;
        tabs[nextIndex]?.focus();
        select(nextIndex, true);
      }
    });
  }
  replay.addEventListener("click", () => select(current, true));
  window.addEventListener("resize", place);
  select(0, false);

  // The first time the section is active the picked feature plays; when it
  // leaves the screen (or the tab hides) playback stops on what it showed.
  // Under reduced motion the phone shows the picked feature finished.
  let played = false;
  whenActive(section, (isActive) => {
    active = isActive;
    const feature = features[current];
    if (!isActive) {
      chat.stop();
      if (feature && isReduced()) {
        chat.fill(feature.script);
      }
      return;
    }
    if (feature && !played) {
      played = true;
      chat.play(feature.script);
    }
  });
};

export { features };
