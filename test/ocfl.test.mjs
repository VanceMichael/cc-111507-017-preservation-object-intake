import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/server.mjs';
import { pathProblem, parseSidecar, parseInventory, planVersion, consistencyProblems } from '../src/ocfl.mjs';

async function intake(scenario, body) {
  const dataDir = await mkdtemp(join(tmpdir(), 'ocfl-test-'));
  const service = await createService({ dataDir, scenario });
  try {
    const response = await fetch(`${service.baseUrl}/v1/intakes`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const receipt = await response.json();
    const trace = await (await fetch(`${service.gateway.baseUrl}/trace`)).json();
    return { status: response.status, receipt, trace };
  } finally { await service.close(); await rm(dataDir, { recursive: true, force: true }); }
}

test('结构化收件：指定版本逻辑文件按清单可靠取得且内容去重', async () => {
  const { status, receipt, trace } = await intake('standard', { mode: 'structured', version: 'v2' });
  assert.equal(status, 201);
  assert.equal(receipt.state, 'complete');
  assert.deepEqual(receipt.issues, []);
  assert.equal(receipt.records.length, 2);
  const paths = receipt.records.map(record => record.logicalPath).sort();
  assert.deepEqual(paths, ['copies/main.txt', 'letters/main.txt']);
  // 同一内容被两个逻辑路径复用：记录各自保留，内容 blob 共享
  assert.equal(receipt.records[0].blob, receipt.records[1].blob);
  assert.equal(receipt.records[0].digest, receipt.records[1].digest);
  // 根清单与 v2 清单字节相同，去重后只存一份；加内容共两个 blob
  assert.equal(receipt.blobs.length, 2);
  assert.equal(receipt.evidence.inventoryBlob, receipt.evidence.versionInventory.blob);
  assert.ok(receipt.blobs.some(blob => blob.digest === receipt.records[0].blob));
  // 复用关系写入证据：内容来自历史版本 v1，被 v2 的两个逻辑路径共享
  assert.equal(receipt.evidence.relationships.length, 1);
  assert.deepEqual(receipt.evidence.relationships[0].logicalPaths.sort(), ['copies/main.txt', 'letters/main.txt']);
  assert.equal(receipt.evidence.relationships[0].contentPath, 'v1/payload/text.txt');
  assert.equal(receipt.evidence.relationships[0].contentVersion, 'v1');
  assert.equal(receipt.evidence.objectId, 'urn:local:object:1');
  assert.equal(receipt.evidence.contentDirectory, 'payload');
  assert.equal(receipt.evidence.declaration, 'ocfl_object_1.1');
  assert.equal(receipt.coverage.structured, true);
  assert.equal(receipt.coverage.version, 'v2');
  assert.equal(receipt.coverage.expected, 2);
  assert.equal(receipt.coverage.obtained, 2);
  assert.deepEqual(receipt.coverage.missing, []);
  assert.deepEqual(receipt.coverage.fetched, ['v1/payload/text.txt']);
  // 只领取清单核对的资源：内容只取一份，历史未引用内容不在范围
  const fetched = trace.filter(item => item.path.startsWith('/files/')).map(item => item.path);
  assert.deepEqual(fetched, [
    '/files/inventory.json',
    '/files/inventory.json.sha512',
    '/files/0%3Docfl_object_1.1',
    '/files/v2%2Finventory.json',
    '/files/v2%2Finventory.json.sha512',
    '/files/v1%2Fpayload%2Ftext.txt',
  ]);
});

test('结构化收件：版本缺省时领取 head 版本', async () => {
  const { receipt } = await intake('standard', { mode: 'structured' });
  assert.equal(receipt.state, 'complete');
  assert.equal(receipt.coverage.version, 'v2');
  assert.equal(receipt.records.length, 2);
});

test('结构化收件：历史版本可领取，版本清单缺失记入问题', async () => {
  const { receipt } = await intake('standard', { mode: 'structured', version: 'v1' });
  assert.equal(receipt.state, 'partial');
  assert.equal(receipt.records.length, 1);
  assert.equal(receipt.records[0].logicalPath, 'letter.txt');
  assert.equal(receipt.records[0].contentPath, 'v1/payload/text.txt');
  assert.ok(receipt.issues.some(issue => issue.problem.includes('版本清单缺失')));
  assert.equal(receipt.coverage.obtained, 1);
});

test('结构化收件：清单 sidecar 摘要不符时拒绝且不留逻辑文件', async () => {
  const { status, receipt } = await intake('bad-inventory-digest', { mode: 'structured', version: 'v2' });
  assert.equal(status, 201);
  assert.equal(receipt.state, 'rejected');
  assert.deepEqual(receipt.records, []);
  assert.ok(receipt.issues.some(issue => issue.problem.includes('sidecar')));
});

test('结构化收件：内容缺失不静默降级', async () => {
  const { receipt } = await intake('missing-content', { mode: 'structured', version: 'v2' });
  assert.equal(receipt.state, 'rejected');
  assert.deepEqual(receipt.records, []);
  assert.ok(receipt.issues.some(issue => issue.problem.includes('内容缺失')));
  assert.deepEqual(receipt.coverage.missing.sort(), ['copies/main.txt', 'letters/main.txt']);
  assert.equal(receipt.coverage.obtained, 0);
});

test('结构化收件：根清单与版本清单不相符时拒绝', async () => {
  const { receipt } = await intake('version-mismatch', { mode: 'structured', version: 'v2' });
  assert.equal(receipt.state, 'rejected');
  assert.deepEqual(receipt.records, []);
  assert.ok(receipt.issues.some(issue => issue.path === 'v2/inventory.json'));
});

test('结构化收件：版本标识无效返回 400', async () => {
  for (const version of ['../etc', 'v0', 'v2/../v1', 2]) {
    const { status } = await intake('standard', { mode: 'structured', version });
    assert.equal(status, 400, `version=${version}`);
  }
});

test('对象内路径校验：绝对形式、空组件与越界组件均被拒绝', () => {
  for (const path of ['/abs/path', 'C:/abs/path', 'a//b', 'a/./b', 'a/../b', '..', '']) {
    assert.ok(pathProblem(path), `应拒绝：${JSON.stringify(path)}`);
  }
  assert.equal(pathProblem('letters/main.txt'), null);
  assert.equal(pathProblem('v1/payload/text.txt'), null);
});

test('sidecar 解析：摘要小写化并识别文件名', () => {
  assert.deepEqual(parseSidecar(Buffer.from('B27DAD70 inventory.json\n')), { digest: 'b27dad70', name: 'inventory.json' });
  assert.deepEqual(parseSidecar(Buffer.from('b27dad70')), { digest: 'b27dad70', name: null });
  assert.ok(parseSidecar(Buffer.from('不是摘要')).problem);
});

test('清单解析：不支持的摘要算法与非法内容目录被拒绝', () => {
  const base = { id: 'urn:x', type: 'https://ocfl.io/1.1/spec/#inventory', head: 'v1', versions: {}, manifest: {} };
  assert.ok(parseInventory(Buffer.from(JSON.stringify({ ...base, digestAlgorithm: 'md5' }))).problem);
  assert.ok(parseInventory(Buffer.from(JSON.stringify({ ...base, digestAlgorithm: 'sha512', contentDirectory: '../up' }))).problem);
  assert.ok(parseInventory(Buffer.from(JSON.stringify({ ...base, digestAlgorithm: 'sha512', contentDirectory: 'a/b' }))).problem);
  const parsed = parseInventory(Buffer.from(JSON.stringify({ ...base, digestAlgorithm: 'sha512', contentDirectory: 'payload' })));
  assert.equal(parsed.contentDirectory, 'payload');
  assert.ok(parseInventory(Buffer.from('not json')).problem);
});

test('领取计划：越界逻辑路径与未来版本内容不进入计划', () => {
  const digest = 'a'.repeat(128);
  const inventory = { digestAlgorithm: 'sha512',
    manifest: { [digest]: ['v2/payload/x.txt'] },
    versions: { v1: { state: { [digest]: ['x.txt', '../evil.txt', 'ok/y.txt'] } },
                v2: { state: { [digest]: ['x.txt'] } } } };
  const v1 = planVersion(inventory, 'payload', 'v1');
  assert.equal(v1.files.length, 0);
  assert.equal(v1.problems.length, 3);
  assert.equal(v1.logicalPaths.length, 3);
  const v2 = planVersion(inventory, 'payload', 'v2');
  assert.equal(v2.files.length, 1);
  assert.equal(v2.files[0].contentPath, 'v2/payload/x.txt');
  const wrongDirectory = planVersion({ ...inventory, manifest: { [digest]: ['v2/other/x.txt'] } }, 'payload', 'v2');
  assert.equal(wrongDirectory.files.length, 0);
});

test('清单一致性：版本清单 head 与状态须与根清单相符', () => {
  const digest = 'b'.repeat(128);
  const root = { id: 'urn:x', digestAlgorithm: 'sha512', head: 'v2', contentDirectory: 'payload',
    manifest: { [digest]: ['v1/payload/x.txt'] },
    versions: { v1: { state: { [digest]: ['x.txt'] } }, v2: { state: { [digest]: ['x.txt', 'y.txt'] } } } };
  assert.deepEqual(consistencyProblems(root, { ...root, head: 'v2' }, 'v2'), []);
  assert.ok(consistencyProblems(root, { ...root, head: 'v1' }, 'v2').some(problem => problem.includes('head')));
  const altered = { ...root, head: 'v2', versions: { ...root.versions, v2: { state: { [digest]: ['x.txt'] } } } };
  assert.ok(consistencyProblems(root, altered, 'v2').some(problem => problem.includes('版本状态')));
});
