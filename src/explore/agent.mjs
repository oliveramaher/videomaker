// The explorer agent: Claude drives an ExplorerSession through tools until it has
// mapped the product's filmable features, then the map is saved for storyboarding.
import Anthropic from '@anthropic-ai/sdk';
import {betaZodTool} from '@anthropic-ai/sdk/helpers/beta/zod';
import {z} from 'zod';
import {openSession} from './session.mjs';

const SYSTEM = `You are exploring a web app so that a video team can later make a short, polished ad for it.
Nobody on the team knows this product. Your job is to find out what it does and which moments would look great on screen.

You control a real, logged-in browser through tools. Every observation gives you a list of interactive elements with ref numbers; act on elements by ref. Refs change after every action, so always use refs from the latest observation. A screenshot with matching numbered pink boxes comes along when the page changes noticeably (new page, dialog, lots of new content); otherwise you get a text summary of what changed. Add look: true to an action, or call observe, whenever you need to see the screen, e.g. to judge how good something looks.

What to produce, using the record_* tools as you go:
- record_page for each distinct screen: what it is for, in one sentence.
- record_feature for each user-facing capability you actually exercised: the action ids that perform it from a sensible starting screen, what the user gets, and a 1-5 visual score for how good it would look in an ad (5 = something visibly transforms or appears; 1 = a static form).
- record_clutter for anything that would spoil a clean shot: cookie banners, onboarding tips, upsell nags, chat widgets.

How to explore:
- Start broad (navigation, main screens), then go deep on the core workflow. Prefer the product's signature actions over settings pages.
- Create realistic demo content when a feature needs input, e.g. a project called "Q3 launch plan", never lorem ipsum.
- Hover over important controls when a hover state might matter for filming.
- Some actions are refused by a safety guard (deleting, paying, inviting, sending, logging out). That is expected: note what the button probably does in a feature's notes if relevant, and move on. Never try to work around a refusal.
- If an action did nothing useful, do not record it as a step.
- You have a limited action budget. When it runs low, record what you have and call finish.

Finish by calling finish with a summary of the product, who it seems to be for, and the 3-5 strongest ad moments.`;

function observationContent(session, state, header, {image = true} = {}) {
  const parts = [];
  if (header) parts.push(header);
  parts.push(session.describe(state));
  const content = [{type: 'text', text: parts.join('\n\n')}];
  if (image && state.screenshots?.marked) {
    content.push({type: 'image', source: {type: 'base64', media_type: 'image/jpeg', data: state.screenshots.marked.toString('base64')}});
  }
  return content;
}

/**
 * Whether a screenshot is worth its tokens after an action. The text diff and element list
 * always go along; the image only when the screen probably changed in a way words miss.
 */
export function needsScreenshot(entry, {asked = false, sinceLast = 0, maxGap = 5} = {}) {
  if (asked) return true;
  if (!entry || entry.refused) return false;
  if (entry.error) return true;
  if (entry.urlBefore !== entry.urlAfter) return true;
  if (sinceLast >= maxGap) return true;
  return (entry.changes ?? []).some((change) => /^(opened|closed|new headings)/.test(change)
    || Number(/^(\d+) new controls/.exec(change)?.[1] ?? 0) >= 5
    || Number(/^new text \((\d+) chars\)/.exec(change)?.[1] ?? 0) >= 80);
}

/** One compact line per crawled page. */
export function describeSitemap(pages) {
  const list = (label, items) => items.length ? ` ${label}: ${items.join(', ')}.` : '';
  return pages.map((p) => `- ${new URL(p.url).pathname}${new URL(p.url).hash} "${p.headings[0] ?? p.title}".`
    + list('Buttons', p.buttons) + list('Links', p.links) + list('Fields', p.fields)).join('\n');
}

