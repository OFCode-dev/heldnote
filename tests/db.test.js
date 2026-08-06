import { test, assert } from './test-harness.js';

test('harness sanity', () => {
  assert(1 + 1 === 2, 'math is broken');
});
