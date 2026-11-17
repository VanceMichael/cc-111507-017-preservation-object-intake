import { receiveBytes } from './http-client.mjs';
import { inspect } from './source-metadata.mjs';
import { parseInventory, parseSidecar, digestHex, consistencyProblems, planVersion } from './ocfl.mjs';

const DECLARATION_FILE = '0=ocfl_object_1.1';
const DECLARATION_BODY = 'ocfl_object_1.1';

// 结构化收件：按 OCFL 清单领取指定版本的逻辑文件。
// 只取清单核对的字节；清单身份、版本一致性、内容摘要任一不符都写入 issues，
// 无法可靠取得任何逻辑文件时状态为 rejected，绝不静默降级。
export async function collectStructured({ input, descriptor, sourceBase, store }) {
  if (input.version !== undefined && (typeof input.version !== 'string' || !/^v[1-9]\d*$/.test(input.version))) {
    throw new Error('版本标识无效');
  }
  const issues = [];
  const records = [];
  const blobs = [];
  const blobIndex = new Set();
  const evidence = { relationships: [] };
  const coverage = { structured: true };
  let sourceVersion = null;
  let metadata = { format: 'OCFL', objectId: null, head: null, digestAlgorithm: null };

  const fetchFile = (name) => receiveBytes(`${sourceBase}/files/${encodeURIComponent(name)}`);
  const addBlob = async (bytes) => {
    const blob = await store.blob(bytes);
    if (!blobIndex.has(blob.digest)) { blobIndex.add(blob.digest); blobs.push(blob); }
    return blob;
  };
  const finish = async (state) => {
    const receipt = await store.save({ state, mode: 'structured', product: descriptor.product,
      source: descriptor.entry, sourceVersion, metadata, blobs, records, issues, coverage, evidence });
    return { receipt };
  };
  const reject = async (problem, path = descriptor.entry) => {
    issues.push({ path, problem });
    return finish('rejected');
  };

  // 1. 根清单：先取原始字节，再核对 sidecar 摘要确认清单身份。
  let rootSource;
  try { rootSource = await fetchFile(descriptor.entry); }
  catch (error) { return reject(`根清单无法领取：${error.message}`); }
  sourceVersion = rootSource.etag ?? null;
  metadata = inspect(rootSource.bytes);
  const parsed = parseInventory(rootSource.bytes);
  if (parsed.problem) return reject(parsed.problem);
  const { inventory, contentDirectory } = parsed;
  const algorithm = inventory.digestAlgorithm;
  evidence.objectId = inventory.id;
  evidence.head = inventory.head;
  evidence.digestAlgorithm = algorithm;
  evidence.contentDirectory = contentDirectory;
  coverage.head = inventory.head;

  let sidecar;
  try { sidecar = await fetchFile(`${descriptor.entry}.${algorithm}`); }
  catch { return reject('清单 sidecar 缺失，清单身份无法核对'); }
  const sidecarInfo = parseSidecar(sidecar.bytes);
  if (sidecarInfo.problem) return reject(`清单 sidecar 无效：${sidecarInfo.problem}`);
  const inventoryDigest = digestHex(algorithm, rootSource.bytes);
  if (sidecarInfo.digest !== inventoryDigest) return reject('清单摘要与 sidecar 不符');
  if (sidecarInfo.name && sidecarInfo.name !== descriptor.entry) return reject('清单 sidecar 指向其他文件');
  evidence.inventoryDigest = inventoryDigest;
  evidence.inventoryBlob = (await addBlob(rootSource.bytes)).digest;

  // 2. 对象声明：作为对象身份的旁证，问题记入 issues 但不单独否决。
  try {
    const declaration = await fetchFile(DECLARATION_FILE);
    evidence.declaration = declaration.bytes.toString('utf8').trim();
    if (evidence.declaration !== DECLARATION_BODY) issues.push({ path: DECLARATION_FILE, problem: '对象声明内容不符' });
  } catch {
    evidence.declaration = null;
    issues.push({ path: DECLARATION_FILE, problem: '对象声明缺失' });
  }

  // 3. 解析目标版本（缺省 head），版本必须真实存在于清单中。
  const version = input.version ?? inventory.head;
  coverage.version = version;
  evidence.version = version;
  if (!inventory.versions[version] || typeof inventory.versions[version].state !== 'object' || inventory.versions[version].state === null) {
    return reject(`指定版本 ${version} 不存在或缺少状态`);
  }

  // 4. 版本清单：存在则核对 sidecar 并与根清单比对；缺失记入 issues，以根清单为准但不许静默。
  const versionEntry = `${version}/inventory.json`;
  let versionSource = null;
  try { versionSource = await fetchFile(versionEntry); }
  catch {
    evidence.versionInventory = { path: versionEntry, present: false };
    issues.push({ path: versionEntry, problem: '版本清单缺失，以根清单为准' });
  }
  if (versionSource) {
    const parsedVersion = parseInventory(versionSource.bytes);
    if (parsedVersion.problem) return reject(`版本清单无效：${parsedVersion.problem}`, versionEntry);
    let versionSidecar;
    try { versionSidecar = await fetchFile(`${versionEntry}.${algorithm}`); }
    catch { return reject('版本清单 sidecar 缺失，版本清单身份无法核对', versionEntry); }
    const versionSidecarInfo = parseSidecar(versionSidecar.bytes);
    if (versionSidecarInfo.problem) return reject(`版本清单 sidecar 无效：${versionSidecarInfo.problem}`, versionEntry);
    const versionDigest = digestHex(algorithm, versionSource.bytes);
    if (versionSidecarInfo.digest !== versionDigest) return reject('版本清单摘要与 sidecar 不符', versionEntry);
    const mismatches = consistencyProblems(inventory, parsedVersion.inventory, version);
    if (mismatches.length > 0) return reject(`根清单与版本清单不相符：${mismatches.join('；')}`, versionEntry);
    evidence.versionInventory = { path: versionEntry, present: true, digest: versionDigest,
      blob: (await addBlob(versionSource.bytes)).digest };
  }

  // 5. 依据清单把版本状态映射到内容：同一摘要只取一份内容，逻辑关系全部保留。
  const { files, problems, logicalPaths } = planVersion(inventory, contentDirectory, version);
  issues.push(...problems);
  coverage.expected = logicalPaths.length;
  const byDigest = new Map();
  for (const file of files) {
    if (!byDigest.has(file.digest)) byDigest.set(file.digest, { contentPath: file.contentPath, logicalPaths: [] });
    byDigest.get(file.digest).logicalPaths.push(file.logicalPath);
  }
  const fetched = [];
  for (const [digest, group] of byDigest) {
    let content;
    try { content = await fetchFile(group.contentPath); }
    catch {
      for (const logicalPath of group.logicalPaths) issues.push({ path: logicalPath, problem: `内容缺失：${group.contentPath}` });
      continue;
    }
    if (digestHex(algorithm, content.bytes) !== digest) {
      for (const logicalPath of group.logicalPaths) issues.push({ path: logicalPath, problem: `内容摘要与清单不符：${group.contentPath}` });
      continue;
    }
    const blob = await addBlob(content.bytes);
    fetched.push(group.contentPath);
    for (const logicalPath of group.logicalPaths) {
      records.push({ logicalPath, version, contentPath: group.contentPath, digest, blob: blob.digest, bytes: content.bytes.length });
    }
    evidence.relationships.push({ digest, contentPath: group.contentPath,
      contentVersion: group.contentPath.split('/')[0], logicalPaths: group.logicalPaths });
  }
  coverage.fetched = fetched;
  coverage.obtained = records.length;
  const obtained = new Set(records.map(record => record.logicalPath));
  coverage.missing = logicalPaths.filter(logicalPath => !obtained.has(logicalPath));

  const state = issues.length === 0 ? 'complete' : records.length > 0 ? 'partial' : 'rejected';
  return finish(state);
}
