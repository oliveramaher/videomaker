import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, describe, test} from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import {DEMO_PASSWORD, DEMO_USER, startDemoApp} from '../fixtures/demo-app/server.mjs';
import {login} from '../src/explore/login.mjs';
import {makeAd} from '../src/make-ad.mjs';
import {compileShootPlan, payoffRegion} from '../src/shoot.mjs';
import {validateStoryboard, writeStoryboard} from '../src/storyboard.mjs';

const fixture = (name) => readFile(new URL(`../fixtures/demo-app/${name}`, import.meta.url), 'utf8');
const map = JSON.parse(await fixture('product-map.json'));
const storyboard = JSON.parse(await fixture('storyboard.json'));

describe('shoot plan compiler', () => {
  test('continues from the previous shot instead of repeating its steps', () => {
    const plan = compileShootPlan(map, storyboard);
    assert.equal(plan.shots.length, 2);
    assert.equal(plan.shots[0].navigate, true);
    assert.deepEqual(plan.shots[0].steps.map((s) => s.locator.name), ['✨ Plan with AI']);
    assert.equal(plan.shots[1].navigate, false, 'second shot should pick up where the first left off');
    assert.equal(plan.shots[1].skippedSteps, 1);
    assert.deepEqual(plan.shots[1].steps.map((s) => s.locator.name), ['Add all to board']);
    assert.deepEqual(plan.clutter.map((c) => c.name), ['Accept', 'Dismiss tip']);
  });

  test('navigates fresh when a shot does not continue the previous one', () => {
    const plan = compileShootPlan(map, {...storyboard, shots: [
      {feature: 'Create a project from a template', caption: 'x', emphasis: 'supporting', lift: false},
      {feature: 'Plan next steps with AI', caption: 'y', emphasis: 'signature', lift: true},
    ]});
    assert.equal(plan.shots[1].navigate, true);
    assert.equal(plan.shots[0].steps.length, 4);
  });

  test('rejects features that are not in the map', () => {
    assert.throws(() => compileShootPlan(map, {shots: [{feature: 'Teleport'}]}), /unknown feature/);
  });
});

describe('payoff detection', () => {
  const viewport = {width: 1280, height: 800};
  const block = (text, x, y, width = 100, height = 20) => ({text, x, y, width, height});

  test('uses new content and ignores content it pushed down', () => {
    const before = [block('Board', 300, 100), block('To do', 300, 140)];
    const after = [block('Board', 300, 300), block('To do', 300, 340),
      block('Suggested next steps', 300, 100, 300), block('1. Do a thing', 320, 130, 260)];
    assert.deepEqual(payoffRegion(before, after, viewport), {x: 300, y: 100, width: 300, height: 50});
  });

  test('adds moved text right beside tiny new controls', () => {
    const before = [block('Write hero copy', 330, 400, 150)];
    const after = [block('<input>Complete Write hero copy', 300, 200, 16, 16), block('Write hero copy', 330, 198, 150)];
    const region = payoffRegion(before, after, viewport);
    assert.equal(region.x, 300);
    assert.equal(region.width, 180);
  });

  test('returns null when nothing changed', () => {
    const blocks = [block('Same', 10, 10)];
    assert.equal(payoffRegion(blocks, blocks, viewport), null);
  });
});

describe('storyboard', () => {
  test('validation keeps one signature, caps lifts, and drops unknown features', () => {
    const fixed = validateStoryboard({...storyboard, shots: [
      {feature: 'plan next steps with ai', caption: 'a', emphasis: 'signature', lift: true},
      {feature: 'Made up', caption: 'b', emphasis: 'signature', lift: true},
      {feature: 'Create a project from a template', caption: 'c', emphasis: 'signature', lift: true},
      {feature: 'Change the insights time range', caption: 'd', emphasis: 'supporting', lift: true},
    ]}, map);
    assert.deepEqual(fixed.shots.map((s) => s.feature),
      ['Plan next steps with AI', 'Create a project from a template', 'Change the insights time range']);
    assert.deepEqual(fixed.shots.map((s) => s.emphasis), ['signature', 'supporting', 'supporting']);
    assert.equal(fixed.shots.filter((s) => s.lift).length, 2);
  });

  test('asks Claude for a schema-shaped storyboard through the SDK (scripted, no cost)', async () => {
    let request;
    const client = new Anthropic({apiKey: 'test-key', maxRetries: 0, fetch: async (url, init) => {
      request = {body: JSON.parse(init.body), headers: new Headers(init.headers)};
      return new Response(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn',
        stop_sequence: null, usage: {input_tokens: 900, output_tokens: 200},
        content: [{type: 'text', text: JSON.stringify(storyboard)}],
      }), {status: 200, headers: {'content-type': 'application/json'}});
    }});
    const result = await writeStoryboard({map, brand: {primary: '#6d4aff', accent: '#ffb547'}, client});
    assert.equal(result.storyboard.shots[0].emphasis, 'signature');
    assert.equal(request.body.model, 'claude-opus-5-5');
    assert.equal(request.body.output_config.format.type, 'json_schema');
    assert.equal(request.body.fallbacks, 'default');
    assert.match(request.headers.get('anthropic-beta') ?? '', /server-side-fallback-2026-07-01/);
    const prompt = request.body.messages[0].content;
    assert.match(prompt, /Plan next steps with AI/);
    assert.match(prompt, /SparkleBurst/, 'the effects catalog should be in the prompt');
  });
});

