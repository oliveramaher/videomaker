// Turn the live page into something a model can act on: a screenshot with numbered
// boxes over each interactive element, plus a text list of the same elements with
// their accessible role and name. The role and name become replayable locators.

/** Runs in the page. Tags visible interactive elements with data-vm-ref and describes them. */
function collectElements(maxElements) {
  const implicitRoles = {
    A: (el) => el.hasAttribute('href') ? 'link' : null,
    BUTTON: () => 'button',
    SELECT: () => 'combobox',
    TEXTAREA: () => 'textbox',
    SUMMARY: () => 'button',
    INPUT: (el) => ({
      button: 'button', submit: 'button', reset: 'button', image: 'button',
      checkbox: 'checkbox', radio: 'radio', range: 'slider', search: 'searchbox',
      hidden: null, file: 'button',
    })[el.type] ?? 'textbox',
  };
  const interactiveRoles = new Set(['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'checkbox', 'radio', 'switch', 'combobox', 'textbox', 'searchbox', 'option', 'slider', 'treeitem']);
  const clean = (text) => (text ?? '').replace(/\s+/g, ' ').trim();

  const accessibleName = (el) => {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.innerText ?? '').join(' ');
      if (clean(text)) return clean(text);
    }
    if (clean(el.getAttribute('aria-label'))) return clean(el.getAttribute('aria-label'));
    if (el.labels?.length) return clean(Array.from(el.labels, (label) => label.innerText).join(' '));
    if (el.matches('input[type=submit], input[type=button], input[type=reset]')) return clean(el.value);
    if (el.matches('input, textarea, select')) return clean(el.getAttribute('placeholder') || el.getAttribute('title'));
    const alt = el.querySelector?.('img[alt]')?.getAttribute('alt');
    return clean(el.innerText || alt || el.getAttribute('title')).slice(0, 80);
  };

  const all = [];
  const roots = [document];
  for (const root of roots) {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) roots.push(el.shadowRoot);
      all.push(el);
    }
  }
  for (const el of all) el.removeAttribute('data-vm-ref');

  const elements = [];
  const seenNames = new Map();
  for (const el of all) {
    const explicit = el.getAttribute('role');
    const role = explicit || implicitRoles[el.tagName]?.(el) || (el.isContentEditable ? 'textbox' : null);
    const clickable = !role && (el.hasAttribute('onclick') || el.getAttribute('tabindex') === '0');
    if (!(role && interactiveRoles.has(role)) && !clickable) continue;
    if (el.closest('[aria-hidden="true"], [inert]')) continue;
    if (!el.checkVisibility({opacityProperty: true, visibilityProperty: true})) continue;
    const box = el.getBoundingClientRect();
    if (box.width < 4 || box.height < 4 || box.bottom < 0 || box.right < 0
      || box.top > innerHeight || box.left > innerWidth) continue;
    // Find a point where the element is actually on top: center first, then inset corners.
    // Skip it if covered everywhere (e.g. behind a modal); remember the point for clicking.
    const probes = [[0.5, 0.5], [0.2, 0.25], [0.8, 0.25], [0.2, 0.75], [0.8, 0.75]];
    let hitPoint = null;
    for (const [fx, fy] of probes) {
      const x = Math.min(Math.max(box.left + box.width * fx, 0), innerWidth - 1);
      const y = Math.min(Math.max(box.top + box.height * fy, 0), innerHeight - 1);
      const top = el.getRootNode().elementFromPoint(x, y);
      if (!top || top === el || el.contains(top) || top.contains(el)) {
        hitPoint = {x: Math.round(x - box.left), y: Math.round(y - box.top), partial: fx !== 0.5};
        break;
      }
    }
    if (!hitPoint) continue;

    const name = accessibleName(el);
    const finalRole = role ?? 'generic';
    const key = `${finalRole}\u0000${name}`;
    const nth = seenNames.get(key) ?? 0;
    seenNames.set(key, nth + 1);
    const ref = elements.length + 1;
    el.setAttribute('data-vm-ref', String(ref));
    const style = getComputedStyle(el);
    elements.push({
      ref,
      role: finalRole,
      name,
      nth,
      tag: el.localName,
      type: el.getAttribute('type') || undefined,
      value: el.matches('input:not([type=password]), textarea, select') ? clean(el.value).slice(0, 60) : undefined,
      checked: el.matches('input[type=checkbox], input[type=radio]') ? el.checked : undefined,
      disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' || undefined,
      inDialog: !!el.closest('dialog[open], [role=dialog], [aria-modal=true]') || undefined,
      partlyCovered: hitPoint.partial || undefined,
      clickPoint: {x: hitPoint.x, y: hitPoint.y},
      box: {x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height)},
      colors: {background: style.backgroundColor, color: style.color},
    });
    if (elements.length >= maxElements) break;
  }

  const dialogs = Array.from(document.querySelectorAll(
    'dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true], [role=tooltip], [popover]:popover-open'))
    .filter((el) => el.checkVisibility())
    .map((el) => ({
      role: el.getAttribute('role') || el.localName,
      name: clean(el.getAttribute('aria-label')) || clean(el.innerText).slice(0, 80),
    }));
  const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
    .filter((el) => el.checkVisibility()).map((el) => clean(el.innerText)).filter(Boolean).slice(0, 12);
  return {url: location.href, title: document.title, headings, dialogs, elements,
    scroll: {y: Math.round(scrollY), max: Math.round(document.documentElement.scrollHeight - innerHeight)}};
}

