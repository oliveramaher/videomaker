// End to end: explore an app (or load a product map) → storyboard → compile a shoot plan →
// film it → prepare the take → render the vertical ad. Every intermediate is saved, so any
// step can be inspected, edited and re-run from its file.
import {spawn} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {probeBrand} from './brand.mjs';
import {capture} from './capture.mjs';
import {explore} from './explore/agent.mjs';
import {prepareDemo} from './prepare-demo.mjs';
import {compileShootPlan, createShootRecipe} from './shoot.mjs';
import {validateStoryboard, writeStoryboard} from './storyboard.mjs';

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const writeJson = (path, data) => writeFile(path, JSON.stringify(data, null, 2));

function run(command, args, {cwd}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {cwd, stdio: ['ignore', 'inherit', 'inherit']});
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code}`)));
  });
}

export async function makeAd({
  startUrl,
  storageState,
  output = `output/ads/${new Date().toISOString().replace(/[:.]/g, '-')}`,
  mapPath,
  storyboardPath,
  brief = '',
  maxActions = 40,
  model,
  effort,
  client,
  publicDir = 'output/video-assets',
  render = true,
  root = process.cwd(),
  log = console.log,
}) {
  const directory = resolve(output);
  await mkdir(directory, {recursive: true});
  const stamp = directory.split('/').at(-1).replace(/[^a-zA-Z0-9_-]/g, '-');

  // 1. Product map: from a file, or by exploring the app now.
  let map;
  if (mapPath) {
    map = await readJson(mapPath);
    log(`Product map: ${mapPath} (${map.features.length} features)`);
  } else {
    if (!startUrl) throw new Error('Pass a URL to explore, or --map with an existing product map.');
    log(`Exploring ${startUrl} (up to ${maxActions} actions)…`);
    const result = await explore({startUrl, output: join(directory, 'explore'), storageState, brief, maxActions,
      ...(model ? {model} : {}), ...(effort ? {effort} : {}), ...(client ? {client} : {})});
    map = result.map;
    log(`Explored: ${map.features.length} features → ${result.path}`);
  }
  if (!map.features.length) throw new Error('The product map has no features to film.');

  // 2. Brand palette from the live site.
  const brand = await probeBrand({url: map.app.startUrl, storageState});
  await writeJson(join(directory, 'brand.json'), brand);

  // 3. Storyboard: from a file, or written by Claude.
  let storyboard;
  if (storyboardPath) {
    storyboard = validateStoryboard(await readJson(storyboardPath), map);
  } else {
    log('Writing storyboard…');
    ({storyboard} = await writeStoryboard({map, brand, brief, ...(model ? {model} : {}), ...(client ? {client} : {})}));
  }
  await writeJson(join(directory, 'storyboard.json'), storyboard);
  log(`Storyboard: "${storyboard.headline}" · ${storyboard.shots.map((s) => s.feature).join(' → ')}`);

  // 4. Shoot plan, then film it at 2x for sharp close-ups.
  const plan = compileShootPlan(map, storyboard);
  await writeJson(join(directory, 'shoot-plan.json'), plan);
  log('Filming…');
  const {manifest} = await capture({
    output: join(directory, 'capture'),
    run: createShootRecipe(plan),
    viewport: {width: 1280, height: 800},
    context: {storageState, deviceScaleFactor: 2},
    archive: false,
  });
  log(`Filmed ${manifest.frameCount} frames (${manifest.status}).`);

  // 5. Prepare the take and render.
  const take = `ad-${stamp}`;
  await prepareDemo({capture: join(directory, 'capture'), publicDir, name: take});
  const props = {take, storyboard};
  await writeJson(join(directory, 'props.json'), props);
  const video = join(directory, 'ad.mp4');
  if (render) {
    log('Rendering…');
    await run('npx', ['remotion', 'render', 'video/index.jsx', 'Ad', video, `--props=${join(directory, 'props.json')}`,
      `--public-dir=${publicDir}`, '--codec=h264', '--crf=18', '--log=error'], {cwd: root});
    log(`Ad: ${video}`);
  }
  return {directory, map, storyboard, plan, take, video: render ? video : null};
}
