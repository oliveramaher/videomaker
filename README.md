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

## Optional live Gemini recipe

```sh
npm run capture -- examples/gemini-directed.mjs --output output/playwright/gemini-directed
npm run prepare-demo -- output/playwright/gemini-directed
npm run render -- output/gemini-demo.mp4 --props '{"take":"gemini-directed"}'
```

This example requires a reachable English chat composer. Browser capture options include `--headed` to watch, `--channel chrome` for installed Chrome, and `--storage-state <file>` to load an existing Playwright session. Each run requires a fresh output directory.

Use `--interval-ms 1000` for additional structured snapshots between named checkpoints. Use `--no-archive` to skip MHTML or `--no-assets` to skip saving resource bodies. Interval snapshots can affect page timing and bundle size, especially when MHTML is enabled.

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
