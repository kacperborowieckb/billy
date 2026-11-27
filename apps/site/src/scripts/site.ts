import { startExplorer } from "./explorer";
import { startKeeps } from "./keeps";
import { startValley } from "./valley";

// The site's script: the day and night switch, the header material, the
// Product menu, and the three played conversations (the hero valley, "What
// Billy keeps" and the app explorer). Everything reads the same without it.

const root = document.documentElement;
const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const themeKey = "billy-theme";

const isNight = () =>
  root.dataset.theme ? root.dataset.theme === "dark" : darkScheme.matches;

const toggles = [
  ...document.querySelectorAll<HTMLButtonElement>("[data-theme-toggle]"),
];

const labelToggles = () => {
  for (const toggle of toggles) {
    toggle.setAttribute(
      "aria-label",
      isNight() ? "Switch to day" : "Switch to night"
    );
  }
};

const setTheme = (theme: "light" | "dark") => {
  root.dataset.theme = theme;
  try {
    localStorage.setItem(themeKey, theme);
  } catch {
    // Storage can be blocked; the choice then lasts for this page only.
  }
  labelToggles();
};

const switchTheme = (from: HTMLElement) => {
  const next = isNight() ? "light" : "dark";
  if (!document.startViewTransition || reducedMotion.matches) {
    setTheme(next);
    return;
  }
  const box = from.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const radius = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y)
  );
  root.style.setProperty("--reveal-x", `${x}px`);
  root.style.setProperty("--reveal-y", `${y}px`);
  root.style.setProperty("--reveal-r", `${radius}px`);
  document.startViewTransition(() => setTheme(next));
};

for (const toggle of toggles) {
  toggle.addEventListener("click", () => switchTheme(toggle));
}
darkScheme.addEventListener("change", labelToggles);
labelToggles();

// The header turns into a material once the page scrolls under it.
const masthead = document.querySelector<HTMLElement>("[data-masthead]");
if (masthead) {
  const update = () =>
    masthead.classList.toggle("is-scrolled", window.scrollY > 8);
  window.addEventListener("scroll", update, { passive: true });
  update();
}

// The Product menu: opens on click, or after a short hover where there is a
// fine pointer; Escape and moving focus away close it.
const product = document.querySelector<HTMLElement>("[data-menu]");
const productButton = product?.querySelector<HTMLButtonElement>("button");
if (product && productButton) {
  let timer = 0;
  const setOpen = (open: boolean) => {
    product.classList.toggle("is-open", open);
    productButton.setAttribute("aria-expanded", String(open));
  };
  const later = (open: boolean) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => setOpen(open), 120);
  };
  productButton.addEventListener("click", () =>
    setOpen(!product.classList.contains("is-open"))
  );
  if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
    product.addEventListener("pointerenter", () => later(true));
    product.addEventListener("pointerleave", () => later(false));
  }
  product.addEventListener("focusout", (event) => {
    if (!product.contains(event.relatedTarget as Node | null)) {
      setOpen(false);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setOpen(false);
    }
  });
  for (const link of product.querySelectorAll("a")) {
    link.addEventListener("click", () => setOpen(false));
  }
}

startValley();
startKeeps();
startExplorer();
