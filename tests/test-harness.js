const registered = [];

export function test(name, fn) {
  registered.push({ name, fn });
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

export function assertEquals(actual, expected, msg) {
  const a = typeof actual === 'object' ? JSON.stringify(actual) : actual;
  const b = typeof expected === 'object' ? JSON.stringify(expected) : expected;
  if (a !== b) {
    throw new Error(msg || `expected ${b}, got ${a}`);
  }
}

export function withTimeout(promise, ms, msg) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(msg || `timed out after ${ms}ms`)), ms)),
  ]);
}

export async function runTests() {
  const results = document.getElementById('results');
  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const { name, fn } of registered) {
    try {
      await fn();
      passed += 1;
    } catch (err) {
      failed += 1;
      failures.push({ name, err });
      console.error(`FAIL: ${name}`, err);
    }
  }

  const summary = `${passed} passed, ${failed} failed, ${registered.length} total`;
  results.textContent = summary;
  if (failures.length) {
    const list = document.createElement('ul');
    for (const { name, err } of failures) {
      const li = document.createElement('li');
      li.textContent = `${name}: ${err.message}`;
      list.appendChild(li);
    }
    results.appendChild(list);
  }
  console.log(summary);
}
