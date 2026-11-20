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

/** Direct browser input and record editable cues in the same clock as capture. */
export function createDirector(page, viewport, emit) {
  let pointer = {x: viewport.width * 0.85, y: viewport.height * 0.78};
  const record = (kind, data = {}) => emit({kind, atMs: Date.now(), ...data});
  const boundedPoint = ({x, y}) => ({
    x: clamp(x, 0, viewport.width - 1),
    y: clamp(y, 0, viewport.height - 1),
  });

  const position = async (point) => {
    const next = boundedPoint(point);
    await page.mouse.move(next.x, next.y);
    pointer = next;
    record('pointer', {...pointer, action: 'move'});
  };

  const move = async (target, {durationMs = 760, bend = 0.25, position: fraction} = {}) => {
    const end = boundedPoint(await targetPoint(target, fraction));
    const start = pointer;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const steps = Math.max(1, Math.ceil(durationMs / 14));
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
      const remaining = started + progress * durationMs - performance.now();
      if (remaining > 0) await wait(remaining);
      await position(curve);
    }
  };

  const focus = async (target, {zoom = 1.7, durationMs = 700, position: fraction,
    anchor = {x: 0.5, y: 0.5}} = {}) => {
    const point = await targetPoint(target, fraction);
    record('camera', {point, anchor, zoom, durationMs});
  };

  return {
    wait,
    async start(point = pointer) {
      await position(point);
      record('start');
    },
    end() { record('end'); },
    mark(label) { record('marker', {label}); },
    cursor: {
      move,
      async click(locator, options = {}) {
        await locator.click({trial: true});
        await move(locator, options);
        // Re-read geometry in case a hover or animation moved the target.
        const livePoint = await targetPoint(locator, options.position);
        if (Math.hypot(livePoint.x - pointer.x, livePoint.y - pointer.y) > 2) {
          await move(livePoint, {durationMs: 140, bend: 0.08});
        }
        await page.mouse.down();
        record('pointer', {...pointer, action: 'down'});
        await wait(65);
        await page.mouse.up();
        record('pointer', {...pointer, action: 'up'});
      },
      hide() { record('pointer', {...pointer, action: 'hide'}); },
    },
    camera: {
      focus,
      wide(durationMs = 700) {
        record('camera', {zoom: 1, durationMs});
      },
    },
    async type(text, {seed = 42, delayMs = 55, jitterMs = 32, follow} = {}) {
      const random = randomGenerator(seed);
      const origin = follow ? await targetPoint(follow.target) : null;
      const segments = new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(text);
      for (const [index, {segment}] of Array.from(segments).entries()) {
        const delay = delayMs + (random() * 2 - 1) * jitterMs + (/\s/u.test(segment) ? 38 : 0);
        await wait(Math.max(0, delay));
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
