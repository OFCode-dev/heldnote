// drive-sync.js — Google Drive backup for Heldnote.
//
// Design constraints, in the spirit of the product's promises:
// - The Drive copy is a *backup*, never the source of truth. Restore imports
//   as copies (store-api.md's safe, additive mode); nothing here can destroy
//   local notes.
// - Everything runs in the browser against Drive's appDataFolder — an
//   app-scoped hidden folder (scope drive.appdata), so Heldnote never sees
//   the user's real Drive contents and needs no server.
// - The OAuth access token lives in memory only. What persists locally is a
//   single "connected" flag and the last-backup timestamp, both cosmetic.
//
// The whole feature is inert until constants.js sets GOOGLE_DRIVE_CLIENT_ID.

import { GOOGLE_DRIVE_CLIENT_ID } from './constants.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const BACKUP_FILE_NAME = 'heldnote-backup.json';
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const CONNECTED_KEY = 'heldnote-drive-connected';
const LAST_BACKUP_KEY = 'heldnote-drive-last-backup';

let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;
let gisLoadPromise = null;

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

function setConnected(flag) {
  try {
    if (flag) localStorage.setItem(CONNECTED_KEY, '1');
    else localStorage.removeItem(CONNECTED_KEY);
  } catch (e) { /* cosmetic only */ }
}

function loadGis() {
  if (window.google && window.google.accounts && window.google.accounts.oauth2) {
    return Promise.resolve();
  }
  if (gisLoadPromise) return gisLoadPromise;
  gisLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      gisLoadPromise = null; // allow a later retry — e.g. a transient network failure
      reject(driveError('network', 'Google script failed to load'));
    };
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
async function getToken({ forceConsent = false } = {}) {
  if (!isConfigured()) throw driveError('not-configured', 'Drive client id is not set');
  if (!forceConsent && accessToken && Date.now() < tokenExpiresAt - 30_000) {
    return accessToken;
  }
  await loadGis();
  if (!tokenClient) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_DRIVE_CLIENT_ID,
      scope: SCOPE,
      callback: () => {}, // replaced per-request below
    });
  }
  return new Promise((resolve, reject) => {
    tokenClient.callback = (response) => {
      if (response.error) {
        reject(driveError(response.error === 'access_denied' ? 'consent-denied' : 'auth-failed', response.error));
        return;
      }
      accessToken = response.access_token;
      tokenExpiresAt = Date.now() + (Number(response.expires_in) || 3600) * 1000;
      resolve(accessToken);
    };
    try {
      tokenClient.requestAccessToken({ prompt: forceConsent ? 'consent' : '' });
    } catch (error) {
      reject(driveError('auth-failed', String(error)));
    }
  });
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
async function withToken(work, { silent = false } = {}) {
  let token = await getToken();
  try {
    return await work(token);
  } catch (error) {
    if (error && error.code === 'auth-expired') {
      accessToken = null;
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
  await getToken({ forceConsent: true });
  setConnected(true);
}

export function disconnect() {
  const token = accessToken;
  accessToken = null;
  tokenExpiresAt = 0;
  setConnected(false);
  // Best-effort revoke; local state is already cleared either way.
  if (token && window.google && window.google.accounts && window.google.accounts.oauth2) {
    try { window.google.accounts.oauth2.revoke(token, () => {}); } catch (e) { /* best effort */ }
  }
}

// Uploads the given backup Blob (store.exportAll()'s output) to the
// appDataFolder, overwriting the previous backup file if one exists.
export async function uploadBackup(blob, { silent = false } = {}) {
  return withToken(async (token) => {
    const existing = await findBackupFile(token);
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
    try { localStorage.setItem(LAST_BACKUP_KEY, String(now)); } catch (e) { /* cosmetic */ }
    setConnected(true);
    return now;
  }, { silent });
}

// --- Automatic backup -----------------------------------------------------
//
// "Sync" here is deliberately one-way: local notes are the source of truth,
// Drive holds a rolling snapshot. What must never be true is "the user wrote
// for an hour and Drive still has yesterday's file because they forgot a
// button". So: every durable local save schedules a quiet upload, debounced
// so a writing session becomes one upload, rate-limited so Drive is touched
// at most once per MIN_INTERVAL even during constant typing.

const AUTO_DEBOUNCE_MS = 30_000;      // quiet period after the last save
const AUTO_MIN_INTERVAL_MS = 300_000; // at most one auto-upload per 5 min

let autoTimer = null;
let autoUploadInFlight = false;
let lastAutoUploadAt = 0;

export function hasFreshToken() {
  return !!accessToken && Date.now() < tokenExpiresAt - 60_000;
}

// exportAll: () => Promise<Blob> (store.exportAll), onDone: (ts|null, error?) => void
export function noteSaved(exportAll, onDone) {
  if (!isConfigured() || !isConnected()) return;
  // Without a live token an upload would need requestAccessToken, and outside
  // a user gesture that risks a popup (or a popup-blocker fight) in the
  // middle of writing. Surface a quiet "one click to resume backups" state
  // instead; the next manual Drive action refreshes the token and auto-backup
  // takes over again.
  if (!hasFreshToken()) {
    if (onDone) onDone(null, driveError('auth-needed', 'no live token'));
    return;
  }
  if (autoTimer) clearTimeout(autoTimer);
  const wait = Math.max(AUTO_DEBOUNCE_MS, lastAutoUploadAt + AUTO_MIN_INTERVAL_MS - Date.now());
  autoTimer = setTimeout(async () => {
    autoTimer = null;
    if (autoUploadInFlight) return;
    autoUploadInFlight = true;
    try {
      const blob = await exportAll();
      const at = await uploadBackup(blob, { silent: true });
      lastAutoUploadAt = at;
      if (onDone) onDone(at);
    } catch (error) {
      // Never interrupt writing for a failed background backup: report to the
      // caller (which shows it in the quiet Drive status line) and retry on
      // the next save.
      console.error('heldnote: auto backup failed', error);
      if (onDone) onDone(null, error);
    } finally {
      autoUploadInFlight = false;
    }
  }, wait);
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
