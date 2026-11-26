// npm run login   -- [--url <login page>] [--out <state.json>] [--manual]
// npm run explore -- --url <app url> [--storage-state <state.json>] [--actions 40] [--brief "..."]
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {explore} from './explore/agent.mjs';
import {login} from './explore/login.mjs';

if (existsSync('.env')) process.loadEnvFile('.env');

const [command, ...rest] = process.argv.slice(2);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

try {
  if (command === 'login') {
    const {values} = parseArgs({args: rest, options: {
      url: {type: 'string'}, out: {type: 'string'}, manual: {type: 'boolean'}, headed: {type: 'boolean'},
    }});
    const url = values.url ?? process.env.APP_LOGIN_URL;
    if (!url) throw new Error('Pass --url or set APP_LOGIN_URL.');
    const result = await login({
      url,
      username: process.env.APP_USERNAME,
      password: process.env.APP_PASSWORD,
      storageState: values.out ?? process.env.APP_STORAGE_STATE ?? 'output/app.storage-state.json',
      manual: values.manual,
      headless: !values.headed,
    });
    console.log(`Signed in (landed on ${result.landedOn}). Session saved to ${result.storageState}`);
  } else if (command === 'explore') {
    const {values} = parseArgs({args: rest, options: {
      url: {type: 'string'}, 'storage-state': {type: 'string'}, output: {type: 'string'},
      actions: {type: 'string'}, brief: {type: 'string'}, model: {type: 'string'}, effort: {type: 'string'},
      allow: {type: 'string', multiple: true}, headed: {type: 'boolean'}, 'no-fallbacks': {type: 'boolean'},
    }});
    const startUrl = values.url ?? process.env.APP_URL;
    if (!startUrl) throw new Error('Pass --url or set APP_URL.');
    const storageState = values['storage-state'] ?? process.env.APP_STORAGE_STATE;
    if (storageState && !existsSync(storageState)) throw new Error(`No session file at ${storageState}; run npm run login first.`);
    const output = values.output ?? `output/explore/${stamp()}`;
    const maxActions = Number(values.actions ?? 40);
    console.log(`Exploring ${startUrl} with up to ${maxActions} actions → ${resolve(output)}`);
    const result = await explore({
      startUrl, output, storageState, maxActions,
      brief: values.brief ?? '',
      model: values.model ?? 'claude-opus-5-5',
      effort: values.effort ?? 'medium',
      fallbacks: !values['no-fallbacks'],
      headless: !values.headed,
      allowNames: values.allow ?? [],
      onProgress: (event) => {
        if (event.type === 'text') console.log(`\n${event.text}`);
        if (event.type === 'tool') {
          const {why, ...args} = event.input ?? {};
          console.log(`  → ${event.name} ${JSON.stringify(args)}${why ? `  (${why})` : ''}`);
        }
      },
    });
    const {usage, map} = result;
    console.log(`\n${result.finished ? 'Finished' : 'Stopped early'}: ${map.features.length} features, `
      + `${Object.keys(map.pages).length} pages, ${map.clutter.length} clutter items.`);
    console.log(`Tokens: ${usage.input} in (+${usage.cacheRead} cached read, ${usage.cacheWrite} cache write), `
      + `${usage.output} out over ${usage.requests} requests.`);
    console.log(`Product map: ${result.path}`);
  } else {
    throw new Error('Usage: node src/explore-cli.mjs <login|explore> [options]');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
