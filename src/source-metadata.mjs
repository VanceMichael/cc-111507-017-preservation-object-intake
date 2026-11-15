function parseJson(bytes) { try { return JSON.parse(bytes.toString()); } catch { return null; } }
export function inspect(bytes) { const value = parseJson(bytes); return { format: 'OCFL', objectId: value?.id || null, head: value?.head || null, digestAlgorithm: value?.digestAlgorithm || null }; }
