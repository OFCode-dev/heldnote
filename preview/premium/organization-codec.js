// Experimental snapshot codec only. No IO, storage, production imports or merge.
export const ORGANIZATION_FORMAT = 'heldnote-organization-snapshot';
export const ORGANIZATION_VERSION = 1;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = value => typeof value === 'number' && Number.isFinite(value);
const nonempty = value => typeof value === 'string' && value.length > 0;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
function parse(source) {
  if (typeof source !== 'string') fail('invalid-json', 'Expected JSON text.');
  try { return JSON.parse(source); } catch { fail('invalid-json', 'Invalid JSON text.'); }
}
function fields(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('unsupported-field', 'Unknown organization fields require a format revision.');
}
function records(values, label, check) {
  if (!Array.isArray(values)) fail('invalid-organization', `${label} must be an array.`);
  const ids = new Set();
  for (const value of values) {
    check(value);
    if (ids.has(value.id)) fail('duplicate-id', `Duplicate ${label} identifier.`);
    ids.add(value.id);
  }
  return ids;
}

// Matches the known v1 backup record requirements, without rewriting any part
// of the original string. This is not a replacement for store.importAll().
function legacyBackup(source) {
  const data = parse(source);
  if (!object(data) || 'syncFormat' in data || 'format' in data) fail('invalid-backup', 'Expected a legacy note backup, not a Drive/preview document.');
  if (data.schemaVersion !== 1) fail('unsupported-backup-version', 'Only backup schema 1 is understood by this experiment.');
  if (!Array.isArray(data.notes) || !Array.isArray(data.versions) ||
      (data.meta !== undefined && !Array.isArray(data.meta))) fail('invalid-backup', 'Missing backup record arrays.');
  const noteIds = new Set();
  for (const n of data.notes) {
    if (!object(n) || !nonempty(n.id) || typeof n.title !== 'string' || typeof n.text !== 'string' ||
        !number(n.createdAt) || !number(n.updatedAt) || !number(n.localRev) || typeof n.pinned !== 'boolean' ||
        !(n.deletedAt === undefined || n.deletedAt === null || number(n.deletedAt))) fail('invalid-backup', 'Invalid legacy note.');
    if (noteIds.has(n.id)) fail('duplicate-id', 'Duplicate legacy note identifier.');
    noteIds.add(n.id);
  }
  const versionKeys = new Map();
  for (const v of data.versions) {
    if (!object(v) || !nonempty(v.noteId) || !number(v.seq) || !number(v.at) ||
        !number(v.sourceRev) || typeof v.text !== 'string') fail('invalid-backup', 'Invalid legacy history record.');
    if (!noteIds.has(v.noteId)) fail('orphan-history', 'History references an absent note.');
    const sequences = versionKeys.get(v.noteId) ?? new Set();
    if (sequences.has(v.seq)) fail('duplicate-id', 'Duplicate legacy history key.');
    sequences.add(v.seq); versionKeys.set(v.noteId, sequences);
  }
  for (const entry of data.meta ?? []) {
    if (!object(entry) || !nonempty(entry.key)) fail('invalid-backup', 'Invalid legacy settings record.');
  }
  return noteIds;
}

function organization(value, noteIds) {
  fields(value, ['collections', 'templates', 'memberships']);
  const name = (item, max) => nonempty(item) && item.trim().length > 0 && item.length <= max;
  const validId = item => nonempty(item) && item.length <= 200;
  const collectionIds = records(value.collections, 'collection', c => {
    fields(c, ['id', 'name']);
    if (!validId(c.id) || !name(c.name, 120)) fail('invalid-organization', 'Invalid collection.');
  });
  records(value.templates, 'template', t => {
    fields(t, ['id', 'name', 'text']);
    if (!validId(t.id) || !name(t.name, 120) || typeof t.text !== 'string' || t.text.length > 50_000) fail('invalid-organization', 'Invalid template.');
  });
  if (!Array.isArray(value.memberships)) fail('invalid-organization', 'Memberships must be an array.');
  const assigned = new Set();
  for (const m of value.memberships) {
    fields(m, ['noteId', 'collectionId']);
    if (!nonempty(m.noteId) || !validId(m.collectionId)) fail('invalid-organization', 'Invalid membership.');
    if (assigned.has(m.noteId)) fail('duplicate-membership', 'A note can have at most one collection in this draft.');
    if (!noteIds.has(m.noteId) || !collectionIds.has(m.collectionId)) fail('orphan-membership', 'Membership references an absent note or collection.');
    assigned.add(m.noteId);
  }
}

export function decodeOrganizationSnapshot(source) {
  const value = parse(source);
  if (!object(value) || value.format !== ORGANIZATION_FORMAT) fail('unsupported-format', 'Not an organization snapshot.');
  if (value.version !== ORGANIZATION_VERSION) fail('unsupported-version', 'Unknown organization snapshot version.');
  fields(value, ['format', 'version', 'backupJson', 'organization']);
  const noteIds = legacyBackup(value.backupJson);
  organization(value.organization, noteIds);
  return value; // JSON.parse created fresh values; caller inputs are never mutated.
}

export function encodeOrganizationSnapshot(backupJson, metadata) {
  // Serializing first snapshots the caller's plain JSON values without mutation.
  const source = JSON.stringify({ format: ORGANIZATION_FORMAT, version: ORGANIZATION_VERSION,
    backupJson, organization: metadata });
  decodeOrganizationSnapshot(source);
  return source;
}

export function assertSnapshotForBackup(source, targetBackupJson) {
  const snapshot = decodeOrganizationSnapshot(source);
  legacyBackup(targetBackupJson);
  if (snapshot.backupJson !== targetBackupJson) fail('snapshot-mismatch', 'Snapshot belongs to different backup bytes; no automatic rebind or merge is defined.');
  return snapshot;
}