function makeTools(session, budget, {maxGap = 5} = {}) {
  let used = 0;
  let finished = null;
  let sinceImage = 0;
  const stats = {actions: 0, images: 0};

  const actionResult = (result, {asked = false} = {}) => {
    used += 1;
    const remaining = budget - used;
    const {entry, refused, state} = result;
    const lines = [];
    if (refused) lines.push(`REFUSED: ${refused}`);
    else if (entry) {
      lines.push(`Action #${entry.id} (${entry.kind}) done.`);
      if (entry.error) lines.push(`Error: ${entry.error}`);
      if (entry.changes?.length) lines.push(`Changes: ${entry.changes.join('; ')}`);
      if (entry.events?.length) lines.push(`Events: ${entry.events.join('; ')}`);
    }
    const image = needsScreenshot(refused ? {refused} : entry, {asked, sinceLast: sinceImage, maxGap});
    stats.actions += 1;
    if (image) { stats.images += 1; sinceImage = 0; } else sinceImage += 1;
    if (!image) lines.push('(No screenshot: little changed visually. Add look: true to an action, or call observe, to see the page.)');
    lines.push(remaining > 0 ? `Actions left: ${remaining}.` : 'Action budget used up: record remaining features, then call finish.');
    return observationContent(session, state, lines.join('\n'), {image});
  };
  const overBudget = () => used >= budget
    ? 'Action budget used up. Do not take more browser actions; record features and call finish.'
    : null;

  const ref = z.number().int().positive().describe('Element ref number from the latest observation');
  const why = z.string().max(200).describe('One short sentence: what you expect this to do');
  const look = z.boolean().optional().describe('Also send a screenshot after this action (otherwise only when the page changes a lot)');

  const tools = [
    betaZodTool({
      name: 'observe',
      description: 'Take a fresh screenshot and element list without acting. Does not use the action budget.',
      inputSchema: z.object({}),
      run: async () => observationContent(session, await session.observe()),
    }),
    betaZodTool({
      name: 'click',
      description: 'Click an element. Returns what changed and a new observation.',
      inputSchema: z.object({ref, why, look}),
      run: async ({ref: r, look: asked}) => overBudget() ?? actionResult(await session.click(r), {asked}),
    }),
    betaZodTool({
      name: 'hover',
      description: 'Move the mouse over an element to reveal hover states, tooltips or menus.',
      inputSchema: z.object({ref, why, look}),
      run: async ({ref: r, look: asked}) => overBudget() ?? actionResult(await session.hover(r), {asked}),
    }),
    betaZodTool({
      name: 'type',
      description: 'Replace the contents of a text field with the given text. Does not press Enter.',
      inputSchema: z.object({ref, text: z.string().max(400), why, look}),
      run: async ({ref: r, text, look: asked}) => overBudget() ?? actionResult(await session.type(r, text), {asked}),
    }),
    betaZodTool({
      name: 'select_option',
      description: 'Choose an option by its visible label in a native <select> (role combobox).',
      inputSchema: z.object({ref, option: z.string(), why, look}),
      run: async ({ref: r, option, look: asked}) => overBudget() ?? actionResult(await session.select(r, option), {asked}),
    }),
    betaZodTool({
      name: 'press_key',
      description: 'Press one key: Enter, Escape, Tab, ArrowDown, ArrowUp, ArrowLeft, ArrowRight or Space.',
      inputSchema: z.object({key: z.enum(['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Space']), why, look}),
      run: async ({key, look: asked}) => overBudget() ?? actionResult(await session.press(key), {asked}),
    }),
    betaZodTool({
      name: 'scroll',
      description: 'Scroll the page up or down by about one screen.',
      inputSchema: z.object({direction: z.enum(['up', 'down']), look}),
      run: async ({direction, look: asked}) => overBudget() ?? actionResult(await session.scroll(direction), {asked: asked ?? true}),
    }),
    betaZodTool({
      name: 'go_back',
      description: 'Browser back button.',
      inputSchema: z.object({}),
      run: async () => overBudget() ?? actionResult(await session.back()),
    }),
    betaZodTool({
      name: 'goto',
      description: 'Open a path or URL inside the same app, e.g. "/settings". Other sites are refused.',
      inputSchema: z.object({path: z.string()}),
      run: async ({path}) => overBudget() ?? actionResult(await session.goto(path)),
    }),
    betaZodTool({
      name: 'record_page',
      description: 'Describe the purpose of the screen currently shown.',
      inputSchema: z.object({purpose: z.string().max(300)}),
      run: async ({purpose}) => `Recorded page ${session.recordPage({purpose}) ?? '(none)'}.`,
    }),
    betaZodTool({
      name: 'record_feature',
      description: 'Save a feature you exercised, built from the ids of successful actions in order.',
      inputSchema: z.object({
        name: z.string().max(80).describe('Short feature name, e.g. "Create a project from a template"'),
        summary: z.string().max(400).describe('What it does for the user, in plain words'),
        action_ids: z.array(z.number().int().positive()).min(1).describe('Ids of the actions that perform it, in order'),
        result: z.string().max(300).describe('What is visibly on screen afterwards'),
        visual_score: z.number().int().min(1).max(5),
        hero_refs: z.array(z.number().int().positive()).max(5).optional()
          .describe('Refs (latest observation) of elements a camera should focus on'),
        notes: z.string().max(400).optional(),
      }),
      run: async (input) => {
        try {
          const feature = session.recordFeature({
            name: input.name, summary: input.summary, actionIds: input.action_ids, result: input.result,
            visualScore: input.visual_score, heroRefs: input.hero_refs, notes: input.notes,
          });
          await session.save();
          return `Recorded feature "${feature.name}" with ${feature.steps.length} steps.`;
        } catch (error) {
          return `Not recorded: ${error.message}`;
        }
      },
    }),
    betaZodTool({
      name: 'record_clutter',
      description: 'Mark an element that should be hidden when filming (banners, tips, nags).',
      inputSchema: z.object({ref, reason: z.string().max(200)}),
      run: async (input) => {
        try {
          const item = session.recordClutter(input);
          return `Recorded clutter ${item.role} "${item.name}".`;
        } catch (error) {
          return `Not recorded: ${error.message}`;
        }
      },
    }),
    betaZodTool({
      name: 'finish',
      description: 'End exploration with a summary. Call once, last.',
      inputSchema: z.object({
        product_summary: z.string().max(800),
        audience: z.string().max(300),
        top_ad_moments: z.array(z.string().max(200)).min(1).max(6),
      }),
      run: async (input) => {
        finished = input;
        return 'Exploration finished. Stop calling tools.';
      },
    }),
  ];
  return {tools, stats, get used() { return used; }, get finished() { return finished; }};
}

