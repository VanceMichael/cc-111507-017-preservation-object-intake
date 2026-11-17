import { receiveBytes } from './http-client.mjs';
import {
  OCFL_DECLARATION,
  compareInventories,
  planVersion,
  validateInventory,
  validateVersionName,
  verifyPlannedContent,
  verifySidecar,
} from './ocfl.mjs';

function fileUrl(sourceBase, resource) {
  return `${sourceBase}/files/${encodeURIComponent(resource)}`;
}

async function fetchEvidence(store, sourceBase, resource, evidence, issues, code, label) {
  try {
    const received = await receiveBytes(fileUrl(sourceBase, resource));
    const blob = await store.blob(received.bytes);
    evidence.push({ resource, role: label, digest: blob.digest, bytes: blob.bytes, sourceVersion: received.etag });
    return { bytes: received.bytes, etag: received.etag, blob };
  } catch (error) {
    issues.push({ code, resource, message: error.message });
    return null;
  }
}

/**
 * 结构化 OCFL 收件：校验清单身份与摘要，按指定版本 state 把逻辑路径映射到真实内容，
 * 只领取该版本引用的内容，共享内容只下载一份但保留全部逻辑/版本关系。
 */
export async function collectStructured({ input, descriptor, sourceBase, store }) {
  const issues = [];
  const evidence = [];
  let version = input.version || null;
  if (version !== null) {
    try {
      validateVersionName(version);
    } catch (error) {
      return { httpStatus: 400, error: error.message };
    }
  }

  const addIssue = (code, message, extra = {}) => issues.push({ code, message, ...extra });

  // OCFL 对象声明（NAMASTE）是对象身份的一部分，必须实际取得并核对。
  const declaration = await fetchEvidence(store, sourceBase, OCFL_DECLARATION, evidence, issues,
    'declaration-unavailable', 'ocfl-declaration');
  if (declaration && declaration.bytes.toString('utf8').trim() !== 'ocfl_object_1.1') {
    addIssue('declaration-invalid', 'OCFL 对象声明内容无效', { resource: OCFL_DECLARATION });
  }

  const rootResource = descriptor.entry;
  const rootSidecarResource = `${rootResource}.sha512`;
  const rootFetch = await fetchEvidence(store, sourceBase, rootResource, evidence, issues,
    'inventory-unavailable', 'root-inventory');
  const rootSidecarFetch = await fetchEvidence(store, sourceBase, rootSidecarResource, evidence, issues,
    'inventory-sidecar-unavailable', 'root-inventory-sidecar');

  if (!rootFetch) {
    return {
      receipt: await store.save(buildReceipt({ input, descriptor, state: 'rejected', records: [], issues, evidence,
        version: null, objectId: null, algorithm: null, fetchedContent: 0, logicalFileCount: 0, downloadedBytes: sumBytes(evidence) })),
    };
  }

  let root;
  try {
    root = validateInventory(rootFetch.bytes);
  } catch (error) {
    addIssue('inventory-invalid', error.message, { resource: rootResource });
    return {
      receipt: await store.save(buildReceipt({ input, descriptor, state: 'rejected', records: [], issues, evidence,
        version: null, objectId: null, algorithm: null, fetchedContent: 0, logicalFileCount: 0, downloadedBytes: sumBytes(evidence) })),
    };
  }

  if (rootSidecarFetch) {
    try {
      verifySidecar(root.algorithm, rootFetch.bytes, rootSidecarFetch.bytes, { expectedFilename: rootResource });
    } catch (error) {
      addIssue('inventory-digest-mismatch', error.message, { resource: rootSidecarResource });
    }
  }

  const selectedVersion = version || root.head;
  if (!root.versions.has(selectedVersion)) {
    return { httpStatus: 400, error: `指定版本不存在：${selectedVersion}` };
  }

  // 所选版本清单：每个版本目录都应有 inventory.json 及其 sidecar（head 版本也不例外）。
  // OCFL 要求版本清单与根清单字节一致；任何不相符都拒绝，不能静默采用其中一份。
  let versionInventory = null;
  const versionResource = `${selectedVersion}/inventory.json`;
  const versionSidecarResource = `${versionResource}.sha512`;
  const versionFetch = await fetchEvidence(store, sourceBase, versionResource, evidence, issues,
    'version-inventory-unavailable', 'version-inventory');
  const versionSidecarFetch = await fetchEvidence(store, sourceBase, versionSidecarResource, evidence, issues,
    'version-inventory-sidecar-unavailable', 'version-inventory-sidecar');
  if (!versionFetch) {
    return {
      receipt: await store.save(buildReceipt({ input, descriptor, state: 'rejected', records: [], issues, evidence,
        version: selectedVersion, objectId: root.id, algorithm: root.algorithm, fetchedContent: 0,
        logicalFileCount: 0, downloadedBytes: sumBytes(evidence) })),
    };
  }
  try {
    versionInventory = validateInventory(versionFetch.bytes, { expectedId: root.id });
  } catch (error) {
    addIssue('version-inventory-invalid', error.message, { resource: versionResource });
  }
  if (versionSidecarFetch) {
    try {
      verifySidecar(root.algorithm, versionFetch.bytes, versionSidecarFetch.bytes);
    } catch (error) {
      addIssue('version-inventory-digest-mismatch', error.message, { resource: versionSidecarResource });
    }
  }
  if (versionInventory) {
    const differences = compareInventories(root, versionInventory);
    if (differences.length > 0) {
      addIssue('version-inventory-mismatch', `根清单与版本清单不一致：${differences.join('、')}`, { resource: versionResource, fields: differences });
    }
  }
  if (!rootSidecarFetch) {
    addIssue('inventory-sidecar-missing', '根清单 sidecar 未能取得，无法核对清单摘要', { resource: rootSidecarResource });
  }
  if (!versionSidecarFetch) {
    addIssue('version-inventory-sidecar-missing', '版本清单 sidecar 未能取得，无法核对版本清单摘要', { resource: versionSidecarResource });
  }

  let plan;
  try {
    plan = planVersion(versionInventory || root, selectedVersion);
  } catch (error) {
    addIssue('version-state-invalid', error.message, { version: selectedVersion });
    return {
      receipt: await store.save(buildReceipt({ input, descriptor, state: 'rejected', records: [], issues, evidence,
        version: selectedVersion, objectId: root.id, algorithm: root.algorithm, fetchedContent: 0,
        logicalFileCount: 0, downloadedBytes: sumBytes(evidence) })),
    };
  }

  // 清单身份或内容摘要未通过核对时不得领取内容，避免把不可信字节当作可靠收件。
  const blockingCodes = ['declaration-unavailable', 'declaration-invalid', 'inventory-invalid',
    'inventory-digest-mismatch', 'inventory-sidecar-missing', 'version-state-invalid',
    'version-inventory-unavailable', 'version-inventory-mismatch', 'version-inventory-invalid',
    'version-inventory-digest-mismatch', 'version-inventory-sidecar-missing'];
  const blocking = issues.some(item => blockingCodes.includes(item.code));
  const records = [];
  let fetchedContent = 0;
  const contentCache = new Map();

  if (!blocking) {
    for (const item of plan) {
      let fetched = contentCache.get(item.digest);
      if (!fetched) {
        const contentResource = item.chosenContentPath;
        const result = await fetchEvidence(store, sourceBase, contentResource, evidence, issues,
          'content-unavailable', 'payload-content');
        if (!result) {
          const existing = issues.find(issue => issue.code === 'content-unavailable' && issue.resource === contentResource);
          if (existing) existing.logicalPaths = item.logicalPaths;
          for (const logicalPath of item.logicalPaths) {
            records.push(buildRecord({ root, version: selectedVersion, logicalPath, digest: item.digest,
              contentPath: contentResource, state: 'missing' }));
          }
          continue;
        }
        try {
          verifyPlannedContent(versionInventory || root, item, contentResource, result.bytes);
        } catch (error) {
          addIssue('content-digest-mismatch', error.message, { resource: contentResource });
          for (const logicalPath of item.logicalPaths) {
            records.push(buildRecord({ root, version: selectedVersion, logicalPath, digest: item.digest,
              contentPath: contentResource, state: 'rejected' }));
          }
          continue;
        }
        fetched = { resource: contentResource, blob: result.blob, etag: result.etag };
        contentCache.set(item.digest, fetched);
        fetchedContent += 1;
      }
      // 同一内容被多个逻辑路径复用时，每条逻辑路径都是独立记录，但共享同一个 blob。
      for (const logicalPath of item.logicalPaths) {
        records.push(buildRecord({ root, version: selectedVersion, logicalPath, digest: item.digest,
          contentPath: fetched.resource, state: 'reliable', blob: fetched.blob, etag: fetched.etag }));
      }
    }
  } else {
    for (const item of plan) {
      for (const logicalPath of item.logicalPaths) {
        records.push(buildRecord({ root, version: selectedVersion, logicalPath, digest: item.digest,
          contentPath: item.chosenContentPath, state: 'blocked' }));
      }
    }
  }

  const logicalFileCount = records.length;
  const reliableCount = records.filter(record => record.state === 'reliable').length;
  // 清单身份不可信时整体拒绝；清单可信但来源缺内容/摘要不符为部分收件；全部可靠才为完整。
  const state = blocking
    ? 'rejected'
    : (reliableCount === logicalFileCount ? 'complete' : 'partial');
  const manifestContentCount = root.manifest.size;
  const coverage = {
    structured: true,
    objectId: root.id,
    requestedVersion: input.version || null,
    selectedVersion,
    head: root.head,
    digestAlgorithm: root.algorithm,
    contentDirectory: root.contentDirectory,
    logicalFileCount,
    reliableCount,
    distinctContentRequired: plan.length,
    distinctContentFetched: fetchedContent,
    manifestContentCount,
    historicalContentExcluded: manifestContentCount - plan.length,
    downloadedBytes: sumBytes(evidence),
  };

  return {
    receipt: await store.save(buildReceipt({ input, descriptor, state, records, issues, evidence,
      version: selectedVersion, objectId: root.id, algorithm: root.algorithm,
      fetchedContent, logicalFileCount, downloadedBytes: coverage.downloadedBytes, coverage })),
  };
}

