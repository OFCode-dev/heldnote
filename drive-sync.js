// drive-sync.js — OAuth and Google Drive transport for Heldnote.
//
// Design constraints, in the spirit of the product's promises:
// - This module only transports files. sync.js owns two-way merging; legacy
//   backup helpers remain available for migration. Local notes live in store.js.
// - Everything runs in the browser against Drive's appDataFolder — an
//   app-scoped hidden folder (scope drive.appdata), so Heldnote never sees
//   the user's real Drive contents and needs no server.
// - The short-lived OAuth token is cached in localStorage across reloads.
//   Authentication never changes the note database.
//
// The whole feature is inert until constants.js sets GOOGLE_DRIVE_CLIENT_ID.

import { GOOGLE_DRIVE_CLIENT_ID } from './constants.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

const BACKUP_FILE_NAME = 'heldnote-backup.json';
const SYNC_FILE_NAME = 'heldnote-sync.json';
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const CONNECTED_KEY = 'heldnote-drive-connected';
const LAST_BACKUP_KEY = 'heldnote-drive-last-backup';
const LAST_ERROR_KEY = 'heldnote-drive-last-error';
const TOKEN_KEY = 'heldnote-drive-token';
let accessToken = null;
let tokenExpiresAt = 0;
let gisLoadPromise = null;
let pendingTokenRequest = null;
let authGeneration = 0;

// The access token survives reloads (~1h lifetime). Without this, every page
// load forgot the session and every backup/restore marched the user through
// Google's account chooser again. Scope is drive.appdata only (an app-private
// folder). Any script on this origin can read this cache and the note database;
// advertising must be isolated from the note-storage origin.
try {
  const stored = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
  if (stored && typeof stored.token === 'string' && Number.isFinite(stored.expiresAt) && stored.expiresAt > Date.now() + 60_000) {
    accessToken = stored.token;
    tokenExpiresAt = stored.expiresAt;
  }
} catch (e) { /* fall through to a fresh sign-in */ }

function persistToken() {
  try { localStorage.setItem(TOKEN_KEY, JSON.stringify({ token: accessToken, expiresAt: tokenExpiresAt })); } catch (e) { /* non-fatal */ }
}

function clearToken() {
  accessToken = null;
  tokenExpiresAt = 0;
  try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* non-fatal */ }
}

export function isConfigured() {
  return typeof GOOGLE_DRIVE_CLIENT_ID === 'string' && GOOGLE_DRIVE_CLIENT_ID.length > 0;
}

export function isConnected() {
  try { return localStorage.getItem(CONNECTED_KEY) === '1'; } catch (e) { return false; }
}

