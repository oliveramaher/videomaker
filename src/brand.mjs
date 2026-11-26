// Guess a brand palette from a site's root CSS variables: either saved in a capture's
// snapshots (frame-state.json) or read live from the page. Name-based, with safe defaults.
import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';

const DEFAULTS = {primary: '#526eea', accent: '#ff9f5a', ink: '#161922', background: '#f6f7fa', surface: '#ffffff'};
const ROLES = [
  ['primary', /(^|-)(brand|primary|main)(-color)?$/],
  ['accent', /(^|-)(accent|secondary|highlight)(-color)?$/],
  ['ink', /(^|-)(ink|text|foreground|fg)(-color)?$/],
  ['background', /(^|-)(bg|background|canvas)(-color)?$/],
  ['surface', /(^|-)(card|surface|panel)(-color)?$/],
];
const isColor = (value) => /^\s*(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|oklab\()/i.test(value);

/** Map CSS custom properties ({'--brand': '#6d4aff', ...}) to palette roles. */
export function brandFromVariables(variables) {
  const colors = Object.fromEntries(Object.entries(variables)
    .map(([name, value]) => [name, String(value).trim()]).filter(([, value]) => isColor(value)));
  const brand = {...DEFAULTS, source: {}};
  for (const [role, pattern] of ROLES) {
    // Prefer an exact role name (--ink) over a compound one (--brand-ink).
    const names = Object.keys(colors).filter((name) => pattern.test(name.replace(/^--/, '')))
      .sort((a, b) => a.split('-').length - b.split('-').length);
    const match = names[0];
    if (match) {
      brand[role] = colors[match];
      brand.source[role] = match;
    }
  }
  // A dark companion of the primary (e.g. --brand-ink) makes a good deep shadow tint.
  const deep = Object.keys(colors).find((name) => /(brand|primary).*(ink|dark|deep|900)/.test(name));
  brand.deep = deep ? colors[deep] : brand.ink;
  if (deep) brand.source.deep = deep;
  return brand;
}

export async function extractBrand(captureDir) {
  const variables = {};
  const folders = (await readdir(join(captureDir, 'snapshots')).catch(() => [])).sort();
  for (const folder of folders) {
    const raw = await readFile(join(captureDir, 'snapshots', folder, 'frame-state.json'), 'utf8').catch(() => null);
    if (!raw) continue;
    const frames = JSON.parse(raw);
    const main = (Array.isArray(frames) ? frames : [frames]).find((frame) => frame.parent === -1) ?? frames[0];
    Object.assign(variables, main?.state?.rootCustomProperties ?? {});
  }
  return brandFromVariables(variables);
}

/** Read the palette from the live site (before anything is filmed). */
export async function probeBrand({url, storageState}) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({storageState});
    const page = await context.newPage();
    await page.goto(url, {waitUntil: 'domcontentloaded'});
    const variables = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return Object.fromEntries(Array.from(style).filter((name) => name.startsWith('--'))
        .map((name) => [name, style.getPropertyValue(name)]));
    });
    return brandFromVariables(variables);
  } finally {
    await browser.close();
  }
}
