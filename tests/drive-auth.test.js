// Exercise the real transport in isolated browser realms, with GIS callbacks
// captured at initialization just as the public API specifies. No Google calls.
import { test, assert, assertEquals, withTimeout } from './test-harness.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const KEYS = ['heldnote-drive-token', 'heldnote-drive-connected', 'heldnote-drive-granted'];
let scenarioId = 0;

function outcome(promise) {
  return promise.then(value => ({ value }), error => ({ error }));
}

async function errorCode(result, code) {
  const { error } = await withTimeout(result, 300, 'authentication did not settle');
  assertEquals(error && error.code, code);
}

function authTest(name, work, { gis = true, cached = false } = {}) {
  test(`Drive auth: ${name}`, async () => {
    const saved = KEYS.map(key => [key, localStorage.getItem(key)]);
    KEYS.forEach(key => localStorage.removeItem(key));
    if (cached) localStorage.setItem(KEYS[0], JSON.stringify({ token: 'cached-token', expiresAt: Date.now() + 3600000 }));
    const frame = document.createElement('iframe');
    frame.hidden = true;
    document.body.appendChild(frame);
    const win = frame.contentWindow;
    const requests = [];
    const scripts = [];
    const timers = [];
    const activation = { isActive: true };
    Object.defineProperty(win.navigator, 'userActivation', { value: activation, configurable: true });
    const realSetTimeout = win.setTimeout.bind(win);
    const realClearTimeout = win.clearTimeout.bind(win);
    win.setTimeout = (fn, ms, ...args) => {
      if (ms >= 10000) {
        const timer = { fn: () => fn(...args), ms, cleared: false };
        timers.push(timer);
        return timer;
      }
      return realSetTimeout(fn, ms, ...args);
    };
    win.clearTimeout = timer => {
      if (timer && typeof timer === 'object') timer.cleared = true;
      else realClearTimeout(timer);
    };
    win.document.head.appendChild = script => { scripts.push(script); return script; };
    function installGis() {
      win.google = { accounts: { oauth2: {
        initTokenClient(config) {
          // Deliberately snapshot the config: mutating a returned client is
          // not a supported way to replace error_callback.
          const callbacks = { ...config };
          const client = {
            callback: config.callback,
            requestAccessToken(options) {
              requests.push({ ...callbacks, callback: response => client.callback(response), options });
            },
          };
          return client;
        },
        revoke() {},
      } } };
    }
    if (gis) installGis();
    try {
      const url = new URL(`../drive-sync.js?auth-test=${++scenarioId}`, import.meta.url).href;
      const drive = await win.Function('url', 'return import(url)')(url);
      await work({ drive, win, requests, scripts, timers, activation, installGis });
    } finally {
      frame.remove();
      for (const [key, value] of saved) {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
    }
  });
}

const success = { access_token: 'test-token', expires_in: 3600, scope: SCOPE };

authTest('connect accepts the requested scope and persists the session', async ({ drive, requests }) => {
  const result = outcome(drive.connect());
  await Promise.resolve();
  assertEquals(requests.length, 1);
  assertEquals(requests[0].scope, SCOPE);
  assertEquals(requests[0].options.prompt, '', 'Google must decide if consent is needed even without a local marker');
  requests[0].callback(success);
  assert(!(await withTimeout(result, 300)).error);
  assert(drive.isConnected());
  assert(drive.hasFreshToken());
});

authTest('connect reuses a valid token restored after a reload', async ({ drive, requests, scripts }) => {
  await drive.connect();
  assert(drive.isConnected());
  assertEquals(requests.length, 0);
  assertEquals(scripts.length, 0);
}, { cached: true, gis: false });

authTest('popup failures use the callback supplied at initialization', async ({ drive, requests }) => {
  const result = outcome(drive.connect());
  await Promise.resolve();
  requests[0].error_callback({ type: 'popup_failed_to_open' });
  await errorCode(result, 'popup-blocked');
  assert(!drive.isConnected());
});

authTest('closing the popup settles without connecting', async ({ drive, requests }) => {
  const result = outcome(drive.connect());
  await Promise.resolve();
  requests[0].error_callback({ type: 'popup_closed' });
  await errorCode(result, 'consent-denied');
  assert(!drive.isConnected());
});

authTest('denied consent leaves the local session disconnected', async ({ drive, requests }) => {
  const result = outcome(drive.connect());
  await Promise.resolve();
  requests[0].callback({ error: 'access_denied' });
  await errorCode(result, 'consent-denied');
  assert(!drive.hasFreshToken());
});

authTest('a token without Drive permission is never persisted', async ({ drive, requests }) => {
  const result = outcome(drive.connect());
  await Promise.resolve();
  requests[0].callback({ ...success, scope: 'openid email' });
  await errorCode(result, 'consent-denied');
  assert(!drive.isConnected());
  assertEquals(localStorage.getItem(KEYS[0]), null);
});

authTest('malformed success responses do not mark a connection', async ({ drive, requests }) => {
  const result = outcome(drive.connect());
  await Promise.resolve();
  requests[0].callback({ scope: SCOPE });
  await errorCode(result, 'auth-failed');
  assert(!drive.isConnected());
});

authTest('a late response after timeout cannot save a token', async ({ drive, requests, timers }) => {
  const result = outcome(drive.connect());
  await Promise.resolve();
  timers.find(timer => timer.ms === 60000).fn();
  await errorCode(result, 'timeout');
  requests[0].callback(success);
  assert(!drive.hasFreshToken());
  assertEquals(localStorage.getItem(KEYS[0]), null);
  assertEquals(localStorage.getItem(KEYS[2]), null);
});

authTest('disconnect cancels a pending request and ignores its response', async ({ drive, requests }) => {
  const result = outcome(drive.connect());
  await Promise.resolve();
  drive.disconnect();
  requests[0].callback(success);
  await errorCode(result, 'auth-needed');
  assert(!drive.isConnected());
  assert(!drive.hasFreshToken());
});

authTest('background work with no token never loads GIS or opens a popup', async ({ drive, requests, scripts }) => {
  let calls = 0;
  const result = outcome(drive.withToken(() => { calls++; }, { silent: true }));
  await errorCode(result, 'auth-needed');
  assertEquals(requests.length, 0);
  assertEquals(scripts.length, 0);
  assertEquals(calls, 0);
}, { gis: false });

authTest('background work can reuse a valid cached token', async ({ drive, requests }) => {
  const token = await drive.withToken(token => token, { silent: true });
  assertEquals(token, 'cached-token');
  assertEquals(requests.length, 0);
}, { cached: true });

authTest('a background 401 clears the token without a popup', async ({ drive, requests }) => {
  const result = outcome(drive.withToken(() => {
    throw Object.assign(new Error('401'), { code: 'auth-expired' });
  }, { silent: true }));
  await errorCode(result, 'auth-needed');
  assertEquals(requests.length, 0);
  assert(!drive.hasFreshToken());
}, { cached: true });

authTest('concurrent requests share one popup and both settle', async ({ drive, requests }) => {
  const first = outcome(drive.connect());
  const second = outcome(drive.connect());
  await Promise.resolve();
  assertEquals(requests.length, 1);
  requests[0].callback(success);
  const results = await withTimeout(Promise.all([first, second]), 300);
  assert(results.every(result => !result.error));
});

authTest('a stalled GIS script times out and a later click can retry', async ({ drive, scripts, timers }) => {
  const first = outcome(drive.connect());
  assertEquals(scripts.length, 1);
  const timer = timers.find(timer => timer.ms === 15000);
  assert(timer, 'script loading needs its own deadline');
  timer.fn();
  await errorCode(first, 'network');
  const second = outcome(drive.connect());
  assertEquals(scripts.length, 2);
  scripts[1].onerror();
  await errorCode(second, 'network');
}, { gis: false });

authTest('a loaded script without the GIS API is a recoverable network error', async ({ drive, scripts }) => {
  const result = outcome(drive.connect());
  scripts[0].onload();
  await errorCode(result, 'network');
}, { gis: false });

authTest('slow loading cannot open a popup after the click activation expires', async ({ drive, scripts, requests, activation, installGis }) => {
  const result = outcome(drive.connect());
  activation.isActive = false;
  installGis();
  scripts[0].onload();
  await errorCode(result, 'auth-retry');
  assertEquals(requests.length, 0);
  activation.isActive = true;
  const retry = outcome(drive.connect());
  // Once ready, the popup request must happen synchronously in the click.
  assertEquals(requests.length, 1);
  requests[0].callback(success);
  assert(!(await withTimeout(retry, 300)).error);
}, { gis: false });
