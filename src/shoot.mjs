// Turn a product map + storyboard into a filmed take.
// compileShootPlan() is pure data (inspectable as shoot-plan.json); createShootRecipe() returns
// a capture() recipe that performs it with the director, so motion stays smooth and cue-aligned.
//
// Cue conventions written into direction.json (read by video/Ad.jsx):
//   marker  shot:<i>:start | shot:<i>:payoff | shot:<i>:end
//   anchor  shot:<i>:target:<j>   element each step acts on (box + contentBox)
//   anchor  shot:<i>:payoff       region that appeared or moved after the shot's last step
//   anchor  logo                  the product's logo, if one was found

const sameStep = (a, b) => a.action === b.action && a.text === b.text && a.key === b.key
  && a.locator?.role === b.locator?.role && a.locator?.name === b.locator?.name && (a.locator?.nth ?? 0) === (b.locator?.nth ?? 0);

/** Pure: decide what to perform for each storyboard shot. */
export function compileShootPlan(map, storyboard) {
  const byName = new Map(map.features.map((feature) => [feature.name, feature]));
  const shots = [];
  let previous = null;
  for (const [index, shot] of storyboard.shots.entries()) {
    const feature = byName.get(shot.feature);
    if (!feature) throw new Error(`Storyboard shot ${index + 1} uses unknown feature "${shot.feature}".`);
    const steps = feature.steps.map(({action, locator, text, option, key, url, direction}) =>
      ({action, locator, text, option, key, url, direction}));
    const startUrl = feature.startUrl ?? feature.steps[0]?.urlBefore ?? map.app.startUrl;
    // Continue from the previous shot when this feature starts with exactly what was just filmed.
    const continues = previous && previous.startUrl === startUrl && previous.allSteps.length < steps.length
      && previous.allSteps.every((step, i) => sameStep(step, steps[i]));
    const filmed = continues ? steps.slice(previous.allSteps.length) : steps;
    const compiled = {
      index, feature: feature.name, caption: shot.caption, emphasis: shot.emphasis, lift: shot.lift,
      startUrl, navigate: !continues, skippedSteps: continues ? previous.allSteps.length : 0, steps: filmed,
    };
    shots.push(compiled);
    previous = {startUrl, allSteps: steps};
  }
  return {
    version: 1,
    app: map.app,
    clutter: (map.clutter ?? []).map(({role, name}) => ({role, name})),
    shots,
  };
}

// ---- In-page helpers (serialized into the browser) ----

/** Visible text grouped by parent element: what a viewer would read. */
function readTextBlocks() {
  const blocks = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent.replace(/\s+/g, ' ').trim();
    const parent = node.parentElement;
    if (!text || !parent || !parent.checkVisibility({opacityProperty: true, visibilityProperty: true})) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > innerHeight) continue;
      const entry = blocks.get(parent) ?? {text: '', x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity};
      if (!entry.text.includes(text)) entry.text = `${entry.text} ${text}`.trim();
      entry.x1 = Math.min(entry.x1, rect.left); entry.y1 = Math.min(entry.y1, rect.top);
      entry.x2 = Math.max(entry.x2, rect.right); entry.y2 = Math.max(entry.y2, rect.bottom);
      blocks.set(parent, entry);
    }
  }
  // Controls count at their full size and keep their label, so a new "Add all" button
  // isn't mistaken for some other button that merely existed before.
  for (const control of document.querySelectorAll('button, input, select, textarea, img, svg, canvas, video')) {
    if (!control.checkVisibility()) continue;
    const rect = control.getBoundingClientRect();
    if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > innerHeight) continue;
    const label = control.getAttribute('aria-label') || control.innerText?.trim() || control.value || control.getAttribute('alt') || '';
    const entry = blocks.get(control) ?? {text: '', x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity};
    entry.text = `<${control.localName}>${label.replace(/\s+/g, ' ')}`;
    entry.x1 = Math.min(entry.x1, rect.left); entry.y1 = Math.min(entry.y1, rect.top);
    entry.x2 = Math.max(entry.x2, rect.right); entry.y2 = Math.max(entry.y2, rect.bottom);
    blocks.set(control, entry);
  }
  return Array.from(blocks.values(), ({text, x1, y1, x2, y2}) =>
    ({text, x: Math.round(x1), y: Math.round(y1), width: Math.round(x2 - x1), height: Math.round(y2 - y1)}));
}

