import {copyFile, link, mkdir, readFile, writeFile} from 'node:fs/promises';
import {basename, join, resolve} from 'node:path';

/** Publish only the footage and cues Remotion needs, keeping the raw bundle intact. */
export async function prepareDemo({capture, publicDir, name = basename(resolve(capture)), fps = 30, cuts = []}) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Choose a take name with letters, numbers, dashes or underscores.');
  if (!Number.isSafeInteger(fps) || fps < 1 || fps > 120) throw new Error('FPS must be an integer between 1 and 120.');

  const json = async (file) => JSON.parse(await readFile(join(capture, file), 'utf8'));
  const [manifest, frameIndex, direction] = await Promise.all([
    json('manifest.json'), json('frames.json'), json('direction.json'),
  ]);
  const start = direction.cues.find(({kind}) => kind === 'start')?.atMs;
  const end = direction.cues.findLast(({kind}) => kind === 'end')?.atMs;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error('The take needs a complete director.start() and director.end() window.');
  }

  const duration = (end - start) / 1000;
  let previousEnd = 0;
  const segments = [];
  for (const [from, to] of [...cuts].sort((a, b) => a[0] - b[0])) {
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < previousEnd || to <= from || to > duration) {
      throw new Error('Cuts must be non-overlapping time ranges inside the take.');
    }
    if (from > previousEnd) segments.push([previousEnd, from]);
    previousEnd = to;
  }
  if (previousEnd < duration) segments.push([previousEnd, duration]);
  if (!segments.length) throw new Error('The edit would contain no footage.');

  const frames = frameIndex
    .filter(({file, error}) => !error && /^frames\/[0-9]+\.png$/.test(file))
    .map(({file, metadata, atMs}) => ({file, atMs: (metadata.timestamp ?? atMs / 1000) * 1000 - start}));
  frames.sort((a, b) => a.atMs - b.atMs);
  if (!frames.length) throw new Error('The capture has no usable frames.');

  let index = 0;
  let outputFrame = 0;
  let editTime = 0;
  const timeline = [];
  for (const [from, to] of segments) {
    const segmentEnd = editTime + (to - from);
    for (; outputFrame / fps < segmentEnd; outputFrame++) {
      const atMs = (from + outputFrame / fps - editTime) * 1000;
      while (index + 1 < frames.length && frames[index + 1].atMs <= atMs) index++;
      timeline.push({file: frames[index].file, atMs, pixelsAtMs: frames[index].atMs});
    }
    editTime = segmentEnd;
  }

  const directory = resolve(publicDir, name);
  await mkdir(resolve(publicDir), {recursive: true});
  await mkdir(directory);
  await mkdir(join(directory, 'frames'));
  for (const file of new Set(timeline.map((frame) => frame.file))) {
    const source = join(capture, file);
    const destination = join(directory, file);
    try {
      await link(source, destination);
    } catch (error) {
      if (!['EXDEV', 'ENOTSUP', 'EPERM'].includes(error.code)) throw error;
      await copyFile(source, destination);
    }
  }
  const plan = {
    version: 1,
    ...manifest.viewport,
    fps,
    timeline,
    cues: direction.cues.map((cue) => ({...cue, atMs: cue.atMs - start})),
  };
  await writeFile(join(directory, 'timeline.json'), JSON.stringify(plan, null, 2));
  return {directory, frames: timeline.length, seconds: timeline.length / fps};
}
