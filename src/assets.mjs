import {createHash} from 'node:crypto';

const TYPES = new Set(['image', 'stylesheet', 'font', 'media']);

export function collectAssets(page, write, limits) {
  const pending = new Set();
  const bodies = new Map();
  const records = [];
  let bytes = 0;

  const collect = async (response, record) => {
    try {
      if (!response.ok()) {
        record.status = 'http-error';
        return;
      }
      const length = Number(await response.headerValue('content-length'));
      if (length > limits.perAssetBytes) {
        record.status = 'asset-limit';
        return;
      }
      const body = await response.body();
      if (body.length > limits.perAssetBytes) {
        record.status = 'asset-limit';
        return;
      }
      const hash = createHash('sha256').update(body).digest('hex');
      const file = `assets/${hash}`;
      if (!bodies.has(hash)) {
        if (bytes + body.length > limits.totalBytes) {
          record.status = 'total-limit';
          return;
        }
        bytes += body.length;
        bodies.set(hash, write(file, body));
      }
      await bodies.get(hash);
      Object.assign(record, {status: 'saved', file, bytes: body.length});
    } catch (error) {
      Object.assign(record, {status: 'unavailable', error: error.message});
    }
  };

  const onResponse = (response) => {
    const type = response.request().resourceType();
    if (!TYPES.has(type) || [301, 302, 303, 307, 308].includes(response.status())) return;
    const headers = response.headers();
    const record = {
      url: response.url(),
      type,
      mimeType: headers['content-type'],
      contentRange: headers['content-range'],
      httpStatus: response.status(),
    };
    records.push(record);
    const task = collect(response, record).finally(() => pending.delete(task));
    pending.add(task);
  };
  page.on('response', onResponse);

  return {
    stop: () => page.off('response', onResponse),
    async flush() {
      await Promise.all(pending);
      await write('assets.json', records);
      return {
        saved: records.filter(({status}) => status === 'saved').length,
        omitted: records.filter(({status}) => status !== 'saved').length,
        uniqueBytes: bytes,
      };
    },
  };
}