function drawMarks(elements) {
  const layer = document.createElement('div');
  layer.id = '__vm_marks';
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  for (const {ref, box} of elements) {
    const mark = document.createElement('div');
    mark.style.cssText = `position:absolute;left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px;`
      + 'outline:2px solid #ff2d8a;outline-offset:1px;border-radius:4px';
    const tag = document.createElement('span');
    tag.textContent = ref;
    tag.style.cssText = 'position:absolute;left:-2px;top:-16px;background:#ff2d8a;color:#fff;'
      + 'font:bold 11px/14px monospace;padding:0 3px;border-radius:3px';
    mark.append(tag);
    layer.append(mark);
  }
  document.documentElement.append(layer);
}

const removeMarks = () => document.getElementById('__vm_marks')?.remove();

/** Observe the page. Returns structured state plus a marked JPEG and a clean JPEG. */
export async function observe(page, {maxElements = 80} = {}) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(150);
  const state = await page.evaluate(collectElements, maxElements);
  const clean = await page.screenshot({type: 'jpeg', quality: 80});
  await page.evaluate(drawMarks, state.elements);
  const marked = await page.screenshot({type: 'jpeg', quality: 70});
  await page.evaluate(removeMarks);
  return {...state, screenshots: {clean, marked}};
}

/** A compact text form of the observation for the model. */
export function describe(state) {
  const lines = [`URL: ${state.url}`, `Title: ${state.title}`];
  if (state.headings.length) lines.push(`Headings: ${state.headings.join(' | ')}`);
  if (state.dialogs.length) {
    lines.push(`Open overlays: ${state.dialogs.map((d) => `${d.role} "${d.name}"`).join('; ')}`);
  }
  if (state.scroll.max > 0) lines.push(`Scroll: ${state.scroll.y}/${state.scroll.max}px`);
  lines.push('Interactive elements (ref, role, name):');
  for (const el of state.elements) {
    const extras = [
      el.value ? `value="${el.value}"` : '',
      el.checked !== undefined ? (el.checked ? 'checked' : 'unchecked') : '',
      el.disabled ? 'disabled' : '',
      el.inDialog ? 'in-dialog' : '',
      el.partlyCovered ? 'partly covered' : '',
    ].filter(Boolean).join(', ');
    lines.push(`[${el.ref}] ${el.role} "${el.name}"${el.nth ? ` (#${el.nth + 1})` : ''}${extras ? ` (${extras})` : ''}`);
  }
  return lines.join('\n');
}

/** What changed between two observations, phrased for the model and the product map. */
export function diff(before, after) {
  const changes = [];
  if (before.url !== after.url) changes.push(`navigated to ${after.url}`);
  const key = (d) => `${d.role}:${d.name}`;
  const was = new Set(before.dialogs.map(key));
  const now = new Set(after.dialogs.map(key));
  for (const d of after.dialogs) if (!was.has(key(d))) changes.push(`opened ${d.role} "${d.name}"`);
  for (const d of before.dialogs) if (!now.has(key(d))) changes.push(`closed ${d.role} "${d.name}"`);
  const oldHeadings = new Set(before.headings);
  const newHeadings = after.headings.filter((text) => !oldHeadings.has(text));
  if (newHeadings.length) changes.push(`new headings: ${newHeadings.join(' | ')}`);
  const names = (s) => new Set(s.elements.map((el) => `${el.role}:${el.name}`));
  const oldNames = names(before);
  const appeared = after.elements.filter((el) => !oldNames.has(`${el.role}:${el.name}`));
  if (appeared.length) {
    changes.push(`${appeared.length} new controls: ${appeared.slice(0, 8).map((el) => `${el.role} "${el.name}"`).join(', ')}`);
  }
  return changes.length ? changes : ['no visible structural change (may be a style/hover change only)'];
}