export function lastBackupAt() {
  try {
    const value = Number(localStorage.getItem(LAST_BACKUP_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch (e) { return null; }
}

// A failure that happened AFTER the last successful backup must survive a
// reload: QA found the footer cheerfully showing an old "Last backup" time
// while every attempt since had failed — a user would believe they are
// backed up when they are not.
export function lastFailure() {
  try {
    const stored = JSON.parse(localStorage.getItem(LAST_ERROR_KEY) || 'null');
    if (!stored || !Number.isFinite(stored.at)) return null;
    const backupAt = lastBackupAt();
    return backupAt && backupAt >= stored.at ? null : stored;
  } catch (e) { return null; }
}

export function recordFailure(code) {
  try { localStorage.setItem(LAST_ERROR_KEY, JSON.stringify({ at: Date.now(), code: String(code || 'unknown') })); } catch (e) { /* non-fatal */ }
}

function setConnected(flag) {
  try {
    if (flag) localStorage.setItem(CONNECTED_KEY, '1');
    else localStorage.removeItem(CONNECTED_KEY);
  } catch (e) { /* cosmetic only */ }
}

function gisReady() {
  return typeof window.google?.accounts?.oauth2?.initTokenClient === 'function';
}

function loadGis() {
  if (gisReady()) return Promise.resolve();
  if (gisLoadPromise) return gisLoadPromise;
  gisLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    let settled = false;
    const watchdog = setTimeout(() => finish(false), 15_000);
    function finish(ok) {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      script.onload = script.onerror = null;
      if (ok) resolve();
      else {
        script.remove();
        gisLoadPromise = null;
        reject(driveError('network', 'Google script failed to load'));
      }
    }
    script.onload = () => finish(gisReady());
    script.onerror = () => finish(false);
    document.head.appendChild(script);
  });
  return gisLoadPromise;
}

function driveError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

// Resolves with a usable access token, prompting for consent only when Google
// requires it (first connect, revoked access, expired session).
async function getToken({ silent = false } = {}) {
  if (!isConfigured()) throw driveError('not-configured', 'Drive client id is not set');
  if (accessToken && Date.now() < tokenExpiresAt - 30_000) {
    return accessToken;
  }
  // prompt: '' still uses a popup. Background work must not enter GIS at all.
  if (silent) throw driveError('auth-needed', 'sign in to resume sync');
  const generation = authGeneration;
  // Avoid yielding the click gesture when the library is already available.
  if (!gisReady()) await loadGis();
  if (generation !== authGeneration) throw driveError('auth-needed', 'disconnected during sign-in');
  if (pendingTokenRequest) return pendingTokenRequest.promise;
  if (navigator.userActivation && !navigator.userActivation.isActive) {
    throw driveError('auth-retry', 'sign-in is ready; click again to open Google');
  }
  const request = { promise: null, cancel: null };
  pendingTokenRequest = request;
  request.promise = new Promise((resolve, reject) => {
    // A connect attempt must always settle: QA found "Connecting…" pinned on
    // screen for 90+ seconds with the button disabled, because a blocked
    // popup produces neither callback. error_callback catches the blocked/
    // closed popup cases GIS does report; the watchdog catches everything it
    // does not.
    let settled = false;
    const watchdog = setTimeout(() => {
      finishReject(driveError('timeout', 'no response from Google sign-in'));
    }, 60_000);
    function finishResolve(value) {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      if (pendingTokenRequest === request) pendingTokenRequest = null;
      resolve(value);
    }
    function finishReject(error) {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      if (pendingTokenRequest === request) pendingTokenRequest = null;
      reject(error);
    }
    request.cancel = () => finishReject(driveError('auth-needed', 'disconnected during sign-in'));
    const callback = (response) => {
      // Google may answer after our timeout or after an explicit disconnect.
      // Such a response must not resurrect a token or record a grant.
      if (settled) return;
      if (response && response.error) {
        finishReject(driveError(response.error === 'access_denied' ? 'consent-denied' : 'auth-failed', response.error));
        return;
      }
      const lifetime = Number(response && response.expires_in);
      if (!response || typeof response.access_token !== 'string' || !response.access_token.trim()
          || !Number.isFinite(lifetime) || lifetime <= 0) {
        finishReject(driveError('auth-failed', 'Google returned an invalid token response'));
        return;
      }
      if (typeof response.scope !== 'string' || !response.scope.split(/\s+/).includes(SCOPE)) {
        finishReject(driveError('consent-denied', 'Drive permission was not granted'));
        return;
      }
      accessToken = response.access_token;
      tokenExpiresAt = Date.now() + lifetime * 1000;
      persistToken();
      finishResolve(accessToken);
    };
    const errorCallback = (error) => {
      const type = error && error.type;
      if (type === 'popup_failed_to_open') finishReject(driveError('popup-blocked', 'sign-in popup was blocked'));
      else if (type === 'popup_closed') finishReject(driveError('consent-denied', 'sign-in popup was closed'));
      else finishReject(driveError('auth-failed', String(type || error)));
    };
    try {
      // Both callbacks belong to this attempt and are supplied through the
      // documented configuration, rather than mutating a shared client.
      const tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_DRIVE_CLIENT_ID,
        scope: SCOPE,
        callback,
        error_callback: errorCallback,
      });
      // Google knows whether this account already granted access. A browser's
      // missing/stale marker cannot tell us that. Never force repeat consent;
      // first-time or revoked access will still receive Google's own prompt.
      tokenClient.requestAccessToken({ prompt: '' });
    } catch (error) {
      finishReject(driveError('auth-failed', String(error)));
    }
  });
  return request.promise;
}

async function driveFetch(token, url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    });
  } catch (error) {
    throw driveError('network', String(error));
  }
  if (response.status === 401) throw driveError('auth-expired', 'token rejected');
  if (!response.ok) throw driveError('drive-failed', `HTTP ${response.status}`);
  return response;
}

async function findBackupFile(token) {
  const query = encodeURIComponent(`name='${BACKUP_FILE_NAME}' and trashed=false`);
  const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${query}&fields=files(id,modifiedTime)&orderBy=modifiedTime desc`;
  const response = await driveFetch(token, url);
  const data = await response.json();
  return data.files && data.files.length > 0 ? data.files[0] : null;
}

// Runs `work(token)`, transparently re-authenticating once if the cached
// token turns out to be stale — without re-prompting an already-consented
// user (prompt: '').

export async function withToken(work, { silent = false } = {}) {
  let token = await getToken({ silent });
  try {
    return await work(token);
  } catch (error) {
    if (error && error.code === 'auth-expired') {
      clearToken();
      // In silent (background) mode a re-auth could pop UI mid-typing; give
      // up quietly instead — the next manual action re-authenticates.
      if (silent) throw driveError('auth-needed', 'token expired during background upload');
      token = await getToken();
      return work(token);
    }
    throw error;
  }
}

export async function connect() {
  const generation = authGeneration;
  await getToken();
  if (generation !== authGeneration) throw driveError('auth-needed', 'disconnected during sign-in');
  setConnected(true);
}

export function disconnect() {
  authGeneration++;
  if (pendingTokenRequest) pendingTokenRequest.cancel();
  const token = accessToken;
  clearToken();
  setConnected(false);
  // Remove the obsolete local consent marker. Google owns the actual grant.
  try { localStorage.removeItem('heldnote-drive-granted'); } catch (e) { /* cosmetic */ }
  // Best-effort revoke; local state is already cleared either way.
  if (token && window.google && window.google.accounts && window.google.accounts.oauth2) {
    try { window.google.accounts.oauth2.revoke(token, () => {}); } catch (e) { /* best effort */ }
  }
}


async function listNamedFiles(token, name, fields) {
  const files = [];
  let pageToken = null;
  do {
    const query = encodeURIComponent(`name='${name}' and trashed=false`);
    const page = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
    const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${query}&pageSize=1000&fields=nextPageToken,files(${fields})${page}`;
    const response = await driveFetch(token, url);
    const data = await response.json();
    if (Array.isArray(data.files)) files.push(...data.files);
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return files;
}

