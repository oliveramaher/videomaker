# VideoMaker

A Playwright library and CLI for recording a website interaction and collecting the browser state behind it. Each capture is a local directory with timestamped viewport pixels and structured UI snapshots that an editor or conversion pipeline can consume later.

## What’s in the repo

- **General library** — [`src/`](src/) records browser footage and UI state, directs mouse and camera movements, and prepares a timeline. [`video/`](video/) renders that timeline with Remotion. Any product can supply its own Playwright recipe.
- **Gemini example** — [`examples/gemini-directed.mjs`](examples/gemini-directed.mjs) opens Gemini, types and submits a prompt, then frames the response. [`examples/gemini.mjs`](examples/gemini.mjs) is the capture-only version.

## Make a product demo

```sh
npm ci
npx playwright install chromium
npm run capture -- examples/local.mjs --output output/playwright/local-demo
npm run prepare-demo -- output/playwright/local-demo
npm run studio
npm run render -- output/local-demo.mp4
```

The offline recipe films a project search with a curved cursor path, a camera push-in, variable typing cadence, and an animated result. Remotion composes the camera and visible pointer over the browser footage. The fixture also exercises stylesheet capture, shadow DOM, and iframes.

The prepare step selects frames at the output frame rate and creates a take under `output/video-assets`. A fresh take name is required for each preparation. Use `--name` to create a new edit from the same recording, `--fps` to set the export frame rate, or repeat `--cut FROM:TO` to remove ranges in seconds from the start of the take. For another take, set the `take` prop in Studio or pass `--props '{"take":"my-take"}'` when rendering.

### Direct a take on another site

```js
export default async function ({page, director, checkpoint}) {
  await page.goto('https://your-product.example/');
  const field = page.getByRole('textbox', {name: 'Search'});
  await field.waitFor();
  await director.start({x: 850, y: 600});
  await director.cursor.click(field, {durationMs: 850, bend: 0.24});
  await director.camera.focus(field, {zoom: 1.55, durationMs: 700});
  await director.wait(500);
  await director.type('Search terms', {seed: 55});
  await checkpoint('Search entered');
  await director.cursor.click(page.getByRole('button', {name: 'Search'}));
  director.camera.wide(700);
  await page.getByRole('heading', {name: 'Results'}).waitFor();
  await director.wait(1000);
  director.end();
}
```

The director operates in viewport CSS pixels. Use Playwright locators or viewport points for mouse moves and camera framing. Optional caret-follow uses the rendered selection geometry of a contenteditable field in the main document. `direction.json` stores the original mouse coordinates, clicks, keystroke timing, caret positions, markers, and camera cues. The prepared `timeline.json` references the original source time for each output frame, which keeps both overlays aligned through cuts. You can reuse the same capture to change the edit, cursor scale, click color, and camera strength.

Each product recipe supplies its own selectors and waits for the specific UI states to film.

### Schedule typing and mouse movements

```js
await director.start({x: 900, y: 650});
await director.cursor.move({x: 380, y: 410}, {
  from: {x: 900, y: 650},
  startAtMs: 500,
  speedPxPerSecond: 600,
});
// Focus the field before typing.
await director.type('Find my project', {startAtMs: 1900, wordsPerMinute: 85, seed: 42});
```

`startAtMs` is measured from `director.start()`. Awaited actions start as soon as possible if the scheduled time has passed. Typing uses seeded timing variation and pauses around spaces and punctuation. Mouse speed sets the duration from the straight-line distance. The cursor follows an eased Bézier curve between the endpoints.

### Direct hover and check shot readiness

```js
await director.waitForReady([logo, searchField], {stableMs: 400});
await director.start();
await director.cursor.move({x: 480, y: 320});
const effect = await director.cursor.hover(helpButton, {holdMs: 500});
await director.cursor.click(searchField);
```

`waitForReady` checks the selected elements' geometry and visual properties before filming. Cursor travel is drawn in Remotion while the browser pointer is parked outside the viewport. Explicit hovers and clicks send real input at the destination, so the browser runs the site's native styles and JavaScript. A hover probe records selected visual properties before and after, plus newly visible popup candidates. The capture also records browser hit targets and source-frame timestamps to help align the virtual cursor with interactive states.

The browser remains the runtime for site behavior. The saved frames, snapshots, and interaction cues support editing and inspection after capture. Re-running a new interaction still requires the browser and the site.

## Optional live Gemini recipe

Use `await director.hideElement('.onboarding-tooltip')` to hide elements by CSS selector. The rule removes matching elements from the filmed layout, including elements inserted later. Register it before navigation to suppress a popup from the first frame. The Gemini recipe uses it for the task tooltip, the sign-in overlay, and three marketing links.

`await director.findPopupCandidates()` returns visible candidates in the main document with their text, bounds, and detection reasons. It checks for native dialogs and popovers, ARIA dialog and tooltip semantics, and explicit overlay variants. Custom popups without these signals may need manual inspection. The recipe chooses which candidates to hide.

```sh
npm run capture -- examples/gemini-directed.mjs --output output/playwright/gemini-directed
npm run prepare-demo -- output/playwright/gemini-directed
npm run render -- output/gemini-demo.mp4 --props '{"take":"gemini-directed"}'
```

