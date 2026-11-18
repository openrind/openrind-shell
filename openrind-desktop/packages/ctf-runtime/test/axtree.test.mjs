import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  axTreeDisabled,
  createAxTreeCapture,
  serializeAxTree,
} from '../src/agent.mjs';

test('serializeAxTree keeps slim node fields and reports counts', () => {
  const nodes = [
    { nodeId: '1', role: 'rootWebArea', name: 'Home', value: undefined, ignored: true, childIds: ['2'] },
    { nodeId: '2', role: 'button', name: 'Sign in', value: 'Sign in', childIds: [], extra: 'dropped' },
  ];
  const result = serializeAxTree(nodes);
  assert.equal(result.nodeCount, 2);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.nodes[0], { nodeId: '1', role: 'rootWebArea', name: 'Home', value: null, description: null, childIds: ['2'] });
  assert.equal(result.nodes[1].name, 'Sign in');
  assert.equal('extra' in result.nodes[1], false);
});

test('serializeAxTree handles non-array input', () => {
  assert.deepEqual(serializeAxTree(undefined), { nodeCount: 0, truncated: false, nodes: [] });
  assert.deepEqual(serializeAxTree('bogus'), { nodeCount: 0, truncated: false, nodes: [] });
});

test('serializeAxTree truncates when the serialized budget is exceeded', () => {
  const nodes = Array.from({ length: 500 }, (_, i) => ({
    nodeId: `node-${i}`,
    role: 'staticText',
    name: `text-${i}-${'x'.repeat(400)}`,
    childIds: [],
  }));
  const result = serializeAxTree(nodes);
  assert.equal(result.nodeCount, 500);
  assert.equal(result.truncated, true);
  assert.ok(result.nodes.length < 500);
  assert.ok(JSON.stringify(result.nodes).length <= 200_000 + 500);
});

test('axTreeDisabled honors env and config switches', () => {
  const previous = process.env.OPENRIND_CTF_AXTREE;
  try {
    delete process.env.OPENRIND_CTF_AXTREE;
    assert.equal(axTreeDisabled({}), false);
    assert.equal(axTreeDisabled({ captureAxTree: false }), true);
    process.env.OPENRIND_CTF_AXTREE = 'off';
    assert.equal(axTreeDisabled({}), true);
    process.env.OPENRIND_CTF_AXTREE = 'FALSE';
    assert.equal(axTreeDisabled({}), true);
    process.env.OPENRIND_CTF_AXTREE = '1';
    assert.equal(axTreeDisabled({}), false);
  } finally {
    if (previous === undefined) delete process.env.OPENRIND_CTF_AXTREE;
    else process.env.OPENRIND_CTF_AXTREE = previous;
  }
});

test('createAxTreeCapture returns null when disabled', () => {
  assert.equal(createAxTreeCapture({ captureAxTree: false }), null);
});

test('createAxTreeCapture disables itself when the helper is unreachable', async () => {
  const previous = process.env.OPENRIND_BROWSER_HELPER_URL;
  process.env.OPENRIND_BROWSER_HELPER_URL = 'http://127.0.0.1:1';
  try {
    const capture = createAxTreeCapture({});
    const first = await capture.capture();
    assert.equal(first, null);
    // Second call must short-circuit without another network attempt.
    const second = await capture.capture();
    assert.equal(second, null);
  } finally {
    if (previous === undefined) delete process.env.OPENRIND_BROWSER_HELPER_URL;
    else process.env.OPENRIND_BROWSER_HELPER_URL = previous;
  }
});