// Drive occasionally leaves duplicate appData files after an interrupted
// create. Sync must see every copy: choosing only the newest can discard a
// device's last successful snapshot before the union phase has read it.
export function listAllSyncFiles(token) {
  return listNamedFiles(token, SYNC_FILE_NAME, 'id,headRevisionId');
}

export async function downloadSyncFileText(token, fileId) {
  const response = await driveFetch(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`);
  return response.text();
}

export async function uploadSyncFile(token, blob, { existingFileId, knownHeadRevisionId } = {}) {
  if (existingFileId) {
    // Drive has no media compare-and-swap. Re-reading the revision immediately
    // before PATCH is the narrowest guard available; the coordinator treats a
    // mismatch as a signal to download and merge again.
    const metadataResponse = await driveFetch(
      token,
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(existingFileId)}?fields=id,headRevisionId`,
    );
    const metadata = await metadataResponse.json();
    if (
      knownHeadRevisionId
      && metadata.headRevisionId
      && metadata.headRevisionId !== knownHeadRevisionId
    ) {
      throw driveError('revision-mismatch', 'Drive file changed since download');
    }

    const response = await driveFetch(
      token,
      `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existingFileId)}?uploadType=media&fields=id,headRevisionId`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: blob,
      },
    );
    const result = await response.json();
    if (!result.headRevisionId) {
      throw driveError('drive-failed', 'Drive did not return a revision after upload');
    }
    return { fileId: result.id || existingFileId, headRevisionId: result.headRevisionId };
  }

  const metadata = { name: SYNC_FILE_NAME, parents: ['appDataFolder'] };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', blob);
  const response = await driveFetch(
    token,
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,headRevisionId',
    { method: 'POST', body: form },
  );
  const result = await response.json();
  if (!result.id || !result.headRevisionId) {
    throw driveError('drive-failed', 'Drive did not return file and revision ids after upload');
  }
  return { fileId: result.id, headRevisionId: result.headRevisionId };
}

export async function deleteSyncFiles(token, fileIds) {
  // Duplicate cleanup is deliberately best-effort. The successful canonical
  // upload is already durable; a failed DELETE merely means the same union is
  // read again next time.
  await Promise.all((fileIds || []).map(async (id) => {
    try {
      await driveFetch(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (error) {
      console.warn('heldnote: could not delete duplicate sync file', id, error);
    }
  }));
}

export function listLegacyBackups(token) {
  return listNamedFiles(token, BACKUP_FILE_NAME, 'id');
}

export async function downloadLegacyBackupText(token, fileId) {
  const response = await driveFetch(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`);
  return response.text();
}

// Uploads the given backup Blob (store.exportAll()'s output) to the
// appDataFolder, overwriting the previous backup file if one exists.
// Pass localNoteCount when known: an upload carrying ZERO notes is refused
// whenever a Drive backup already exists — an empty device (fresh browser,
// cleared site data) must never erase the only off-device copy.
export async function uploadBackup(blob, { silent = false, localNoteCount } = {}) {
  return withToken(async (token) => {
    const existing = await findBackupFile(token);
    if (existing && localNoteCount === 0) {
      throw driveError('refused-empty', 'refusing to overwrite an existing Drive backup with an empty library');
    }
    if (existing) {
      await driveFetch(token, `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: blob,
      });
    } else {
      const metadata = { name: BACKUP_FILE_NAME, parents: ['appDataFolder'] };
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      form.append('file', blob);
      await driveFetch(token, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
        method: 'POST',
        body: form,
      });
    }
    const now = Date.now();
    try {
      localStorage.setItem(LAST_BACKUP_KEY, String(now));
      localStorage.removeItem(LAST_ERROR_KEY);
    } catch (e) { /* cosmetic */ }
    setConnected(true);
    return now;
  }, { silent });
}


export function hasFreshToken() {
  return !!accessToken && Date.now() < tokenExpiresAt - 60_000;
}

// Downloads the newest Drive backup as a Blob for store.importAll().
// Resolves null when no backup exists yet.
export async function downloadBackup() {
  return withToken(async (token) => {
    const existing = await findBackupFile(token);
    if (!existing) return null;
    const response = await driveFetch(token, `https://www.googleapis.com/drive/v3/files/${existing.id}?alt=media`);
    return response.blob();
  });
}
