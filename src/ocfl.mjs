import { createHash } from 'node:crypto';

export const OCFL_DECLARATION = '0=ocfl_object_1.1';
const OCFL_INVENTORY_TYPE = 'https://ocfl.io/1.1/spec/#inventory';
const VERSION_PATTERN = /^v\d+$/;
const DIGEST_LENGTHS = { sha256: 64, sha512: 128 };
export const SUPPORTED_DIGEST_ALGORITHMS = Object.keys(DIGEST_LENGTHS);

export function digestBytes(algorithm, bytes) {
  if (!SUPPORTED_DIGEST_ALGORITHMS.includes(algorithm)) throw new Error(`不支持的摘要算法：${algorithm}`);
  return createHash(algorithm).update(bytes).digest('hex');
}

export function isDigest(value, algorithm) {
  return typeof value === 'string' && new RegExp(`^[0-9a-f]{${DIGEST_LENGTHS[algorithm]}}$`).test(value);
}

export function parseSidecar(algorithm, bytes) {
  const text = bytes.toString('utf8').trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 2 || !isDigest(parts[0], algorithm)) throw new Error('清单 sidecar 摘要格式无效');
  return { digest: parts[0].toLowerCase(), filename: parts[1] };
}

/**
 * 校验清单 sidecar：摘要长度/算法匹配、覆盖原始清单字节、且必须声明同目录 inventory.json。
 */
export function verifySidecar(algorithm, inventoryBytes, sidecarBytes, { expectedFilename = 'inventory.json' } = {}) {
  const parsed = parseSidecar(algorithm, sidecarBytes);
  if (parsed.filename !== expectedFilename) throw new Error(`清单 sidecar 声明的文件名无效：${parsed.filename}`);
  const actual = digestBytes(algorithm, inventoryBytes);
  if (actual !== parsed.digest) throw new Error('清单 sidecar 摘要与原始清单字节不符');
  return parsed;
}

function splitVirtualPath(resource) {
  if (typeof resource !== 'string' || resource.length === 0) throw new Error('路径为空');
  if (resource.startsWith('/') || resource.startsWith('\\')) throw new Error(`路径不允许为绝对路径：${resource}`);
  const components = resource.split('/');
  if (components.some(part => part === '' || part === '.' || part === '..' || part === '\\')) {
    throw new Error(`路径包含空组件、当前目录或父目录引用：${resource}`);
  }
  if (components.some(part => /[\\\x00]/.test(part))) throw new Error(`路径包含非法字符：${resource}`);
  return components;
}

/**
 * 虚拟对象根边界检查：拒绝绝对路径、空/点号组件以及规范化后越出对象根的路径。
 * 只处理相对资源名，不触碰宿主机文件系统。
 */
export function ensureInsideObjectRoot(resource) {
  const components = splitVirtualPath(resource);
  const depth = components.reduce((level, part) => level + (part === '..' ? -1 : 1), 0);
  if (depth <= 0) throw new Error(`路径越出对象边界：${resource}`);
  return components.join('/');
}

export function validateVersionName(version) {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) throw new Error(`版本号无效：${version}`);
  return version;
}

/**
 * 解析并校验 OCFL 1.1 清单结构与路径安全，返回规范化后的清单数据。
 */