This example requires a reachable English chat composer. Browser capture options include `--headed` to watch, `--channel chrome` for installed Chrome, and `--storage-state <file>` to load an existing Playwright session. Each run requires a fresh output directory.

Use `--interval-ms 1000` for additional structured snapshots between named checkpoints. Use `--no-archive` to skip MHTML or `--no-assets` to skip saving resource bodies. Interval snapshots can affect page timing and bundle size, especially when MHTML is enabled.

## Explore an unfamiliar app

The explorer lets Claude learn a product nobody has scripted yet. It logs in, clicks through the app in a real browser, and writes a **product map**: each screen's purpose, each feature it exercised as replayable steps (role and accessible-name locators), a 1–5 score for how good that feature would look on screen, and clutter to hide when filming. A later storyboard step will turn the map into director recipes.

```sh
cp .env.example .env          # add ANTHROPIC_API_KEY and the app's URL and login
npm run demo-app              # optional: a local practice app, Tasklane, on port 4317
npm run login                 # signs in with APP_USERNAME/APP_PASSWORD, saves a session
npm run explore -- --actions 40 --brief "Focus on creating and planning projects"
```

Output lands in `output/explore/<timestamp>/`: `product-map.json`, `actions.jsonl` (every action with before/after changes), and `shots/` (a clean and a numbered screenshot per step).

- **Credentials** are typed into the login form by code and saved as a Playwright session. They are never sent to the model. Use `npm run login -- --manual` to sign in by hand for MFA or SSO.
- **Guard.** Clicks on anything that looks destructive or outward-facing (delete, pay, upgrade, send, invite, log out…) are refused in code, as is pressing Enter in a form whose button would be refused, and navigating to another site. Pass `--allow "Exact button name"` to permit a specific button.
- **Cost.** Each action is one model request with a screenshot. `--actions` caps browser actions; old screenshots are cleared from context automatically. The CLI prints token usage at the end. Defaults: `claude-opus-5-5` at `--effort medium`.
- `npm test` runs the explorer against the demo app, including the agent loop with a scripted model (no API calls).

## Write a recipe

The CLI loads a trusted JavaScript module with a default function. The function receives a normal Playwright `page`, a labeled `step` wrapper, and a `checkpoint` function.

```js
export const viewport = {width: 1280, height: 800};

export default async function ({page, step, checkpoint}) {
  await step('Open page', () => page.goto('https://example.com/'));
  await checkpoint('Page loaded');
  await step('Follow link', () => page.getByRole('link').first().click());
}
```

Use `capture({output, run, viewport, launch, context, snapshotIntervalMs})` from [src/capture.mjs](src/capture.mjs) to call the library directly. It adds a final checkpoint and returns `{directory, manifest}`. If the recipe fails, the original error is rethrown after the recorder saves available artifacts.

## What the bundle contains

| File | Contents |
| --- | --- |
| `manifest.json` | Step and checkpoint timing, capture status, frame count, and reported collection errors |
| `frames.json` and `frames/*.png` | Lossless viewport images emitted by Chromium, including rendered canvas, video, and UI animations when visible. Prefer each entry’s Chromium `metadata.timestamp` in epoch seconds for playback timing. `atMs` is the local receipt time. |
| `snapshots/*/viewport.png` | A viewport screenshot at each checkpoint |
| `snapshots/*/targets/*/dom.json` | Chromium DOM and layout snapshot, including shadow DOM, string-indexed nodes, computed built-in CSS values, geometry, and paint order. The stored `computedStyles` array names the columns. |
| `snapshots/*/targets/*/accessibility.json` and `stylesheets.json` | Accessibility trees with Chromium frame IDs, plus stylesheet source with origin and frame metadata |
| `snapshots/*/frame-state.json` | Frame hierarchy, live form values, focus, selection, scroll, root CSS variables, adopted stylesheets, and current animation timing and keyframes |
| `snapshots/*/page.mhtml` | Chromium’s page archive at that checkpoint. Treat this as untrusted page content when opening it. |
| `animations.json` | Chromium animation start and cancel events observed by the collector |
| `assets.json` and `assets/*` | Observed image, font, media, and stylesheet responses with content-addressed bodies, MIME types, byte ranges where present, and per-resource status |

The PNGs preserve the pixels Chromium delivered. Screencast cadence varies with page activity and browser load, and Chromium can omit frames. Checkpoint artifacts are collected over a time window. They can differ slightly while the page is changing. The capture follows one tab and its frames. Browser chrome, audio, app-internal React component definitions, and JavaScript application state are outside the archive. Canvas, video, and script-driven effects are represented visually. Structured capture of rapidly changing DOM depends on checkpoint frequency. Separate-process iframes get their own targets when available, with continuous animation events scoped to the main target.

Resource bodies are collected from the browser’s actual responses. They are capped at 32 MiB per body and 256 MiB total by default, configurable via `assets: {perAssetBytes, totalBytes}` in the library. The manifest distinguishes completed runs, partial collections, and recipe failures. A completed run means the requested collectors reported success.

Captures can include visible account details, URLs, and entered form values. Review a bundle before sharing it. The default output directory is Git-ignored.
