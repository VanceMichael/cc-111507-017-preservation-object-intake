import { receiveBytes } from './http-client.mjs';
import { inspect } from './source-metadata.mjs';
import { collectStructured } from './structured-intake.mjs';

export async function collect({ input, descriptor, sourceBase, store }) {
  if (input.mode === 'structured') return collectStructured({ input, descriptor, sourceBase, store });
  if (input.mode !== 'raw') return { httpStatus: 400, error: '接收方式无效' };
  const source = await receiveBytes(`${sourceBase}/files/${encodeURIComponent(descriptor.entry)}`);
  const blob = await store.blob(source.bytes);
  const receipt = await store.save({ state: 'received', mode: 'raw', product: descriptor.product,
    source: descriptor.entry, sourceVersion: source.etag, metadata: inspect(source.bytes), blobs: [blob],
    records: [], issues: [], coverage: { structured: false, downloadedBytes: source.bytes.length } });
  return { receipt };
}
