// Storyboard: Claude reads the explorer's product map, the brand and the effects catalog,
// then picks which features to film, in what order, and writes the on-screen copy.
// The result feeds the shoot-plan compiler and the Ad composition.
import {readFile} from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import {betaZodOutputFormat} from '@anthropic-ai/sdk/helpers/beta/zod';
import {z} from 'zod';

const ShotSchema = z.object({
  feature: z.string().describe('Exact feature name from the product map'),
  caption: z.string().describe('On-screen caption, at most 6 words; wrap one key word in *asterisks*'),
  emphasis: z.enum(['signature', 'supporting']).describe('Exactly one shot is the signature moment'),
  lift: z.boolean().describe('Lift the payoff out of the screen toward the viewer (signature shot, sometimes one more)'),
  why: z.string().describe('One sentence: why this shot earns its place'),
});

export const StoryboardSchema = z.object({
  appName: z.string().describe('Product name as shown in its UI'),
  headline: z.string().describe('Hook shown with the logo in the first 2 seconds, at most 7 words, one *emphasis*'),
  shots: z.array(ShotSchema).describe('2 to 4 shots in story order'),
  tagline: z.string().describe('End card line, at most 6 words, one *emphasis*'),
  cta: z.string().describe('Call to action button text, at most 4 words'),
});

const SYSTEM = `You are the creative director for 15-second vertical (9:16) product ads in the style of Gemini and ChatGPT shorts: no people, the real product UI floating in a designed space, short kinetic captions, one magic moment.

You get a product map written by an agent that explored the app: features it actually performed, with a visual score (1-5) for how good each looks on screen.

Choose 2-4 shots that tell one story: a problem or starting point, the signature action, and the payoff. Prefer high visual scores and features whose result visibly appears or transforms. Shots play in order and the app keeps its state between them, so a later shot can continue from an earlier one (e.g. generate something, then use it).

Writing rules: captions at most 6 words, plain and concrete, describing what the viewer sees or gets; the headline must state the product's promise; no exclamation marks, no buzzwords ("revolutionize", "seamless", "unlock"). Mark exactly one word or short phrase per line with *asterisks* for the brand gradient.

Use the effects catalog's guidance: exactly one signature shot (it gets the single sparkle), lift the payoff on the signature shot, and at most one other lift.`;

function describeMap(map) {
  const lines = [];
  if (map.summary?.product_summary) lines.push(`Product: ${map.summary.product_summary}`);
  if (map.summary?.audience) lines.push(`Audience: ${map.summary.audience}`);
  if (map.summary?.top_ad_moments?.length) lines.push(`Explorer's top moments: ${map.summary.top_ad_moments.join('; ')}`);
  lines.push('', 'Features:');
  for (const feature of map.features) {
    lines.push(`- "${feature.name}" (visual ${feature.visualScore}/5, ${feature.steps.length} steps): ${feature.summary}`);
    lines.push(`  Steps: ${feature.steps.map((s) => s.locator ? `${s.action} ${s.locator.role} "${s.locator.name}"`
      : `${s.action}${s.text ? ` "${s.text}"` : ''}`).join(' → ')}`);
    lines.push(`  Result: ${feature.result}${feature.notes ? ` · Notes: ${feature.notes}` : ''}`);
  }
  return lines.join('\n');
}

/** Check a storyboard against the map and fix what can be fixed safely; throw on what can't. */
export function validateStoryboard(storyboard, map) {
  const names = new Map(map.features.map((feature) => [feature.name.toLowerCase(), feature.name]));
  const shots = storyboard.shots.filter((shot) => names.has(shot.feature.toLowerCase()))
    .map((shot) => ({...shot, feature: names.get(shot.feature.toLowerCase())}));
  if (!shots.length) throw new Error('Storyboard does not use any feature from the product map.');
  let signature = shots.findIndex((shot) => shot.emphasis === 'signature');
  if (signature < 0) signature = shots.length - 1;
  shots.forEach((shot, index) => { shot.emphasis = index === signature ? 'signature' : 'supporting'; });
  let lifts = 0;
  for (const shot of [shots[signature], ...shots.filter((_, i) => i !== signature)]) {
    if (shot.lift && ++lifts > 2) shot.lift = false;
  }
  return {...storyboard, shots: shots.slice(0, 4)};
}

export async function writeStoryboard({
  map,
  brand,
  brief = '',
  catalogPath = new URL('../video/effects.catalog.json', import.meta.url),
  model = 'claude-opus-5-5',
  effort = 'medium',
  fallbacks = true,
  client = new Anthropic(),
}) {
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const effects = catalog.effects.map((e) => `- ${e.name}: ${e.purpose}${e.guidance ? ` (${e.guidance})` : ''}`).join('\n');
  const prompt = [
    describeMap(map),
    '',
    `Brand colors: primary ${brand?.primary}, accent ${brand?.accent}.`,
    brief ? `Brief from the team: ${brief}` : '',
    '',
    'Effects available (applied automatically from your shot choices):',
    effects,
    '',
    'Write the storyboard.',
  ].filter((line) => line !== null).join('\n');

  const response = await client.beta.messages.parse({
    model,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: {effort, format: betaZodOutputFormat(StoryboardSchema)},
    ...(fallbacks ? {betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default'} : {}),
    messages: [{role: 'user', content: prompt}],
  });
  if (response.stop_reason === 'refusal') {
    throw new Error(`Storyboard request declined (${response.stop_details?.category ?? 'unknown'}).`);
  }
  if (!response.parsed_output) throw new Error('Storyboard response did not match the schema.');
  return {storyboard: validateStoryboard(response.parsed_output, map), usage: response.usage};
}
