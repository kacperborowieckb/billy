# Marketing site

The public site for Billy: a static [Astro](https://docs.astro.build/) project ([decision 0026](../../docs/decisions/0026-marketing-site-stack.md)). It builds plain HTML and CSS, one small script, and React islands only where a shadcn component needs them.

```sh
pnpm --filter @repo/site dev      # local server with reload
pnpm --filter @repo/site build    # writes dist/
pnpm --filter @repo/site verify   # astro check, build, and tests
```

## Where things come from

- Colors, type, spacing, radii, sizes, shadows, and motion: `@repo/tokens/tokens.css`. Never write a value by hand; add a token with a usage note instead ([tokens README](../../packages/tokens/README.md)). The tests refuse a hand-written color.
- Billy, his outfits, his pixel world, and the pixel icons: `@repo/mascot`, through [src/art.ts](src/art.ts). Pixel art is imported as a file URL, drawn with `.px` (`image-rendering: pixelated`), and never redrawn or recolored.
- Standard controls (Button, Accordion, Sheet, Separator) are shadcn/ui components in `src/components/ui`, added with `pnpm dlx shadcn@4.23.0 add <name>` from this folder. Their colors and radii map to the tokens in `src/styles/ui.css`; never give them raw colors. In `.astro` files, style a link with `buttonVariants()`; `asChild` works only inside React components.
- Bubble and Card, Billy, and the pixel world are ours, drawn from [the component contracts](../../docs/product/components.md).

## Layout

- `src/pages`: one file per route (`index.astro`, `404.astro`).
- `src/components`: page sections (`header`, `hero`, `keeps`, `explorer`, `self-host`, `faq`, `footer`) and the drawn pieces (`phone`, the iPhone around a chat; `billy`, `cloud`, `mini-world`).
- `src/styles/site.css`: the reset, the content column (`.wrap`), the marketing type classes, day and night scenery, and the shared motion. `src/styles/chat.css`: the drawn iPhone and the chat inside it, from the Bubble, Card and Chip contracts.
- `src/scripts`: `site.ts` (day and night, the header material, the Product menu) starts the three played conversations: `valley.ts` (the hero), `keeps.ts` ("What Billy keeps") and `explorer.ts` ("See it in the app"). `chat.ts` plays a script in a phone; `markup.ts` builds a message's cards, task lists and quick replies; `stories.ts`, `features.ts` and `soon.ts` hold the conversations; `timing.ts` has the waits.

## Motion

Motion follows `.agents/skills/apple-design`, `.agents/skills/emil-design-eng`, and `.agents/skills/review-animations`, with durations and curves from the motion tokens.

- Day and night: the site opens in day. The switch in the header saves the choice (`billy-theme` in local storage, applied before first paint) and plays a circular reveal out of it with the View Transitions API (`duration-theme`). Without that API, or under reduced motion, the theme switches at once. At night the scenery is dimmed with a filter; Billy never is.
- Hero: "Tell Billy." arrives word by word out of a blur, holds a beat, then "He'll do it all." follows; the line and buttons rise after it. Below, the valley's light moves from dawn to day to dusk (`duration-sky`), the sun moves with it, Billy changes outfit, a small bubble above him says what he just did, and the phone beside him plays that time of day's chat.
- Chats (`chat.ts`): your message types into the composer, the send button presses, and the bubble rises 18px from 96% with a small spring (`duration-send`, `easing-send`); Billy's reply grows out of his corner from half size (`duration-receive`, `easing-receive`), his cards and quick replies pop in just after, and older messages slide up as each one lands (transform only). A picked quick reply turns honey and its check draws in; Brief tasks tick and strike through.
- "What Billy keeps": the Notes window files a message, a new Reminder lands on top while the others step down, and the Brief ticks off with its bar filling.
- "See it in the app": the list is a vertical tablist (arrow keys move through it); the selected card slides to the picked row and the phone plays that feature.
- Scenery: clouds drift and float, the water flows, the footer's stars twinkle. The hills artwork tiles without a seam.
- Feedback: buttons and chips scale on press; a primary button's chevron steps forward on hover. Nothing lifts on hover.
- Everything played runs only while its section is on screen and the tab is visible. Under reduced motion nothing moves: each phone and window shows its finished conversation. Without script the same finished pictures are missing, but every heading, line and link is there.

Verification is described in [docs/verification/site.md](../../docs/verification/site.md).