export function validateInventory(bytes, { expectedId = null } = {}) {
  let inventory;
  try {
    inventory = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('清单不是有效的 JSON 文档');
  }
  if (inventory === null || typeof inventory !== 'object' || Array.isArray(inventory)) throw new Error('清单结构无效');
  if (inventory.type !== OCFL_INVENTORY_TYPE) throw new Error('清单 type 不是受支持的 OCFL 1.1 inventory');
  if (typeof inventory.id !== 'string' || inventory.id.length === 0) throw new Error('清单缺少对象 id');
  if (expectedId !== null && inventory.id !== expectedId) throw new Error('版本清单与根清单的对象 id 不一致');
  const algorithm = inventory.digestAlgorithm;
  if (!SUPPORTED_DIGEST_ALGORITHMS.includes(algorithm)) throw new Error(`不支持的清单摘要算法：${algorithm}`);
  validateVersionName(inventory.head);
  if (inventory.contentDirectory !== undefined) {
    if (typeof inventory.contentDirectory !== 'string' || /[/\\]/.test(inventory.contentDirectory)
      || ['', '.', '..'].includes(inventory.contentDirectory)) {
      throw new Error(`非默认内容目录名称无效：${inventory.contentDirectory}`);
    }
  }
  const contentDirectory = inventory.contentDirectory || 'content';
  if (!inventory.manifest || typeof inventory.manifest !== 'object' || Array.isArray(inventory.manifest)) throw new Error('清单缺少 manifest');
  if (!inventory.versions || typeof inventory.versions !== 'object' || Array.isArray(inventory.versions)) throw new Error('清单缺少 versions');
  if (!inventory.versions[inventory.head]) throw new Error(`清单 head 版本不存在：${inventory.head}`);

  const manifest = new Map();
  for (const [digest, paths] of Object.entries(inventory.manifest)) {
    if (!isDigest(digest, algorithm)) throw new Error(`manifest 摘要不是合法的 ${algorithm} 摘要：${digest}`);
    if (!Array.isArray(paths) || paths.length === 0) throw new Error(`manifest 条目缺少内容路径：${digest}`);
    const safePaths = paths.map(path => {
      const safe = ensureInsideObjectRoot(path);
      const [version, directory] = safe.split('/');
      if (!VERSION_PATTERN.test(version) || directory !== contentDirectory) {
        throw new Error(`manifest 内容路径不符合版本/内容目录布局：${safe}`);
      }
      return safe;
    });
    manifest.set(digest.toLowerCase(), safePaths);
  }

  const versions = new Map();
  for (const [version, entry] of Object.entries(inventory.versions)) {
    validateVersionName(version);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !entry.state
      || typeof entry.state !== 'object' || Array.isArray(entry.state)) {
      throw new Error(`版本 ${version} 缺少 state`);
    }
    const state = new Map();
    for (const [digest, logicalPaths] of Object.entries(entry.state)) {
      if (!isDigest(digest, algorithm)) throw new Error(`版本 ${version} 的 state 摘要无效：${digest}`);
      if (!Array.isArray(logicalPaths) || logicalPaths.length === 0) throw new Error(`版本 ${version} 的 state 条目缺少逻辑路径`);
      const safeLogical = logicalPaths.map(path => ensureInsideObjectRoot(path));
      if (new Set(safeLogical).size !== safeLogical.length) throw new Error(`版本 ${version} 存在重复逻辑路径`);
      state.set(digest.toLowerCase(), safeLogical);
    }
    versions.set(version, { created: entry.created || null, state });
  }
  return { id: inventory.id, algorithm, head: inventory.head, contentDirectory, manifest, versions, raw: inventory };
}

/**
 * 比较两份清单的身份与内容字段。OCFL 要求版本清单与根清单字节一致；
 * 字节不同但语义字段相符时也按不一致处理，绝不静默采用其中一份。
 */
export function compareInventories(root, versionInventory) {
  const differences = [];
  const fields = ['id', 'algorithm', 'head', 'contentDirectory', 'type'];
  for (const field of fields) {
    if (root[field] !== versionInventory[field]) differences.push(field);
  }
  const rootManifest = JSON.stringify(root.raw.manifest);
  const versionManifest = JSON.stringify(versionInventory.raw.manifest);
  if (rootManifest !== versionManifest) differences.push('manifest');
  if (JSON.stringify(root.raw.versions) !== JSON.stringify(versionInventory.raw.versions)) differences.push('versions');
  return differences;
}

/**
 * 依据指定版本 state 生成领取计划：逻辑路径 -> 真实内容路径，
 * 同一摘要在多个逻辑路径/历史版本间复用的关系完整保留，未被该版本引用的内容不进入计划。
 */
export function planVersion(intake, version) {
  validateVersionName(version);
  const versionEntry = intake.versions.get(version);
  if (!versionEntry) throw new Error(`指定版本不存在：${version}`);
  const plan = [];
  for (const [digest, logicalPaths] of versionEntry.state) {
    const contentPaths = intake.manifest.get(digest);
    if (!contentPaths) throw new Error(`版本 ${version} 引用的摘要在 manifest 中没有内容：${digest}`);
    plan.push({ digest, logicalPaths, contentPaths, chosenContentPath: contentPaths[0] });
  }
  return plan;
}

/**
 * 校验已下载内容字节的摘要，并确认该路径确实是清单允许的 manifest 副本。
 */
export function verifyPlannedContent(intake, planItem, contentPath, bytes) {
  if (!planItem.contentPaths.includes(contentPath)) throw new Error(`内容路径不在 manifest 允许的副本中：${contentPath}`);
  const actual = digestBytes(intake.algorithm, bytes);
  if (actual !== planItem.digest) throw new Error(`内容摘要不符：${contentPath}`);
  return actual;
}