function buildRecord({ root, version, logicalPath, digest, contentPath, state, blob = null, etag = null }) {
  const record = {
    recordId: `${root.id}:${version}:${logicalPath}`,
    objectId: root.id,
    version,
    logicalPath,
    state,
    content: {
      digestAlgorithm: root.algorithm,
      digest,
      contentPath,
      blob: blob ? { digest: blob.digest, bytes: blob.bytes } : null,
      sourceVersion: etag,
    },
  };
  return record;
}

function buildReceipt({ input, descriptor, state, records, issues, evidence, version, objectId, algorithm,
  fetchedContent, logicalFileCount, downloadedBytes, coverage = null }) {
  return {
    mode: 'structured',
    state,
    product: descriptor.product,
    source: descriptor.entry,
    sourceScenario: descriptor.id,
    objectId,
    version,
    digestAlgorithm: algorithm,
    records,
    issues,
    evidence,
    blobs: [...new Map(evidence.filter(item => item.digest).map(item => [item.digest, { digest: item.digest, bytes: item.bytes }])).values()],
    coverage: coverage || {
      structured: true,
      objectId,
      requestedVersion: input.version || null,
      selectedVersion: version,
      logicalFileCount,
      reliableCount: records.filter(record => record.state === 'reliable').length,
      distinctContentFetched: fetchedContent,
      downloadedBytes,
    },
  };
}

function sumBytes(evidence) {
  return evidence.reduce((total, item) => total + (item.bytes || 0), 0);
}