/** Hide clutter the explorer flagged, now and whenever the app re-renders it. */
function installClutterHider(items) {
  const clean = (text) => (text ?? '').replace(/\s+/g, ' ').trim();
  const implicit = {BUTTON: 'button', A: 'link', SELECT: 'combobox', TEXTAREA: 'textbox', DIALOG: 'dialog'};
  const containerOf = (element) => element.closest('dialog, [role=dialog], [role=alertdialog], [role=tooltip], [popover], [aria-live]')
    ?? (() => {
      for (let node = element; node && node !== document.body; node = node.parentElement) {
        if (['fixed', 'absolute', 'sticky'].includes(getComputedStyle(node).position)) return node;
      }
      return element;
    })();
  const sweep = () => {
    for (const element of document.querySelectorAll('body *')) {
      const role = element.getAttribute('role') ?? implicit[element.tagName];
      const name = clean(element.getAttribute('aria-label')) || clean(element.innerText);
      if (!items.some((item) => item.role === role && item.name === name)) continue;
      const target = ['button', 'link'].includes(role) ? containerOf(element) : element;
      target.style.setProperty('display', 'none', 'important');
    }
  };
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; sweep(); });
  };
  const start = () => {
    sweep();
    new MutationObserver(schedule).observe(document.documentElement, {childList: true, subtree: true});
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true});
  else start();
}

/** Tag a likely logo near the top of the page. */
function tagLogo() {
  const candidates = document.querySelectorAll(
    '[class*=logo i], [id*=logo i], [aria-label*=logo i], img[alt*=logo i], header a[href="/"], nav a[href="/"]');
  for (const element of candidates) {
    const rect = element.getBoundingClientRect();
    if (!element.checkVisibility() || rect.top > 160 || rect.width < 16 || rect.width > 420 || rect.height > 140) continue;
    element.setAttribute('data-vm-logo', '');
    return true;
  }
  return false;
}

// ---- Node-side helpers ----

