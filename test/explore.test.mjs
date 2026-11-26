import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, describe, test} from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import {DEMO_PASSWORD, DEMO_USER, startDemoApp} from '../fixtures/demo-app/server.mjs';
import {explore} from '../src/explore/agent.mjs';
import {login} from '../src/explore/login.mjs';
import {openSession} from '../src/explore/session.mjs';

const refOf = (state, role, name) => {
  const element = state.elements.find((el) => el.role === role && el.name === name);
  assert.ok(element, `expected ${role} "${name}" in:\n${state.elements.map((el) => `${el.role} "${el.name}"`).join('\n')}`);
  return element.ref;
};

let app;
let dir;
let storageState;

before(async () => {
  app = await startDemoApp({port: 0});
  dir = await mkdtemp(join(tmpdir(), 'vm-explore-'));
  storageState = join(dir, 'state.json');
});
after(async () => {
  await app?.close();
  if (dir) await rm(dir, {recursive: true, force: true});
});

describe('login', () => {
  test('rejects a wrong password', async () => {
    await assert.rejects(
      login({url: `${app.url}/login`, username: DEMO_USER, password: 'nope', storageState: join(dir, 'bad.json')}),
      /rejected/);
  });
  test('saves a session that opens the app', async () => {
    const result = await login({url: `${app.url}/login`, username: DEMO_USER, password: DEMO_PASSWORD, storageState});
    assert.match(result.landedOn, /\/app$/);
    const saved = await readFile(storageState, 'utf8');
    assert.ok(!saved.includes(DEMO_PASSWORD), 'password must not be stored in the session file');
  });
});

describe('session', () => {
  test('observes, acts, records a feature with replayable locators', async () => {
    const session = await openSession({startUrl: `${app.url}/app`, output: join(dir, 'run1'), storageState});
    try {
      let state = await session.start();
      assert.equal(state.title, 'Tasklane');
      assert.ok(state.dialogs.some((d) => d.name === 'Cookie notice'), 'cookie banner should be reported as an overlay');

      ({state} = await session.click(refOf(state, 'button', 'New project')));
      const opened = session.actions.at(-1);
      assert.ok(opened.changes.some((c) => c.includes('opened dialog "New project"')), opened.changes.join('; '));

      ({state} = await session.type(refOf(state, 'textbox', 'Project name'), 'Q3 launch plan'));
      ({state} = await session.select(refOf(state, 'combobox', 'Template'), 'Product launch'));
      ({state} = await session.click(refOf(state, 'button', 'Create project')));
      assert.ok(state.elements.some((el) => el.name === 'Open Q3 launch plan'), 'new project card should appear');

      const feature = session.recordFeature({
        name: 'Create a project from a template',
        summary: 'Makes a new project prefilled with launch tasks',
        actionIds: [1, 2, 3, 4],
        result: 'A new project card appears',
        visualScore: 4,
      });
      assert.deepEqual(feature.steps.map((s) => s.action), ['click', 'type', 'select', 'click']);
      assert.deepEqual(feature.steps[0].locator, {role: 'button', name: 'New project', nth: 0});
      assert.equal(feature.steps[1].text, 'Q3 launch plan');

      // The saved locator must work in a fresh Playwright query (this is what replay will use).
      const {role, name} = feature.steps[3].locator;
      ({state} = await session.click(refOf(state, 'button', 'New project')));
      assert.equal(await session.page.getByRole(role, {name, exact: true}).count(), 1);
      await session.press('Escape');

      const path = await session.save();
      const map = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(map.features.length, 1);
      assert.ok(Object.keys(map.pages).length >= 1);
    } finally {
      await session.close();
    }
  });

  test('guard refuses destructive, outbound and off-site actions', async () => {
    const session = await openSession({startUrl: `${app.url}/app#/settings`, output: join(dir, 'run2'), storageState});
    try {
      let state = await session.start();
      for (const name of ['Delete workspace', 'Send invite', 'Upgrade to Pro', 'Log out']) {
        const result = await session.click(refOf(state, 'button', name));
        assert.ok(result.refused, `${name} should be refused`);
        state = result.state;
      }
      // Typing an email is fine, but Enter must not submit anything outward-facing.
      ({state} = await session.type(refOf(state, 'textbox', 'Email'), 'someone@example.com'));
      const external = await session.goto('https://example.com/');
      assert.match(external.refused, /outside the app/);
      // Off-site navigation triggered by the page itself is blocked at the network level too.
      await session.page.evaluate(() => { location.href = 'https://example.com/'; }).catch(() => {});
      await session.page.waitForURL(`${app.url}/**`, {timeout: 5000});
      assert.ok(session.page.url().startsWith(app.url), session.page.url());
      assert.deepEqual(app.dangerHits, [], 'no dangerous endpoint may be reached');
    } finally {
      await session.close();
    }
  });

  test('allowNames can explicitly permit a blocked button', async () => {
    const session = await openSession({startUrl: `${app.url}/app#/settings`, output: join(dir, 'run3'), storageState,
      allowNames: ['Upgrade to Pro']});
    try {
      const state = await session.start();
      const result = await session.click(refOf(state, 'button', 'Upgrade to Pro'));
      assert.equal(result.refused, undefined);
      assert.deepEqual(app.dangerHits.splice(0), ['upgrade']);
    } finally {
      await session.close();
    }
  });
});