/**
 * Explore an app and write product-map.json, actions.jsonl and screenshots to `output`.
 * Model calls are billed: `maxActions` bounds browser actions and `maxTurns` bounds requests.
 */
export async function explore({
  startUrl,
  output,
  storageState,
  brief = '',
  maxActions = 40,
  maxTurns,
  model = 'claude-opus-5-5',
  effort = 'medium',
  fallbacks = true,
  headless = true,
  allowNames = [],
  crawl = true,
  maxCrawlPages = 12,
  onProgress = () => {},
  client = new Anthropic(),
}) {
  const session = await openSession({startUrl, output, storageState, headless, allowNames});
  const usage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0};
  try {
    await session.start();
    // Free pre-crawl: the model starts with a site map instead of spending actions on navigation.
    const sitemap = crawl ? await session.crawl({maxPages: maxCrawlPages}) : [];
    const first = await session.observe();
    const kit = makeTools(session, maxActions);
    const intro = [
      `Explore the app at ${startUrl}. You have ${maxActions} browser actions.`,
      brief ? `Focus from the video team: ${brief}` : '',
      sitemap.length ? `Site map from a quick crawl of the app's links (no clicks were made; buttons were not pressed):\n${describeSitemap(sitemap)}` : '',
      'Here is the first screen:',
    ].filter(Boolean).join('\n\n');

    const runner = client.beta.messages.toolRunner({
      model,
      max_tokens: 16000,
      max_iterations: maxTurns ?? maxActions + 25,
      system: [{type: 'text', text: SYSTEM, cache_control: {type: 'ephemeral'}}],
      output_config: {effort},
      betas: ['context-management-2025-06-27', ...(fallbacks ? ['server-side-fallback-2026-07-01'] : [])],
      ...(fallbacks ? {fallbacks: 'default'} : {}),
      // Old screenshots are the bulk of the context; keep only the latest few tool results.
      context_management: {
        edits: [{
          type: 'clear_tool_uses_20250919',
          trigger: {type: 'input_tokens', value: 60000},
          keep: {type: 'tool_uses', value: 4},
          clear_at_least: {type: 'input_tokens', value: 15000},
          exclude_tools: ['record_page', 'record_feature', 'record_clutter', 'finish'],
        }],
      },
      cache_control: {type: 'ephemeral'},
      tools: kit.tools,
      messages: [{role: 'user', content: observationContent(session, first, intro)}],
    });

    let last;
    for await (const message of runner) {
      last = message;
      usage.requests += 1;
      usage.input += message.usage?.input_tokens ?? 0;
      usage.output += message.usage?.output_tokens ?? 0;
      usage.cacheRead += message.usage?.cache_read_input_tokens ?? 0;
      usage.cacheWrite += message.usage?.cache_creation_input_tokens ?? 0;
      for (const block of message.content) {
        if (block.type === 'text' && block.text.trim()) onProgress({type: 'text', text: block.text.trim()});
        if (block.type === 'tool_use') onProgress({type: 'tool', name: block.name, input: block.input});
      }
      if (message.stop_reason === 'refusal') {
        onProgress({type: 'text', text: `Model declined (${message.stop_details?.category ?? 'unknown'}).`});
        break;
      }
    }

    const finished = kit.finished;
    const path = await session.save({
      summary: finished ?? {product_summary: null, note: 'Exploration ended before finish was called.'},
      run: {model, effort, actionsUsed: kit.used, maxActions, screenshotsAfterActions: kit.stats.images, crawledPages: sitemap.length,
        stopReason: last?.stop_reason, usage},
    });
    return {path, map: session.map, usage, finished: !!finished, stats: {...kit.stats, crawledPages: sitemap.length}};
  } finally {
    await session.close();
  }
}
