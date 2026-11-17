import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/server.mjs';
import {
  compareInventories,
  digestBytes,
  ensureInsideObjectRoot,
  parseSidecar,
  planVersion,
  validateInventory,
  verifyPlannedContent,
  verifySidecar,
} from '../src/ocfl.mjs';

const fixtureRoot = new URL('../fixtures/', import.meta.url);
const inventoryBytes = await readFile(new URL('inventory.json', fixtureRoot));
const sidecarBytes = await readFile(new URL('inventory.json.sha512', fixtureRoot));

async function withService(scenario, fn) {
  const dataDir = await mkdtemp(join(tmpdir(), 'ocfl-structured-'));
  const service = await createService({ dataDir, scenario });
  try {
    await fn(service, dataDir);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function postIntake(service, body) {
  const response = await fetch(`${service.baseUrl}/v1/intakes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('标准场景：head 版本逻辑文件按清单映射取得，共享内容保留全部逻辑关系', async () => {
  await withService('standard', async (service, dataDir) => {
    const { status, body: receipt } = await postIntake(service, { mode: 'structured', version: 'v2' });
    assert.equal(status, 201);
    assert.equal(receipt.state, 'complete');
    assert.equal(receipt.objectId, 'urn:local:object:1');
    assert.equal(receipt.digestAlgorithm, 'sha512');
    assert.equal(receipt.records.length, 2);
    const logicalPaths = receipt.records.map(record => record.logicalPath).sort();
    assert.deepEqual(logicalPaths, ['copies/main.txt', 'letters/main.txt']);
    for (const record of receipt.records) {
      assert.equal(record.state, 'reliable');
      assert.equal(record.content.contentPath, 'v1/payload/text.txt');
      assert.equal(record.content.digest, digestBytes('sha512', await readFile(new URL('v1/payload/text.txt', fixtureRoot))));
      assert.ok(record.recordId.includes(record.logicalPath));
    }
    // 同一物理内容被两个逻辑路径复用：blob 只有一份，但两条逻辑记录都指向它。
    const blobDigests = new Set(receipt.records.map(record => record.content.blob.digest));
    assert.equal(blobDigests.size, 1);
    assert.equal(receipt.coverage.distinctContentFetched, 1);
    assert.equal(receipt.coverage.distinctContentRequired, 1);
    assert.equal(receipt.coverage.reliableCount, 2);
    assert.equal(receipt.coverage.contentDirectory, 'payload');
    // 实际落盘的 blob 字节与来源一致。
    const blobDigest = [...blobDigests][0];
    const stored = await readFile(join(dataDir, 'blobs', blobDigest));
    assert.deepEqual(stored, await readFile(new URL('v1/payload/text.txt', fixtureRoot)));
    // 证据链覆盖对象声明、根清单、根 sidecar 与内容，且包含身份摘要核对依据。
    const roles = receipt.evidence.map(item => item.role);
    assert.ok(roles.includes('ocfl-declaration'));
    assert.ok(roles.includes('root-inventory'));
    assert.ok(roles.includes('root-inventory-sidecar'));
    assert.ok(roles.includes('payload-content'));
    // 重新打开同一 DATA_DIR 后记录仍可查询且完全一致。
    const persisted = await (await fetch(`${service.baseUrl}/v1/receipts/${receipt.id}`)).json();
    assert.deepEqual(persisted.records, receipt.records);
    assert.deepEqual(persisted.coverage, receipt.coverage);
    // 只领取 v2 引用的内容：trace 中没有任何来源清单之外或未被 state 引用的资源访问。
    const descriptor = await (await fetch(`${service.baseUrl}/v1/source`)).json();
    const fetched = service.gateway.trace
      .filter(item => item.path.startsWith('/files/'))
      .map(item => decodeURIComponent(item.path.slice(7)));
    for (const resource of fetched) assert.ok(descriptor.resources.includes(resource), `访问了未授权资源：${resource}`);
    assert.equal(receipt.issues.length, 0);
  });
});

test('缺省 version 取 head 版本，历史版本未引用的内容不会顺手领取', async () => {
  await withService('standard', async service => {
    const { body: receipt } = await postIntake(service, { mode: 'structured' });
    assert.equal(receipt.state, 'complete');
    assert.equal(receipt.coverage.selectedVersion, 'v2');
    assert.equal(receipt.coverage.requestedVersion, null);
    assert.equal(receipt.coverage.historicalContentExcluded, 0);
    const resources = service.gateway.trace
      .filter(item => item.path.startsWith('/files/'))
      .map(item => decodeURIComponent(item.path.slice(7)));
    // head 版本清单与根清单互相核对；payload 内容只拉取 state 引用的一份，且不重复下载。
    assert.ok(resources.includes('v2/inventory.json'));
    assert.ok(resources.includes('v2/inventory.json.sha512'));
    const payloadFetches = resources.filter(name => name.includes('/payload/'));
    assert.deepEqual([...new Set(payloadFetches)], ['v1/payload/text.txt']);
    assert.equal(payloadFetches.length, 1);
  });
});

test('指定历史版本 v1：逻辑身份按 v1 state 还原，不混入 head 的逻辑路径', async () => {
  await withService('standard', async service => {
    // 来源清单未提供 v1/inventory.json：无法核对版本清单时必须拒绝，不能静默回退到根清单。
    const { status, body } = await postIntake(service, { mode: 'structured', version: 'v1' });
    assert.equal(status, 201);
    assert.equal(body.state, 'rejected');
    assert.ok(body.issues.some(issue => issue.code === 'version-inventory-unavailable'));
    assert.equal(body.records.filter(record => record.state === 'reliable').length, 0);
    const resources = service.gateway.trace
      .filter(item => item.path.startsWith('/files/'))
      .map(item => decodeURIComponent(item.path.slice(7)));
    // 版本清单未核对通过前不得领取任何 payload 内容。
    assert.ok(!resources.some(name => name.includes('/payload/')));
  });
});

test('bad-inventory-digest：sidecar 摘要与清单字节不符时拒绝领取内容', async () => {
  await withService('bad-inventory-digest', async service => {
    const { body: receipt } = await postIntake(service, { mode: 'structured', version: 'v2' });
    assert.equal(receipt.state, 'rejected');
    assert.ok(receipt.issues.some(issue => issue.code === 'inventory-digest-mismatch'));
    assert.equal(receipt.records.filter(record => record.state === 'reliable').length, 0);
    const resources = service.gateway.trace
      .filter(item => item.path.startsWith('/files/'))
      .map(item => decodeURIComponent(item.path.slice(7)));
    assert.ok(!resources.some(name => name.includes('/payload/')));
    // 原始清单与 sidecar 字节仍作为证据保留。
    assert.ok(receipt.evidence.some(item => item.role === 'root-inventory'));
    assert.ok(receipt.evidence.some(item => item.role === 'root-inventory-sidecar'));
  });
});

test('missing-content：清单可信但内容缺失形成 partial，逐条定位且不静默降级', async () => {
  await withService('missing-content', async service => {
    const { body: receipt } = await postIntake(service, { mode: 'structured', version: 'v2' });
    assert.equal(receipt.state, 'partial');
    assert.ok(receipt.issues.some(issue => issue.code === 'content-unavailable'));
    assert.ok(receipt.issues.every(issue => issue.resource));
    assert.equal(receipt.coverage.logicalFileCount, 2);
    assert.equal(receipt.coverage.reliableCount, 0);
    for (const record of receipt.records) {
      assert.equal(record.state, 'missing');
      assert.equal(record.content.blob, null);
      assert.equal(record.content.contentPath, 'v1/payload/text.txt');
    }
    assert.deepEqual(receipt.records.map(record => record.logicalPath).sort(), ['copies/main.txt', 'letters/main.txt']);
    // partial 不能写成 complete，且原始清单证据仍然保留。
    assert.notEqual(receipt.state, 'complete');
    assert.ok(receipt.evidence.some(item => item.role === 'root-inventory'));
  });
});

test('version-mismatch：根清单与 head 版本清单不相符时拒绝，不能静默采用任一份', async () => {
  await withService('version-mismatch', async service => {
    const { body: receipt } = await postIntake(service, { mode: 'structured', version: 'v2' });
    assert.equal(receipt.state, 'rejected');
    assert.ok(receipt.issues.some(issue => ['version-inventory-mismatch', 'version-inventory-digest-mismatch',
      'inventory-digest-mismatch'].includes(issue.code)));
    const resources = service.gateway.trace
      .filter(item => item.path.startsWith('/files/'))
      .map(item => decodeURIComponent(item.path.slice(7)));
    assert.ok(!resources.some(name => name.includes('/payload/')));
  });
});

test('未知版本与非法版本号：请求级失败，不生成可靠收件', async () => {
  await withService('standard', async service => {
    const unknown = await postIntake(service, { mode: 'structured', version: 'v9' });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /指定版本不存在/);
    const illegal = await postIntake(service, { mode: 'structured', version: '../v2' });
    assert.equal(illegal.status, 400);
    const receipts = await (await fetch(`${service.baseUrl}/v1/receipts`)).json();
    assert.equal(receipts.length, 0);
  });
});

test('raw 收件行为保持不变', async () => {
  await withService('standard', async service => {
    const { status, body } = await postIntake(service, { mode: 'raw' });
    assert.equal(status, 201);
    assert.equal(body.state, 'received');
    assert.equal(body.coverage.structured, false);
  });
});

test('纯函数：路径边界、sidecar、清单规划与内容摘要核对', async () => {
  const intake = validateInventory(inventoryBytes);
  assert.equal(intake.contentDirectory, 'payload');
  verifySidecar(intake.algorithm, inventoryBytes, sidecarBytes);
  const plan = planVersion(intake, 'v2');
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0].logicalPaths.sort(), ['copies/main.txt', 'letters/main.txt']);
  assert.equal(plan[0].chosenContentPath, 'v1/payload/text.txt');
  const content = await readFile(new URL(plan[0].chosenContentPath, fixtureRoot));
  assert.doesNotThrow(() => verifyPlannedContent(intake, plan[0], plan[0].chosenContentPath, content));
  assert.throws(() => verifyPlannedContent(intake, plan[0], 'v2/payload/other.txt', content), /manifest/);
  assert.throws(() => verifyPlannedContent(intake, plan[0], plan[0].chosenContentPath, Buffer.from('tampered')), /内容摘要不符/);

  for (const unsafe of ['/etc/passwd', '../outside.txt', 'a/../b/../../x', 'a//b', 'a/./b', 'a/b/../..', '\\a\\b', '']) {
    assert.throws(() => ensureInsideObjectRoot(unsafe), /路径/);
  }
  assert.equal(ensureInsideObjectRoot('v1/payload/a b.txt'), 'v1/payload/a b.txt');

  const parsed = parseSidecar('sha512', sidecarBytes);
  assert.equal(parsed.filename, 'inventory.json');
  assert.throws(() => parseSidecar('sha512', Buffer.from('zzzz not-hex inventory.json')), /sidecar/);

  const versionBytes = await readFile(new URL('v2/inventory.json', fixtureRoot));
  const versionIntake = validateInventory(versionBytes, { expectedId: intake.id });
  assert.deepEqual(compareInventories(intake, versionIntake), []);
  const tampered = validateInventory(Buffer.from(versionBytes.toString().replace('"head": "v2"', '"head": "v1"')),
    { expectedId: intake.id });
  assert.ok(compareInventories(intake, tampered).includes('head'));
});

test('纯函数：非默认 contentDirectory 被识别且路径布局按该目录校验', () => {
  const custom = Buffer.from(inventoryBytes.toString('utf8').replaceAll('payload', 'archive'));
  const intake = validateInventory(custom);
  assert.equal(intake.contentDirectory, 'archive');
  const plan = planVersion(intake, 'v1');
  assert.equal(plan[0].chosenContentPath, 'v1/archive/text.txt');
  // 清单声明 archive 目录，manifest 却放到别的目录：布局校验必须拒绝。
  const wrongLayout = Buffer.from(inventoryBytes.toString('utf8')
    .replaceAll('v1/payload/', 'v2/elsewhere/'));
  assert.throws(() => validateInventory(wrongLayout), /内容路径不符合版本/);
  // 非法内容目录名直接拒绝。
  assert.throws(() => validateInventory(Buffer.from(inventoryBytes.toString('utf8')
    .replace('"contentDirectory": "payload"', '"contentDirectory": "../content"'))), /内容目录/);
});

test('纯函数：清单结构缺陷与非法摘要一律拒绝', () => {
  assert.throws(() => validateInventory(Buffer.from('{"id":"x"}')), /type/);
  assert.throws(() => validateInventory(Buffer.from('not-json')), /JSON/);
  const badDigest = Buffer.from(inventoryBytes.toString('utf8')
    .replace('b97a38ffcfda7eead35edcb891ceb3d040ab9fb6bbb20f40b0a960e21fd8b11bec99ef131f48459964ac4365b8cd14f59d132e013f7e861a7dbce9c00a9c56ca', 'nope'));
  assert.throws(() => validateInventory(badDigest), /摘要/);
  const traversal = Buffer.from(inventoryBytes.toString('utf8')
    .replace('v1/payload/text.txt', '../../escape.txt'));
  assert.throws(() => validateInventory(traversal), /对象边界|路径/);
});