describe('agent loop (scripted model, no API cost)', () => {
  test('drives the session through the real SDK tool runner and writes a product map', async () => {
    const requests = [];
    let turn = 0;
    const lastToolText = (body) => {
      const content = body.messages.at(-1).content;
      const blocks = Array.isArray(content) ? content : [{type: 'text', text: content}];
      const texts = [];
      for (const block of blocks) {
        if (block.type === 'text') texts.push(block.text);
        if (block.type === 'tool_result' && Array.isArray(block.content)) {
          for (const inner of block.content) if (inner.type === 'text') texts.push(inner.text);
        }
      }
      return texts.join('\n');
    };
    const findRef = (text, label) => Number(new RegExp(`\\[(\\d+)\\] [a-z]+ "${label}"`).exec(text)?.[1]);
    const reply = (content, stop = 'tool_use') => ({
      id: `msg_${turn}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content,
      stop_reason: stop, stop_sequence: null,
      usage: {input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0},
    });
    const tool = (name, input) => ({type: 'tool_use', id: `toolu_${turn}`, name, input});

    const fakeFetch = async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({url: String(url), body, headers: init.headers});
      turn += 1;
      const text = lastToolText(body);
      let message;
      if (turn === 1) message = reply([{type: 'text', text: 'Looking at projects.'}, tool('click', {ref: findRef(text, 'New project'), why: 'open the new project form'})]);
      else if (turn === 2) message = reply([tool('type', {ref: findRef(text, 'Project name'), text: 'Q3 launch plan', why: 'name it'})]);
      else if (turn === 3) message = reply([tool('click', {ref: findRef(text, 'Create project'), why: 'create it'})]);
      else if (turn === 4) message = reply([tool('record_feature', {name: 'Create a project', summary: 'Adds a project', action_ids: [1, 2, 3], result: 'New card', visual_score: 3})]);
      else if (turn === 5) message = reply([tool('goto', {path: '/app#/settings'})]);
      else if (turn === 6) message = reply([tool('click', {ref: findRef(text, 'Delete workspace'), why: 'see what it does'})]);
      else if (turn === 7) message = reply([tool('finish', {product_summary: 'Project tracker', audience: 'Small teams', top_ad_moments: ['Creating a project']})]);
      else message = reply([{type: 'text', text: 'Done.'}], 'end_turn');
      return new Response(JSON.stringify(message), {status: 200, headers: {'content-type': 'application/json', 'request-id': `req_${turn}`}});
    };

    const client = new Anthropic({apiKey: 'test-key', fetch: fakeFetch, maxRetries: 0});
    const result = await explore({
      startUrl: `${app.url}/app`, output: join(dir, 'agent'), storageState, maxActions: 10, client,
    });

    assert.equal(result.finished, true);
    assert.equal(result.map.features.length, 1);
    assert.equal(result.map.features[0].steps[0].locator.name, 'New project');
    assert.deepEqual(app.dangerHits, []);

    const first = requests[0].body;
    assert.equal(first.model, 'claude-opus-5-5');
    assert.equal(first.output_config.effort, 'medium');
    assert.equal(first.fallbacks, 'default');
    assert.equal(first.context_management.edits[0].type, 'clear_tool_uses_20250919');
    assert.ok(first.tools.some((t) => t.name === 'record_feature'));
    assert.ok(first.messages[0].content.some((b) => b.type === 'image'), 'first turn should include a screenshot');
    const beta = new Headers(requests[0].headers).get('anthropic-beta') ?? '';
    assert.match(beta, /context-management-2025-06-27/);
    assert.match(beta, /server-side-fallback-2026-07-01/);
    // The guard's refusal reached the model as a tool result.
    assert.match(JSON.stringify(requests[6].body.messages.at(-1)), /REFUSED/);
    // Credentials never appear in anything sent to the model.
    assert.ok(!JSON.stringify(requests.map((r) => r.body)).includes(DEMO_PASSWORD));
  });
});
