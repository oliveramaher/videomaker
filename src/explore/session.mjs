// The browser side of exploration: guarded actions, an action log with replayable
// locators, before/after diffs, and the growing product map. No model code here,
// so it can be driven by the agent, a test, or a person.
import {mkdir, writeFile, appendFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {chromium} from 'playwright';
import {createGuard} from './guard.mjs';
import {describe, diff, observe} from './observe.mjs';

const locatorFor = (element) => ({role: element.role, name: element.name, nth: element.nth});

export async function openSession({
  startUrl,
  output,
  storageState,
  viewport = {width: 1280, height: 800},
  headless = true,
  allowNames = [],
  launch = {},
}) {
  const directory = resolve(output);
  await mkdir(join(directory, 'shots'), {recursive: true});
  const origin = new URL(startUrl).origin;
  const guard = createGuard({origin, allowNames});
  const browser = await chromium.launch({headless, ...launch});
  const context = await browser.newContext({viewport, storageState});
  const page = await context.newPage();
  page.setDefaultTimeout(8000);

  const events = [];
  // Native alert/confirm/prompt would block the page; dismiss and report them.
  page.on('dialog', (dialog) => {
    events.push(`native ${dialog.type()} "${dialog.message()}" appeared and was dismissed`);
    dialog.dismiss().catch(() => {});
  });
  // Keep exploration in one tab.
  context.on('page', (popup) => {
    if (popup === page) return;
    events.push(`a new tab opened (${popup.url() || 'blank'}) and was closed`);
    popup.close().catch(() => {});
  });
  // Block navigation away from the app at the network level, not just in tools.
  // An aborted navigation leaves Chrome's error page, so return to the last good URL.
  let lastGoodUrl = startUrl;
  let recovering = null;
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    if (!guard.checkUrl(url)) lastGoodUrl = url;
    else if (url.startsWith('chrome-error:') && !recovering) {
      recovering = page.goto(lastGoodUrl, {waitUntil: 'domcontentloaded'}).catch(() => {})
        .finally(() => { recovering = null; });
    }
  });
  await page.route('**/*', (route) => {
    const request = route.request();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      const reason = guard.checkUrl(request.url());
      if (reason) {
        events.push(`blocked navigation to ${request.url()}: ${reason}`);
        return route.abort('blockedbyclient');
      }
    }
    return route.continue();
  });

  let queue = Promise.resolve();
  const serial = (task) => {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  };

  let current = null;
  let shotIndex = 0;
  const actions = [];
  const map = {
    version: 1,
    app: {startUrl, origin, exploredAt: new Date().toISOString()},
    pages: {},
    features: [],
    clutter: [],
    summary: null,
  };

  const saveShots = async (state) => {
    const index = String(++shotIndex).padStart(4, '0');
    const clean = `shots/${index}.jpg`;
    await writeFile(join(directory, clean), state.screenshots.clean);
    await writeFile(join(directory, `shots/${index}-marked.jpg`), state.screenshots.marked);
    return clean;
  };

  const look = async () => {
    const state = await observe(page);
    state.shot = await saveShots(state);
    const key = new URL(state.url).pathname + new URL(state.url).hash.replace(/\/\d+(?=\/|$)/g, '/:id');
    map.pages[key] ??= {url: state.url, title: state.title, headings: state.headings, firstShot: state.shot};
    current = state;
    return state;
  };

  const drainEvents = () => events.splice(0, events.length);

  /** Perform a guarded action, then return what changed plus a fresh observation. */
  const act = (kind, ref, perform, extra = {}) => serial(async () => {
    if (!current) await look();
    const element = ref === undefined ? null : current.elements.find((el) => el.ref === ref);
    if (ref !== undefined) {
      const refusal = guard.checkElement(element, kind);
      if (refusal) {
        const entry = {id: actions.length + 1, kind, ref, refused: refusal, element: element && locatorFor(element)};
        actions.push(entry);
        await appendFile(join(directory, 'actions.jsonl'), JSON.stringify(entry) + '\n');
        return {entry, refused: refusal, state: current};
      }
    }
    const before = current;
    const target = element ? page.locator(`[data-vm-ref="${ref}"]`) : null;
    let error = null;
    try {
      await perform(target, element);
      await page.waitForLoadState('domcontentloaded', {timeout: 3000}).catch(() => {});
      await page.waitForTimeout(400);
      if (recovering) await recovering;
    } catch (caught) {
      error = caught.message.split('\n')[0];
    }
    const after = await look();
    const entry = {
      id: actions.length + 1,
      kind,
      ref,
      element: element && {...locatorFor(element), tag: element.tag, box: element.box},
      ...extra,
      urlBefore: before.url,
      urlAfter: after.url,
      changes: error ? [] : diff(before, after),
      events: drainEvents(),
      error,
      shotBefore: before.shot,
      shotAfter: after.shot,
    };
    actions.push(entry);
    await appendFile(join(directory, 'actions.jsonl'), JSON.stringify(entry) + '\n');
    return {entry, state: after};
  });

  const pressGuard = async (key) => {
    const keyRefusal = guard.checkKey(key);
    if (keyRefusal) return keyRefusal;
    if (key !== 'Enter') return null;
    // Enter can submit a form; refuse if that form's submit button would be refused.
    const submitNames = await page.evaluate(() => {
      const form = document.activeElement?.form ?? document.activeElement?.closest?.('form');
      return form ? Array.from(form.querySelectorAll('button, input[type=submit]'),
        (button) => (button.innerText || button.value || button.getAttribute('aria-label') || '').trim()) : [];
    });
    for (const name of submitNames) {
      const refusal = guard.checkElement({name}, 'click');
      if (refusal) return `pressing Enter would submit a form with ${refusal}`;
    }
    return null;
  };

  return {
    page,
    directory,
    map,
    actions,
    get current() { return current; },
    describe,

    start: () => serial(async () => {
      await page.goto(startUrl, {waitUntil: 'domcontentloaded'});
      return look();
    }),
    observe: () => serial(look),

    click: (ref) => act('click', ref, (target, element) =>
      target.click({timeout: 5000, position: element.clickPoint})),
    hover: (ref) => act('hover', ref, async (target, element) => {
      await target.hover({timeout: 5000, position: element.clickPoint});
      await page.waitForTimeout(500);
    }),
    type: (ref, text, {clear = true} = {}) => act('type', ref, async (target) => {
      if (clear) await target.fill('', {timeout: 5000});
      await target.pressSequentially(text, {delay: 15});
    }, {text}),
    select: (ref, option) => act('select', ref, (target) => target.selectOption({label: option}), {option}),
    press: async (key) => {
      const refusal = await serial(() => pressGuard(key));
      if (refusal) {
        const entry = {id: actions.length + 1, kind: 'press', key, refused: refusal};
        actions.push(entry);
        return {entry, refused: refusal, state: current};
      }
      return act('press', undefined, () => page.keyboard.press(key), {key});
    },
    scroll: (direction) => act('scroll', undefined,
      () => page.mouse.wheel(0, direction === 'up' ? -600 : 600), {direction}),
    back: () => act('back', undefined, () => page.goBack({waitUntil: 'domcontentloaded'})),
    goto: (path) => {
      const url = new URL(path, startUrl).href;
      const refusal = guard.checkUrl(url);
      if (refusal) return Promise.resolve({refused: refusal, state: current});
      return act('goto', undefined, () => page.goto(url, {waitUntil: 'domcontentloaded'}), {url});
    },

    /** Record a feature from logged action ids, filling in replayable locators. */
    recordFeature({name, summary, actionIds, result, visualScore, heroRefs = [], notes}) {
      const steps = [];
      for (const id of actionIds) {
        const entry = actions.find((a) => a.id === id);
        if (!entry) throw new Error(`No action #${id}. Use the ids returned by previous actions.`);
        if (entry.refused || entry.error) throw new Error(`Action #${id} did not succeed, so it cannot be a step.`);
        steps.push({
          action: entry.kind,
          locator: entry.element ? {role: entry.element.role, name: entry.element.name, nth: entry.element.nth} : undefined,
          text: entry.text, option: entry.option, key: entry.key, url: entry.url, direction: entry.direction,
          urlBefore: entry.urlBefore, changes: entry.changes, shotAfter: entry.shotAfter,
        });
      }
      const hero = heroRefs.map((ref) => current?.elements.find((el) => el.ref === ref)).filter(Boolean)
        .map((el) => ({...locatorFor(el), box: el.box, colors: el.colors}));
      const feature = {name, summary, startUrl: steps[0]?.urlBefore, steps, result, visualScore, hero, notes,
        shot: current?.shot};
      map.features.push(feature);
      return feature;
    },
    recordClutter({ref, reason}) {
      const element = current?.elements.find((el) => el.ref === ref);
      if (!element) throw new Error('Unknown ref; observe again.');
      const item = {...locatorFor(element), reason, url: current.url};
      map.clutter.push(item);
      return item;
    },
    recordPage({purpose}) {
      const key = Object.keys(map.pages).find((k) => map.pages[k].url === current?.url)
        ?? Object.keys(map.pages).at(-1);
      if (key) map.pages[key].purpose = purpose;
      return key;
    },

    async save(extra = {}) {
      Object.assign(map, extra);
      await writeFile(join(directory, 'product-map.json'), JSON.stringify(map, null, 2));
      return join(directory, 'product-map.json');
    },
    async close() {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}