async function waitForStable(page, {quietMs = 550, timeoutMs = 9000} = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  let since = Date.now();
  while (Date.now() < deadline) {
    const now = JSON.stringify(await page.evaluate(readTextBlocks).catch(() => []));
    if (now !== last) { last = now; since = Date.now(); }
    if (Date.now() - since >= quietMs) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

/** Union of text/controls that are new, or moved by more than a few pixels, between two readings. */
export function payoffRegion(before, after, viewport) {
  const seen = new Map();
  for (const block of before) {
    const list = seen.get(block.text) ?? [];
    list.push(block);
    seen.set(block.text, list);
  }
  const fresh = [];
  const moved = [];
  for (const block of after) {
    const candidates = seen.get(block.text);
    if (!candidates) fresh.push(block);
    else if (!candidates.some((old) => Math.abs(old.x - block.x) < 24 && Math.abs(old.y - block.y) < 24)) moved.push(block);
  }
  const union = (blocks) => ({
    x1: Math.min(...blocks.map((b) => b.x)), y1: Math.min(...blocks.map((b) => b.y)),
    x2: Math.max(...blocks.map((b) => b.x + b.width)), y2: Math.max(...blocks.map((b) => b.y + b.height)),
  });
  // New content is the payoff. Content that merely shifted (pushed down by it) is not,
  // unless the new bits are tiny (e.g. checkboxes) and the moved text sits right beside them.
  let changed = fresh.length ? fresh : moved;
  if (fresh.length) {
    const u = union(fresh);
    if (u.x2 - u.x1 < 160 || u.y2 - u.y1 < 40) {
      changed = fresh.concat(moved.filter((b) => b.x < u.x2 + 60 && b.x + b.width > u.x1 - 60
        && b.y < u.y2 + 60 && b.y + b.height > u.y1 - 60));
    }
  }
  if (!changed.length) return null;
  const x1 = Math.max(0, Math.min(...changed.map((b) => b.x)));
  const y1 = Math.max(0, Math.min(...changed.map((b) => b.y)));
  const x2 = Math.min(viewport.width, Math.max(...changed.map((b) => b.x + b.width)));
  const y2 = Math.min(viewport.height, Math.max(...changed.map((b) => b.y + b.height)));
  if (x2 - x1 < 8 || y2 - y1 < 8) return null;
  return {x: x1, y: y1, width: x2 - x1, height: y2 - y1};
}

/** Find the element a recorded step acted on, trying progressively looser queries. */
export async function resolveLocator(page, locator) {
  if (!locator) return null;
  const nth = locator.nth ?? 0;
  const attempts = [];
  if (locator.role && locator.role !== 'generic') {
    attempts.push(page.getByRole(locator.role, {name: locator.name, exact: true}));
    attempts.push(page.getByRole(locator.role, {name: locator.name}));
  }
  if (locator.name) {
    attempts.push(page.getByLabel(locator.name, {exact: true}));
    attempts.push(page.getByText(locator.name, {exact: true}));
  }
  for (const candidate of attempts) {
    const count = await candidate.count().catch(() => 0);
    if (count > nth && await candidate.nth(nth).isVisible().catch(() => false)) return candidate.nth(nth);
  }
  throw new Error(`Could not find ${locator.role} "${locator.name}" on ${page.url()}. The app may have changed since exploring.`);
}

/** A capture() recipe that films the compiled plan. */
export function createShootRecipe(plan, {viewport = {width: 1280, height: 800}, holdMs = 1500, liftHoldMs = 2400} = {}) {
  return async function shoot({page, step, checkpoint, director}) {
    const {cursor} = director;
    if (plan.clutter.length) {
      await page.addInitScript(installClutterHider, plan.clutter);
    }
    let bend = 0.22;
    let started = false;
    for (const shot of plan.shots) {
      const label = `shot:${shot.index}`;
      if (shot.navigate) {
        await step(`${label} setup`, async () => {
          if (page.url() === shot.startUrl) await page.reload({waitUntil: 'domcontentloaded'});
          else await page.goto(shot.startUrl, {waitUntil: 'domcontentloaded'});
          await page.evaluate(() => document.fonts.ready.then(() => {}));
          await waitForStable(page);
        });
      }
      if (!started) {
        if (await page.evaluate(tagLogo)) await director.anchor('logo', page.locator('[data-vm-logo]').first());
        await checkpoint('Ready');
        await director.start({x: viewport.width * 0.82, y: viewport.height * 0.8});
        await director.wait(500);
        started = true;
      }
      director.mark(`${label}:start`);
      let before = await page.evaluate(readTextBlocks);
      let lastTarget = null;
      for (const [j, action] of shot.steps.entries()) {
        const target = await resolveLocator(page, action.locator);
        if (target) {
          await target.scrollIntoViewIfNeeded();
          lastTarget = await director.anchor(`${label}:target:${j}`, target);
        }
        if (j === shot.steps.length - 1) before = await page.evaluate(readTextBlocks);
        bend = -bend;
        await step(`${label} ${action.action} ${action.locator?.name ?? action.key ?? ''}`.trim(), async () => {
          switch (action.action) {
            case 'click':
              await cursor.click(target, {speedPxPerSecond: 720, bend});
              break;
            case 'hover':
              await cursor.hover(target, {holdMs: 550, speedPxPerSecond: 650, bend});
              break;
            case 'type':
              await target.fill('');
              await cursor.click(target, {speedPxPerSecond: 720, bend});
              await director.type(action.text ?? '', {wordsPerMinute: 120, seed: 7 + j});
              break;
            case 'select':
              await cursor.move(target, {speedPxPerSecond: 720, bend});
              await target.selectOption({label: action.option});
              break;
            case 'press':
              await page.keyboard.press(action.key);
              break;
            case 'scroll':
              await page.mouse.wheel(0, action.direction === 'up' ? -500 : 500);
              break;
            case 'goto':
              await page.goto(action.url, {waitUntil: 'domcontentloaded'});
              break;
            case 'back':
              await page.goBack({waitUntil: 'domcontentloaded'});
              break;
            default:
              throw new Error(`Unsupported step "${action.action}".`);
          }
        });
        await waitForStable(page);
        await director.wait(300);
      }
      const after = await page.evaluate(readTextBlocks);
      const found = payoffRegion(before, after, viewport);
      // Breathing room around the payoff so close-ups don't clip button corners or text.
      const pad = 16;
      const region = found ? {
        x: Math.max(0, found.x - pad), y: Math.max(0, found.y - pad),
        width: Math.min(viewport.width, found.x + found.width + pad) - Math.max(0, found.x - pad),
        height: Math.min(viewport.height, found.y + found.height + pad) - Math.max(0, found.y - pad),
      } : lastTarget;
      director.mark(`${label}:payoff`);
      if (region) director.anchorRect(`${label}:payoff`, region);
      await checkpoint(`${shot.feature} payoff`);
      await director.wait(shot.lift ? liftHoldMs : holdMs);
      director.mark(`${label}:end`);
    }
    await cursor.hide();
    await director.wait(200);
    director.end();
  };
}
