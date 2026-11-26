import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, describe, test} from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import {DEMO_PASSWORD, DEMO_USER, startDemoApp} from '../fixtures/demo-app/server.mjs';
import {explore, needsScreenshot} from '../src/explore/agent.mjs';
import {login} from '../src/explore/login.mjs';
import {imageTokens} from '../src/explore/observe.mjs';
import {openSession} from '../src/explore/session.mjs';

/** Width and height from a JPEG's start-of-frame marker. */
function jpegSize(buffer) {
  for (let i = 2; i < buffer.length;) {
    const marker = buffer[i + 1];
    const length = buffer.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return {height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7)};
    i += 2 + length;
  }
  return null;
}

describe('screenshot policy', () => {
  const base = {urlBefore: '/a', urlAfter: '/a', changes: ['no visible structural change (may be a style/hover change only)']};
  test('skips images for small changes and refusals', () => {
    assert.equal(needsScreenshot(base), false);
    assert.equal(needsScreenshot({refused: 'nope'}), false);
    assert.equal(needsScreenshot({...base, changes: ['2 new controls: button "A", button "B"']}), false);
  });
  test('sends images when the screen changes a lot, on errors, on request, and periodically', () => {
    assert.equal(needsScreenshot({...base, urlAfter: '/b'}), true);
    assert.equal(needsScreenshot({...base, changes: ['opened dialog "New project"']}), true);
    assert.equal(needsScreenshot({...base, changes: ['new headings: Suggested next steps']}), true);
    assert.equal(needsScreenshot({...base, changes: ['6 new controls: …']}), true);
    assert.equal(needsScreenshot({...base, changes: ['new text (140 chars): Suggested next steps | 1. …']}), true);
    assert.equal(needsScreenshot({...base, changes: ['new text (12 chars): Saved']}), false);
    assert.equal(needsScreenshot({...base, error: 'timeout'}), true);
    assert.equal(needsScreenshot(base, {asked: true}), true);
    assert.equal(needsScreenshot(base, {sinceLast: 5}), true);
  });
});

describe('explorer token savings (demo app)', () => {
  let app;
  let dir;
  let storageState;
  before(async () => {
    app = await startDemoApp({port: 0});
    dir = await mkdtemp(join(tmpdir(), 'vm-tokens-'));
    storageState = join(dir, 'state.json');
    await login({url: `${app.url}/login`, username: DEMO_USER, password: DEMO_PASSWORD, storageState});
  });
  after(async () => {
    app?.server.closeAllConnections();
    await app?.close();
    if (dir) await rm(dir, {recursive: true, force: true});
  });

  test('model screenshots are 1024px wide; saved screenshots stay full size', async () => {
    const session = await openSession({startUrl: `${app.url}/app`, output: join(dir, 'size'), storageState});
    try {
      const state = await session.start();
      assert.deepEqual(jpegSize(state.screenshots.marked), {width: 1024, height: 640});
      assert.deepEqual(jpegSize(state.screenshots.clean), {width: 1280, height: 800});
      assert.ok(imageTokens(1024, 640) < imageTokens(1280, 800) * 0.65);
    } finally {
      await session.close();
    }
  });

  test('pre-crawl maps linked pages without clicking anything', async () => {
    const session = await openSession({startUrl: `${app.url}/app`, output: join(dir, 'crawl'), storageState});
    try {
      await session.start();
      const pages = await session.crawl();
      const hashes = pages.map((p) => new URL(p.url).hash);
      assert.ok(hashes.includes('#/insights') && hashes.includes('#/settings'), hashes.join(','));
      const settings = pages.find((p) => p.url.endsWith('#/settings'));
      assert.ok(settings.buttons.includes('Delete workspace'), 'buttons are listed, not pressed');
      assert.deepEqual(app.dangerHits, []);
      assert.equal(session.actions.length, 0, 'crawling uses no actions');
      assert.equal(new URL(session.page.url()).pathname, '/app');
    } finally {
      await session.close();
    }
  });

  test('scripted run: site map in the first message, far fewer images than actions', async () => {
    const requests = [];
    let turn = 0;
    const lastText = (body) => JSON.stringify(body.messages.at(-1).content);
    const ref = (text, label) => Number(new RegExp(`\\[(\\d+)\\] [a-z]+ \\\\"${label}\\\\"`).exec(text)?.[1]);
    const reply = (content, stop = 'tool_use') => ({id: `msg_${turn}`, type: 'message', role: 'assistant',
      model: 'claude-opus-5-5', content, stop_reason: stop, stop_sequence: null,
      usage: {input_tokens: 1000, output_tokens: 50}});
    const tool = (name, input) => ({type: 'tool_use', id: `toolu_${turn}`, name, input});
    // A realistic stretch: open a project, plan with AI, poke around, add to board, check insights.
    const script = [
      (t) => tool('click', {ref: ref(t, 'Open Website relaunch'), why: 'open project'}),
      (t) => tool('hover', {ref: ref(t, '✨ Plan with AI'), why: 'hover state'}),
      (t) => tool('click', {ref: ref(t, '✨ Plan with AI'), why: 'try AI'}),
      (t) => tool('hover', {ref: ref(t, 'Add all to board'), why: 'hover'}),
      (t) => tool('click', {ref: ref(t, 'Add all to board'), why: 'add'}),
      (t) => tool('click', {ref: ref(t, 'Complete Write hero copy'), why: 'tick a task'}),
      (t) => tool('click', {ref: ref(t, 'Complete Write hero copy'), why: 'untick'}),
      (t) => tool('click', {ref: ref(t, 'Insights'), why: 'see insights'}),
      (t) => tool('select_option', {ref: ref(t, 'Time range'), option: 'Last 30 days', why: 'change range'}),
      (t) => tool('select_option', {ref: ref(t, 'Time range'), option: 'Last 7 days', why: 'change back', look: true}),
      () => tool('finish', {product_summary: 'Tracker', audience: 'Teams', top_ad_moments: ['AI plan']}),
    ];
    const client = new Anthropic({apiKey: 'test-key', maxRetries: 0, fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      const step = script[turn];
      turn += 1;
      const message = step ? reply([step(lastText(body))]) : reply([{type: 'text', text: 'Done.'}], 'end_turn');
      return new Response(JSON.stringify(message), {status: 200, headers: {'content-type': 'application/json'}});
    }});

    const result = await explore({startUrl: `${app.url}/app`, output: join(dir, 'agent'), storageState, maxActions: 20, client});
    assert.equal(result.finished, true);
    const intro = JSON.stringify(requests[0].messages[0].content);
    assert.match(intro, /Site map/);
    assert.match(intro, /#\/insights/);

    const toolResults = requests.slice(1).map((body) => body.messages.at(-1).content.find((b) => b.type === 'tool_result'));
    const withImage = toolResults.filter((r) => r && Array.isArray(r.content) && r.content.some((b) => b.type === 'image')).length;
    const actions = result.stats.actions;
    assert.equal(actions, 10);
    assert.ok(withImage >= 3, 'big changes (new page, AI card) still get screenshots');
    assert.ok(withImage <= 6, `expected at most 6 images for 10 actions, got ${withImage}`);
    assert.equal(result.stats.images, withImage);
    // Requested screenshots (look: true) are honored.
    assert.ok(JSON.stringify(toolResults[9]).includes('"type":"image"'));

    const before = actions * imageTokens(1280, 800);
    const after = withImage * imageTokens(1024, 640);
    console.log(`  image tokens for ${actions} actions: ${before} before → ${after} after (${Math.round(100 - 100 * after / before)}% less)`);
    assert.deepEqual(app.dangerHits, []);
  });
});
