// Played and ambient motion runs only while its section is on screen, the
// tab is visible, and the person has not asked for reduced motion. This
// calls back whenever that answer changes, and marks the section
// `is-paused` otherwise, so its CSS loops (clouds, water, stars) stop too.
const reducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)");

export const isReduced = () => reducedMotion().matches;

export const whenActive = (
  section: HTMLElement,
  change?: (active: boolean) => void
) => {
  let visible = false;
  let active: boolean | undefined;
  const update = () => {
    const next = visible && !document.hidden && !isReduced();
    section.classList.toggle("is-paused", !next);
    if (next !== active) {
      active = next;
      change?.(next);
    }
  };
  new IntersectionObserver(
    ([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      update();
    },
    { threshold: 0.25 }
  ).observe(section);
  document.addEventListener("visibilitychange", update);
  reducedMotion().addEventListener("change", update);
  section.classList.add("is-paused");
};