describe('make-ad pipeline (films the demo app; no render)', () => {
  let app;
  let dir;
  before(async () => {
    app = await startDemoApp({port: 0});
    dir = await mkdtemp(join(tmpdir(), 'vm-make-ad-'));
  });
  after(async () => {
    app?.server.closeAllConnections();
    await app?.close();
    if (dir) await rm(dir, {recursive: true, force: true});
  });

  test('films each storyboard shot with markers, targets, payoffs and hidden clutter', async () => {
    const storageState = join(dir, 'state.json');
    await login({url: `${app.url}/login`, username: DEMO_USER, password: DEMO_PASSWORD, storageState});
    const mapPath = join(dir, 'map.json');
    await writeFile(mapPath, (await fixture('product-map.json')).replaceAll('http://127.0.0.1:4317', app.url));
    const boardPath = join(dir, 'storyboard.json');
    await writeFile(boardPath, JSON.stringify({...storyboard, shots: [
      {feature: 'Create a project from a template', caption: 'Start in *seconds*', emphasis: 'supporting', lift: false},
      ...storyboard.shots,
    ]}));

    const result = await makeAd({mapPath, storyboardPath: boardPath, storageState, output: join(dir, 'ad'),
      publicDir: join(dir, 'public'), render: false, log: () => {}});

    const timeline = JSON.parse(await readFile(join(dir, 'public', result.take, 'timeline.json'), 'utf8'));
    const markers = timeline.cues.filter((c) => c.kind === 'marker').map((c) => c.label);
    for (let i = 0; i < 3; i++) {
      for (const part of ['start', 'payoff', 'end']) assert.ok(markers.includes(`shot:${i}:${part}`), `missing shot:${i}:${part}`);
    }
    const anchor = (label) => timeline.cues.find((c) => c.kind === 'anchor' && c.label === label);
    assert.ok(anchor('logo'), 'logo should be found');
    assert.ok(anchor('shot:0:target:1'), 'typing step should record its field');

    // Shot 0 payoff: the new project card. Shot 1 payoff: the AI suggestions card, not the board it pushed down.
    const created = anchor('shot:0:payoff').box;
    assert.ok(created.width < 500 && created.height < 200, JSON.stringify(created));
    const suggestions = anchor('shot:1:payoff').box;
    assert.ok(suggestions.y < 200 && suggestions.height < 200 && suggestions.width < 600, JSON.stringify(suggestions));

    // Clicks: New project, field, Create project, Plan with AI, Add all to board.
    const clicks = timeline.cues.filter((c) => c.kind === 'pointer' && c.action === 'down');
    assert.equal(clicks.length, 5);
    assert.deepEqual(app.dangerHits, []);

    // Clutter flagged by the explorer is hidden in what was filmed.
    const snapshots = JSON.parse(await readFile(join(dir, 'ad', 'capture', 'manifest.json'), 'utf8')).snapshots;
    const lastTree = await readFile(join(dir, 'ad', 'capture', snapshots.at(-1).folder, 'targets', '0', 'accessibility.json'), 'utf8')
      .catch(() => null);
    if (lastTree) {
      assert.ok(!lastTree.includes('Cookie notice'), 'cookie banner should be hidden');
      assert.ok(!lastTree.includes('Dismiss tip'), 'tip should be hidden');
    }
    const brand = JSON.parse(await readFile(join(dir, 'ad', 'brand.json'), 'utf8'));
    assert.equal(brand.primary, '#6d4aff');
  });
});
