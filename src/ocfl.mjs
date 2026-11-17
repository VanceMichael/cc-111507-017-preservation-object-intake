import { createHash } from 'node:crypto';

// 本项目承诺的 OCFL 范围见 docs/来源格式.md：sha256/sha512 清单摘要、
// sidecar 覆盖清单原始字节、逻辑/物理路径不得越出对象根。
export const DIGEST_HEX_LENGTH = { sha256: 64, sha512: 128 };
export const INVENTORY_TYPE = 'https://ocfl.io/1.1/spec/#inventory';
export const DEFAULT_CONTENT_DIRECTORY = 'content';

// 对象内相对路径校验：不允许绝对形式、空组件、. 或 .. 组件。
// 返回问题描述；路径可用时返回 null。
export function pathProblem(path) {
  if (typeof path !== 'string' || path.length === 0) return '路径为空';
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)) return '路径为绝对形式';
  const parts = path.split('/');
  if (parts.some(part => part.length === 0)) return '路径含空组件';
  if (parts.some(part => part === '.' || part === '..')) return '路径含越界组件';
  return null;
}

// sidecar 内容形如 "<hex摘要> <文件名>"（允许单独一行摘要）。
export function parseSidecar(bytes) {
  const text = bytes.toString('utf8').trim();
  const match = /^([0-9A-Fa-f]+)(?:\s+\*?(\S.*))?$/.exec(text);
  if (!match) return { problem: 'sidecar 内容无法解析' };
  return { digest: match[1].toLowerCase(), name: match[2] ? match[2].trim() : null };
}

export function digestHex(algorithm, bytes) {
  return createHash(algorithm).update(bytes).digest('hex');
}

// 解析并校验清单结构；失败返回 { problem }，成功返回 { inventory, contentDirectory }。
export function parseInventory(bytes) {
  let inventory;
  try { inventory = JSON.parse(bytes.toString('utf8')); }
  catch { return { problem: '清单不是可解析的 JSON' }; }
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) return { problem: '清单结构无效' };
  if (inventory.type !== INVENTORY_TYPE) return { problem: '清单类型不是 OCFL 1.1 inventory' };
  if (typeof inventory.id !== 'string' || inventory.id.length === 0) return { problem: '清单缺少对象标识' };
  if (!DIGEST_HEX_LENGTH[inventory.digestAlgorithm]) return { problem: `不支持的清单摘要算法：${String(inventory.digestAlgorithm)}` };
  if (typeof inventory.head !== 'string' || !/^v[1-9]\d*$/.test(inventory.head)) return { problem: '清单 head 版本无效' };
  if (!inventory.versions || typeof inventory.versions !== 'object' || Array.isArray(inventory.versions)) return { problem: '清单缺少版本表' };
  if (!inventory.manifest || typeof inventory.manifest !== 'object' || Array.isArray(inventory.manifest)) return { problem: '清单缺少内容清单' };
  const contentDirectory = inventory.contentDirectory ?? DEFAULT_CONTENT_DIRECTORY;
  const directoryProblem = pathProblem(contentDirectory);
  if (directoryProblem || contentDirectory.includes('/')) return { problem: `内容目录无效：${directoryProblem ?? '内容目录含路径分隔符'}` };
  return { inventory, contentDirectory };
}

function normalizedMapping(mapping) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return null;
  const normalized = {};
  for (const key of Object.keys(mapping).sort()) {
    const value = mapping[key];
    normalized[key] = Array.isArray(value) ? [...value].sort() : value;
  }
  return normalized;
}

// 根清单与所选版本清单必须相符；返回不一致之处列表（空数组表示一致）。
export function consistencyProblems(rootInventory, versionInventory, version) {
  const problems = [];
  if (versionInventory.id !== rootInventory.id) problems.push('对象标识不一致');
  if (versionInventory.digestAlgorithm !== rootInventory.digestAlgorithm) problems.push('摘要算法不一致');
  const rootDirectory = rootInventory.contentDirectory ?? DEFAULT_CONTENT_DIRECTORY;
  const versionDirectory = versionInventory.contentDirectory ?? DEFAULT_CONTENT_DIRECTORY;
  if (versionDirectory !== rootDirectory) problems.push('内容目录不一致');
  if (versionInventory.head !== version) problems.push(`版本清单 head 为 ${versionInventory.head}，与所选版本 ${version} 不符`);
  const rootState = rootInventory.versions?.[version]?.state;
  const versionState = versionInventory.versions?.[version]?.state;
  if (JSON.stringify(normalizedMapping(rootState)) !== JSON.stringify(normalizedMapping(versionState))) problems.push('版本状态与根清单不一致');
  for (const digest of Object.keys(rootState ?? {})) {
    const rootPaths = normalizedMapping({ digest: rootInventory.manifest?.[digest] });
    const versionPaths = normalizedMapping({ digest: versionInventory.manifest?.[digest] });
    if (JSON.stringify(rootPaths) !== JSON.stringify(versionPaths)) problems.push('内容映射与根清单不一致');
  }
  return problems;
}

// 内容路径必须形如 v<编号>/<内容目录>/...，且编号不超过所选版本
// （一个版本只能引用本版本或更早版本引入的内容）。
function contentPathUsable(path, contentDirectory, versionNumber) {
  if (pathProblem(path)) return false;
  const parts = path.split('/');
  if (parts.length < 3) return false;
  const match = /^v([1-9]\d*)$/.exec(parts[0]);
  if (!match || Number(match[1]) > versionNumber) return false;
  return parts[1] === contentDirectory;
}

// 依据清单为指定版本生成领取计划：逻辑路径 -> 摘要 -> 唯一内容副本。
// 返回 files（每个可领取逻辑文件一条）、problems（可定位问题）及 logicalPaths（版本状态列出的全部逻辑路径）。
export function planVersion(inventory, contentDirectory, version) {
  const state = inventory.versions[version]?.state;
  const files = [];
  const problems = [];
  const logicalPaths = [];
  const hexLength = DIGEST_HEX_LENGTH[inventory.digestAlgorithm];
  const digestPattern = new RegExp(`^[0-9a-f]{${hexLength}}$`);
  const versionNumber = Number(version.slice(1));
  for (const [digest, paths] of Object.entries(state)) {
    const listed = Array.isArray(paths) ? paths : [];
    for (const logicalPath of listed) {
      logicalPaths.push(logicalPath);
      const problem = pathProblem(logicalPath);
      if (problem) { problems.push({ path: String(logicalPath), problem: `逻辑路径越出对象边界：${problem}` }); continue; }
      if (!digestPattern.test(digest)) { problems.push({ path: logicalPath, problem: '版本状态摘要格式无效' }); continue; }
      const candidates = (Array.isArray(inventory.manifest[digest]) ? inventory.manifest[digest] : [])
        .filter(path => contentPathUsable(path, contentDirectory, versionNumber));
      if (candidates.length === 0) { problems.push({ path: logicalPath, problem: '清单未给出有效内容位置' }); continue; }
      files.push({ logicalPath, digest, contentPath: candidates[0] });
    }
  }
  return { files, problems, logicalPaths };
}
