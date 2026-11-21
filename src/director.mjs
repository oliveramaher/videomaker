import {setTimeout as wait} from 'node:timers/promises';

const clamp = (number, min, max) => Math.min(Math.max(number, min), max);
const mix = (a, b, t) => a + (b - a) * t;

async function targetPoint(target, position = {x: 0.5, y: 0.5}) {
  if (typeof target.boundingBox !== 'function') return target;
  const box = await target.boundingBox();
  if (!box) throw new Error('The target has no visible bounding box.');
  return {x: box.x + box.width * position.x, y: box.y + box.height * position.y};
}

function readCaret(element) {
  const selection = element.ownerDocument.getSelection();
  if (!selection?.rangeCount || !element.contains(selection.focusNode)) return null;
  const range = selection.getRangeAt(0).cloneRange();
  range.collapse(false);
  const rect = range.getBoundingClientRect();
  return rect.height ? {x: rect.left, y: rect.top + rect.height / 2} : null;
}

function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function installHiddenElements(selector) {
  const sheet = new CSSStyleSheet();
  sheet.insertRule(`${selector} { display: none !important; }`);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

function readVisualState(element) {
  const style = getComputedStyle(element);
  return {
    visible: element.checkVisibility({opacityProperty: true, visibilityProperty: true}),
    appearance: {
      opacity: style.opacity,
      color: style.color,
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      boxShadow: style.boxShadow,
      transform: style.transform,
      cursor: style.cursor,
    },
  };
}

async function visualState(locator) {
  if (!await locator.isVisible()) return null;
  const box = await locator.boundingBox({timeout: 250}).catch((error) => {
    if (error.name !== 'TimeoutError') throw error;
    return null;
  });
  if (!box) return null;
  const state = await locator.evaluate(readVisualState, undefined, {timeout: 250}).catch((error) => {
    if (error.name !== 'TimeoutError') throw error;
    return null;
  });
  if (!state?.visible || !box.width || !box.height) return null;
  return {box, appearance: state.appearance};
}

/** Direct browser input and record editable cues in the same clock as capture. */
export function createDirector(page, viewport, emit) {
  let pointer = {x: viewport.width * 0.85, y: viewport.height * 0.78};
  let takeStart;
  let parked = false;
  const waitUntil = async (startAtMs) => {
    if (startAtMs === undefined) return;
    if (!Number.isFinite(startAtMs) || startAtMs < 0) {
      throw new RangeError('startAtMs must be a nonnegative number.');
    }
    if (takeStart === undefined) throw new Error('Call director.start() before scheduling an action.');
    const remaining = takeStart + startAtMs - performance.now();
    if (remaining > 0) await wait(Math.ceil(remaining));
  };
  const record = (kind, data = {}) => emit({kind, atMs: Date.now(), ...data});
  const boundedPoint = ({x, y}) => ({
    x: clamp(x, 0, viewport.width - 1),
    y: clamp(y, 0, viewport.height - 1),
  });

  const position = (point) => {
    pointer = boundedPoint(point);
    record('pointer', {...pointer, action: 'move'});
  };

  const park = async () => {
    if (parked) return;
    await page.mouse.move(-1, -1);
    parked = true;
    record('browser-hover', {target: null});
  };

  const land = async () => {
    await page.mouse.move(pointer.x, pointer.y);
    parked = false;
    const target = await page.evaluate(({x, y}) => {
      const element = document.elementFromPoint(x, y);
      return element ? {tag: element.localName, id: element.id || null,
        label: element.getAttribute('aria-label') || element.getAttribute('title')} : null;
    }, pointer);
    record('browser-hover', {target, ...pointer});
  };

  const move = async (target, {from, startAtMs, speedPxPerSecond, durationMs, bend = 0.25, position: fraction} = {}) => {
    await waitUntil(startAtMs);
    await park();
    const end = boundedPoint(await targetPoint(target, fraction));
    if (from) position(from);
    const start = pointer;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (speedPxPerSecond !== undefined && (!Number.isFinite(speedPxPerSecond) || speedPxPerSecond <= 0)) {
      throw new RangeError('speedPxPerSecond must be positive.');
    }
    const duration = durationMs ?? (speedPxPerSecond === undefined
      ? 760 : 1000 * Math.hypot(dx, dy) / speedPxPerSecond);
    if (!Number.isFinite(duration) || duration < 0) throw new RangeError('durationMs must be nonnegative.');
    const steps = Math.max(1, Math.ceil(duration / 14));
    const started = performance.now();
    for (let step = 1; step <= steps; step++) {
      const progress = step / steps;
      const t = progress * progress * (3 - 2 * progress);
      // Cubic Bézier control points offset perpendicular to the travel vector.
      const a = 3 * (1 - t) ** 2 * t;
      const b = 3 * (1 - t) * t ** 2;
      const curve = {
        x: start.x + a * (dx * 0.23 - dy * bend) + b * (dx * 0.77 - dy * bend * 0.6) + t ** 3 * dx,
        y: start.y + a * (dy * 0.23 + dx * bend) + b * (dy * 0.77 + dx * bend * 0.6) + t ** 3 * dy,
      };
      const remaining = started + progress * duration - performance.now();
      if (remaining > 0) await wait(remaining);
      position(curve);
    }
  };

  const focus = async (target, {zoom = 1.7, durationMs = 700, position: fraction,
    anchor = {x: 0.5, y: 0.5}} = {}) => {
    const point = await targetPoint(target, fraction);
    record('camera', {point, anchor, zoom, durationMs});
  };

  const findPopupCandidates = () => {
    return page.evaluate(() => {
      const signals = [
        ['dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]', 'dialog'],
        ['[popover]:popover-open', 'open popover'],
        ['[role="tooltip"]', 'tooltip'],
        ['[variant="overlay"]', 'overlay variant'],
      ];
      const matches = new Map();
      for (const [selector, reason] of signals) {
        for (const element of document.querySelectorAll(selector)) {
          const reasons = matches.get(element) ?? [];
          reasons.push(reason);
          matches.set(element, reasons);
        }
      }
      return Array.from(matches).flatMap(([element, reasons]) => {
        const box = element.getBoundingClientRect();
        if (!element.checkVisibility({opacityProperty: true, visibilityProperty: true})
          || !box.width || !box.height || box.right <= 0 || box.bottom <= 0
          || box.left >= innerWidth || box.top >= innerHeight) return [];
        return [{
          tag: element.localName,
          id: element.id || null,
          reasons,
          text: (element.innerText ?? '').trim().replace(/\s+/g, ' ').slice(0, 180),
          bounds: {x: box.x, y: box.y, width: box.width, height: box.height},
        }];
      });
    });
  };

  return {
    wait,
    findPopupCandidates,
    async hideElement(selector) {
      if (typeof selector !== 'string' || !selector.trim()) {
        throw new TypeError('hideElement requires a CSS selector.');
      }
      await page.evaluate(installHiddenElements, selector);
      await page.addInitScript(installHiddenElements, selector);
      record('hide-element', {selector});
    },
    async waitForReady(locators, {stableMs = 400, timeoutMs = 10000} = {}) {
      const deadline = performance.now() + timeoutMs;
      let previous;
      let stableSince;
      while (performance.now() < deadline) {
        const states = await Promise.all(locators.map(visualState));
        const current = states.every(Boolean) ? JSON.stringify(states) : null;
        const now = performance.now();
        if (!current || current !== previous) stableSince = now;
        if (current && now - stableSince >= stableMs) return;
        previous = current;
        await wait(50);
      }
      throw new Error('Shot readiness timed out before the requested elements became stable.');
    },
    async start(point = pointer) {
      await park();
      position(point);
      takeStart = performance.now();
      record('start');
    },
    end() { record('end'); },
    mark(label) { record('marker', {label}); },
    cursor: {
      move,
      async hover(locator, {holdMs = 500, ...options} = {}) {
        await locator.scrollIntoViewIfNeeded();
        await park();
        const before = await locator.evaluate(readVisualState);
        const beforePopups = await findPopupCandidates();
        await move(locator, options);
        await land();
        await wait(holdMs);
        const after = await locator.evaluate(readVisualState);
        const popupKey = ({tag, id, text}) => JSON.stringify([tag, id, text]);
        const previous = new Set(beforePopups.map(popupKey));
        const revealedPopups = (await findPopupCandidates()).filter((popup) => !previous.has(popupKey(popup)));
        const effect = {before, after, revealedPopups};
        record('hover-effect', effect);
        return effect;
      },
      async click(locator, options = {}) {
        await park();
        await locator.scrollIntoViewIfNeeded();
        if (!await locator.isEnabled()) throw new Error('The click target is disabled.');
        await move(locator, options);
        const livePoint = await targetPoint(locator, options.position);
        if (Math.hypot(livePoint.x - pointer.x, livePoint.y - pointer.y) > 2) {
          await move(livePoint, {durationMs: 140, bend: 0.08});
        }

        // Check the actual directed point without dispatching a trial click.
        const hit = await locator.evaluate((element, offset) => {
          const rect = element.getBoundingClientRect();
          const x = rect.left + rect.width * offset.x;
          const y = rect.top + rect.height * offset.y;
          const target = element.getRootNode().elementFromPoint(x, y);
          return !!target && element.contains(target);
        }, options.position ?? {x: 0.5, y: 0.5});
        if (!hit) throw new Error('The click target is covered at the directed point.');

        await land();
        await page.mouse.down();
        record('pointer', {...pointer, action: 'down'});
        await wait(65);
        await page.mouse.up();
        record('pointer', {...pointer, action: 'up'});
        await park();
      },
      async hide() {
        await park();
        record('pointer', {...pointer, action: 'hide'});
      },
    },
    camera: {
      focus,
      wide(durationMs = 700) {
        record('camera', {zoom: 1, durationMs});
      },
    },
    async type(text, {startAtMs, wordsPerMinute, seed = 42, delayMs = 55, jitterMs = 32, follow} = {}) {
      if (wordsPerMinute !== undefined && (!Number.isFinite(wordsPerMinute) || wordsPerMinute <= 0)) {
        throw new RangeError('wordsPerMinute must be positive.');
      }
      const random = randomGenerator(seed);
      const origin = follow ? await targetPoint(follow.target) : null;
      const segments = new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(text);
      await waitUntil(startAtMs);
      const interval = wordsPerMinute === undefined ? delayMs : 12000 / wordsPerMinute;
      let nextAt = performance.now();
      for (const [index, {segment}] of Array.from(segments).entries()) {
        if (startAtMs === undefined || index > 0) {
          const jitter = wordsPerMinute === undefined ? jitterMs : interval * 0.38;
          const pause = /[.!?,;:\s]/u.test(segment) ? interval * 0.45 : 0;
          nextAt += Math.max(0, interval + (random() * 2 - 1) * jitter + pause);
          const remaining = nextAt - performance.now();
          if (remaining > 0) await wait(Math.ceil(remaining));
        }
        await page.keyboard.type(segment);
        record('type', {index, segment});
        if (follow) {
          const caret = await follow.target.evaluate(readCaret);
          if (caret) {
            record('caret', caret);
            const amount = follow.amount ?? 0.65;
            await focus({
              x: mix(origin.x, caret.x, amount),
              y: mix(origin.y, caret.y, amount),
            }, {zoom: follow.zoom, anchor: follow.anchor, durationMs: 240});
          }
        }
      }
    },
  };
}
