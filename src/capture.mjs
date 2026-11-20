import {mkdir, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {chromium} from 'playwright';
import {collectAssets} from './assets.mjs';
import {createDirector} from './director.mjs';
import {observeTarget, snapshot} from './snapshot.mjs';

const MiB = 1024 * 1024;

/**
 * Run a trusted Playwright recipe against one primary browser tab.
 * All output paths in the manifest are relative to the capture directory.
 */
export async function capture({
  output,
  run,
  viewport = {width: 1280, height: 800},
  launch = {},
  context: contextOptions = {},
  snapshotIntervalMs = 0,
  archive = true,
  assets = {perAssetBytes: 32 * MiB, totalBytes: 256 * MiB},
}) {
  if (typeof run !== 'function' || !output) {
    throw new TypeError('capture requires output and a run function.');
  }
  if (!Number.isSafeInteger(snapshotIntervalMs) || snapshotIntervalMs < 0) {
    throw new TypeError('snapshotIntervalMs must be a nonnegative integer.');
  }
  if (assets && [assets.perAssetBytes, assets.totalBytes].some((limit) =>
    !Number.isSafeInteger(limit) || limit < 0)) {
    throw new TypeError('Asset byte limits must be nonnegative integers.');
  }
  const directory = resolve(output);
  await mkdir(dirname(directory), {recursive: true});
  await mkdir(directory);
  const write = async (file, payload) => {
    const path = resolve(directory, file);
    await mkdir(dirname(path), {recursive: true});
    const data = typeof payload === 'string' || ArrayBuffer.isView(payload)
      ? payload
      : JSON.stringify(payload);
    await writeFile(path, data);
  };

  const manifest = {
    version: 1,
    status: 'running',
    startedAtMs: Date.now(),
    viewport,
    snapshots: [],
    steps: [],
    issues: [],
  };
  const frames = [];
  const animations = [];
  const cues = [];
  const writeManifest = () => write('manifest.json', JSON.stringify(manifest, null, 2));
  await writeManifest();

  let browser;
  let context;
  let session;
  let collector;
  let interval;
  let acceptingFrames = false;
  let frameQueue = Promise.resolve();
  let snapshotQueue = Promise.resolve();
  let failed = false;
  let failure;
  const mark = (label, phase) => manifest.steps.push({label, phase, atMs: Date.now()});

  try {
    browser = await chromium.launch({ignoreDefaultArgs: ['--hide-scrollbars'], ...launch});
    context = await browser.newContext({...contextOptions, viewport});
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    session = await context.newCDPSession(page);
    // Each rendered frame is stored as PNG, with Chromium's capture timestamp.
    session.on('Page.screencastFrame', ({data, metadata, sessionId}) => {
      if (!acceptingFrames) return;
      const index = frames.length;
      const file = `frames/${String(index).padStart(6, '0')}.png`;
      const entry = {file, atMs: Date.now(), metadata};
      frames.push(entry);
      frameQueue = frameQueue.then(async () => {
        try {
          await write(file, Buffer.from(data, 'base64'));
        } catch (error) {
          entry.error = error.message;
        } finally {
          await session.send('Page.screencastFrameAck', {sessionId}).catch(() => {});
        }
      });
    });
    if (assets) collector = collectAssets(page, write, assets);
    const onAnimation = (kind, data) => animations.push({kind, atMs: Date.now(), data});
    const target = await observeTarget(session, onAnimation);
    acceptingFrames = true;
    await session.send('Page.startScreencast', {format: 'png', everyNthFrame: 1});

    const checkpoint = (label) => {
      const result = snapshotQueue.then(async () => {
        const folder = `snapshots/${String(manifest.snapshots.length).padStart(4, '0')}`;
        const record = {label, folder, startMs: Date.now(), url: page.url()};
        manifest.snapshots.push(record);
        try {
          Object.assign(record, await snapshot(
            page, context, target, (file, data) => write(`${folder}/${file}`, data),
            onAnimation, archive,
          ));
        } catch (error) {
          record.error = error.message;
        } finally {
          record.endMs = Date.now();
        }
        return record;
      });
      snapshotQueue = result.catch(() => {});
      return result;
    };

    const step = async (label, action) => {
      mark(label, 'start');
      try {
        const result = await action(page);
        mark(label, 'end');
        return result;
      } catch (error) {
        mark(label, 'failed');
        throw error;
      }
    };

    if (snapshotIntervalMs) {
      let sampling = false;
      interval = setInterval(() => {
        if (sampling || page.url() === 'about:blank') return;
        sampling = true;
        void checkpoint('interval').finally(() => { sampling = false; });
      }, snapshotIntervalMs);
    }
    try {
      const director = createDirector(page, viewport, (cue) => cues.push(cue));
      await run({page, step, checkpoint, director});
    } finally {
      clearInterval(interval);
      await checkpoint('Final');
    }

  } catch (error) {
    failed = true;
    failure = error;
    manifest.error = error instanceof Error ? error.message : String(error);
  } finally {
    acceptingFrames = false;
    const cleanup = async (operation, action) => {
      try {
        await action();
      } catch (error) {
        manifest.issues.push({operation, error: error.message});
      }
    };
    collector?.stop();
    await cleanup('stop screencast', () => session?.send('Page.stopScreencast'));
    await frameQueue;
    // Closing the page cancels still-pending resource bodies.
    await cleanup('close browser context', () => context?.close());
    await cleanup('write asset index', async () => {
      if (collector) manifest.assets = await collector.flush();
    });
    await cleanup('close browser', () => browser?.close());
    await cleanup('write frame index', () => {
      const time = ({metadata, atMs}) => (metadata.timestamp ?? atMs / 1000);
      // Chromium occasionally delivers compositor frames out of timestamp order.
      frames.sort((a, b) => time(a) - time(b));
      return write('frames.json', frames);
    });
    await cleanup('write animation index', () => write('animations.json', animations));
    if (cues.length) {
      await cleanup('write direction track', async () => {
        await write('direction.json', {version: 1, cues});
        manifest.direction = 'direction.json';
      });
    }
    manifest.endedAtMs = Date.now();
    manifest.frameCount = frames.filter(({error}) => !error).length;
    const snapshotIssues = manifest.snapshots.some(({error, issues, coverage}) =>
      error || issues?.length || coverage?.some(({reason}) => reason !== 'Included in parent target'));
    const partial = snapshotIssues || manifest.issues.length || manifest.assets?.omitted
      || manifest.frameCount !== frames.length || !manifest.frameCount;
    manifest.status = failed ? 'failed' : partial ? 'partial' : 'complete';
    await writeManifest();
  }
  if (failed) throw failure;
  return {directory, manifest};
}
