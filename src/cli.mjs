import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {capture} from './capture.mjs';

try {
  const {positionals, values} = parseArgs({
    allowPositionals: true,
    options: {
      output: {type: 'string'},
      headed: {type: 'boolean'},
      channel: {type: 'string'},
      executable: {type: 'string'},
      'storage-state': {type: 'string'},
      'interval-ms': {type: 'string'},
      'no-archive': {type: 'boolean'},
      'no-assets': {type: 'boolean'},
    },
  });
  if (positionals.length !== 1) {
    throw new Error('Usage: npm run capture -- <recipe.mjs> [--output <new directory>] [--headed]');
  }
  const recipe = await import(pathToFileURL(resolve(positionals[0])).href);
  const output = values.output ?? `output/playwright/${new Date().toISOString().replace(/[:.]/g, '-')}`;
  console.log(`Capture directory: ${resolve(output)}`);
  const {manifest} = await capture({
    output,
    run: recipe.default,
    viewport: recipe.viewport,
    launch: {headless: !values.headed, channel: values.channel, executablePath: values.executable},
    context: {storageState: values['storage-state']},
    snapshotIntervalMs: Number(values['interval-ms'] ?? 0),
    archive: !values['no-archive'],
    ...(values['no-assets'] ? {assets: false} : {}),
  });
  console.log(`${manifest.status}: ${manifest.frameCount} viewport frames, ${manifest.snapshots.length} snapshots`);
  if (manifest.status !== 'complete') process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
