import {parseArgs} from 'node:util';
import {prepareDemo} from './prepare-demo.mjs';

try {
  const {positionals, values} = parseArgs({
    allowPositionals: true,
    options: {
      name: {type: 'string'},
      'public-dir': {type: 'string', default: 'output/video-assets'},
      fps: {type: 'string', default: '30'},
      cut: {type: 'string', multiple: true, default: []},
    },
  });
  if (positionals.length !== 1 || values.cut.some((range) => !/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(range))) {
    throw new Error('Usage: npm run prepare-demo -- <capture directory> [--name <take>] [--cut <from:to>]');
  }
  const result = await prepareDemo({
    capture: positionals[0],
    publicDir: values['public-dir'],
    name: values.name,
    fps: Number(values.fps),
    cuts: values.cut.map((range) => range.split(':').map(Number)),
  });
  console.log(`${result.seconds.toFixed(2)} seconds (${result.frames} frames) · ${result.directory}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
