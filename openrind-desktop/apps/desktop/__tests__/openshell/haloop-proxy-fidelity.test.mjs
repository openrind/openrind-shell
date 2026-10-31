import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import {
  createHaloopAgentProxy,
  anthropicToOpenAiMessages,
  anthropicToOpenAiTools,
  mapToolNameToClient,
} from '../../../../../sandboxes/openeral/haloop-agent-proxy.mjs';

function startMockUpstream(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise(res => server.close(res)),
      });
    });
    server.on('error', reject);
  });
}

function startProxy(options) {
  return new Promise((resolve, reject) => {
    const server = createHaloopAgentProxy(options);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise(res => server.close(res)),
      });
    });
    server.on('error', reject);
  });
}

function postJson(url, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': data.length,
        ...headers,
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: parsed,
          raw,
        });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('anthropicToOpenAiMessages converts image blocks to image_url', () => {
  const anthropicBody = {
    system: 'You are an agent.',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze this screenshot' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
            }
          }
        ]
      }
    ]
  };

  const openAiMessages = anthropicToOpenAiMessages(anthropicBody);
  assert.equal(openAiMessages.length, 2);
  assert.equal(openAiMessages[0].role, 'system');
  assert.equal(openAiMessages[1].role, 'user');
  assert.ok(Array.isArray(openAiMessages[1].content));
  assert.equal(openAiMessages[1].content[0].type, 'text');
  assert.equal(openAiMessages[1].content[1].type, 'image_url');
  assert.ok(openAiMessages[1].content[1].image_url.url.startsWith('data:image/png;base64,'));
});

test('openrouter conversion forwards client temperature, top_p, stop, and exact max_tokens', async () => {
  let receivedUpstreamBody = null;

  const upstream = await startMockUpstream((req, res) => {
    let chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      receivedUpstreamBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-test',
        model: 'provider-actual-model-4o',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Exact output' },
            finish_reason: 'stop',
          }
        ],
        usage: { prompt_tokens: 42, completion_tokens: 15 }
      }));
    });
  });

  const proxy = await startProxy({
    targetBase: upstream.url,
    isOpenRouterKey: true,
    openRouterKey: 'sk-or-test-key',
  });

  try {
    const clientReq = {
      model: 'client-requested-alias',
      max_tokens: 17, // should NOT be clamped to 4096
      temperature: 0.25,
      top_p: 0.85,
      stop_sequences: ['Human:', 'END'],
      messages: [{ role: 'user', content: 'Say hello' }],
    };

    const res = await postJson(proxy.url, '/v1/messages', clientReq);
    assert.equal(res.statusCode, 200);

    // Verify upstream received exact client generation parameters
    assert.ok(receivedUpstreamBody);
    assert.equal(receivedUpstreamBody.max_tokens, 17);
    assert.equal(receivedUpstreamBody.temperature, 0.25);
    assert.equal(receivedUpstreamBody.top_p, 0.85);
    assert.deepEqual(receivedUpstreamBody.stop, ['Human:', 'END']);

    // Verify response preserves provider-reported model and exact usage
    assert.equal(res.body.model, 'provider-actual-model-4o');
    assert.equal(res.body.stop_reason, 'end_turn');
    assert.equal(res.body.usage.input_tokens, 42);
    assert.equal(res.body.usage.output_tokens, 15);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('openrouter conversion maps finish_reason length to max_tokens', async () => {
  const upstream = await startMockUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-test-len',
      model: 'test-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Truncated output...' },
          finish_reason: 'length',
        }
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20 }
    }));
  });

  const proxy = await startProxy({
    targetBase: upstream.url,
    isOpenRouterKey: true,
    openRouterKey: 'sk-or-test-key',
  });

  try {
    const res = await postJson(proxy.url, '/v1/messages', {
      model: 'test-model',
      max_tokens: 20,
      messages: [{ role: 'user', content: 'Generate a long story' }],
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.stop_reason, 'max_tokens');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('empty provider response returns 502 provider_error instead of fabricated greeting', async () => {
  const upstream = await startMockUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    // Empty message: no content, no reasoning, no tool calls
    res.end(JSON.stringify({
      id: 'chatcmpl-empty',
      model: 'test-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '' },
          finish_reason: 'stop',
        }
      ],
    }));
  });

  const proxy = await startProxy({
    targetBase: upstream.url,
    isOpenRouterKey: true,
    openRouterKey: 'sk-or-test-key',
  });

  try {
    const res = await postJson(proxy.url, '/v1/messages', {
      model: 'test-model',
      messages: [{ role: 'user', content: 'test' }],
    });

    assert.equal(res.statusCode, 502);
    assert.equal(res.body.error.type, 'provider_error');
    // Invariant: never masquerade empty/error output as assistant text
    assert.notEqual(res.raw.includes('Hello! How can I help you?'), true);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('malformed tool arguments preserve raw string and record parse error', async () => {
  const upstream = await startMockUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-tc',
      model: 'test-model',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_123',
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: '{"path": "unclosed_string', // invalid JSON
                }
              }
            ]
          },
          finish_reason: 'tool_calls',
        }
      ],
      usage: { prompt_tokens: 5, completion_tokens: 10 }
    }));
  });

  const proxy = await startProxy({
    targetBase: upstream.url,
    isOpenRouterKey: true,
    openRouterKey: 'sk-or-test-key',
  });

  try {
    const res = await postJson(proxy.url, '/v1/messages', {
      model: 'test-model',
      tools: [{ name: 'read_file', description: 'Read file', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'Read file' }],
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.stop_reason, 'tool_use');
    const toolBlock = res.body.content.find(b => b.type === 'tool_use');
    assert.ok(toolBlock);
    // Malformed JSON is not silently converted to empty object {}
    assert.ok(toolBlock.input._parse_error);
    assert.equal(toolBlock.input._raw_arguments, '{"path": "unclosed_string');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('native passthrough preserves exact entity bytes', async () => {
  let receivedBody = null;
  const upstreamPayload = { custom_field: 'intact_response', number: 12345 };

  const upstream = await startMockUpstream((req, res) => {
    let chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      receivedBody = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(upstreamPayload));
    });
  });

  // Native anthropic key triggers direct passthrough branch
  const proxy = await startProxy({
    targetBase: upstream.url,
    isOpenRouterKey: false,
    anthropicKey: 'sk-ant-native-key',
  });

  try {
    const clientPayload = { custom_request: 'exact_bytes', array: [1, 2, 3] };
    const res = await postJson(proxy.url, '/v1/messages', clientPayload);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(receivedBody), clientPayload);
    assert.deepEqual(res.body, upstreamPayload);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('openrouter streaming captures chunk usage and maps finish_reason in message_delta', async () => {
  const upstream = await startMockUpstream((req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    });

    // Send content delta
    res.write(`data: ${JSON.stringify({
      id: 'chatcmpl-stream',
      choices: [{ index: 0, delta: { content: 'Streaming chunk' }, finish_reason: null }]
    })}\n\n`);

    // Send final usage chunk with finish_reason length
    res.write(`data: ${JSON.stringify({
      id: 'chatcmpl-stream',
      choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
      usage: { prompt_tokens: 15, completion_tokens: 45, total_tokens: 60 }
    })}\n\n`);

    res.write('data: [DONE]\n\n');
    res.end();
  });

  const proxy = await startProxy({
    targetBase: upstream.url,
    isOpenRouterKey: true,
    openRouterKey: 'sk-or-test-key',
  });

  try {
    const res = await postJson(proxy.url, '/v1/messages', {
      model: 'test-stream-model',
      stream: true,
      messages: [{ role: 'user', content: 'Stream test' }],
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.raw.includes('event: message_delta'));
    // Stop reason must be mapped from 'length' to 'max_tokens'
    assert.ok(res.raw.includes('"stop_reason":"max_tokens"'));
    // Usage in message_delta must use provider completion_tokens (45) and input_tokens (15)
    assert.ok(res.raw.includes('"output_tokens":45'));
    assert.ok(res.raw.includes('"input_tokens":15'));
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('thinking signatures and unknown blocks survive message conversion', () => {
  const anthropicBody = {
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Analyzing the DOM structure', signature: 'sig_abc123xyz' },
          { type: 'text', text: 'Ready to proceed.' },
          { type: 'custom_metadata_block', data: 'opaque_token_val' },
        ],
      },
    ],
  };

  const openAiMessages = anthropicToOpenAiMessages(anthropicBody);
  assert.equal(openAiMessages.length, 1);
  assert.equal(openAiMessages[0].role, 'assistant');
  assert.equal(openAiMessages[0].content, 'Ready to proceed.');
  assert.equal(openAiMessages[0].reasoning, 'Analyzing the DOM structure');
  assert.equal(openAiMessages[0].reasoning_signature, 'sig_abc123xyz');
  assert.ok(Array.isArray(openAiMessages[0].custom_content_blocks));
  assert.equal(openAiMessages[0].custom_content_blocks[0].type, 'custom_metadata_block');
});

test('proxy forwards tool_choice and custom top-level request parameters', async () => {
  let receivedBody = null;

  const upstream = await startMockUpstream((req, res) => {
    let chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-tool-choice',
        model: 'upstream-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'acknowledged' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));
    });
  });

  const proxy = await startProxy({
    targetBase: upstream.url,
    isOpenRouterKey: true,
    openRouterKey: 'sk-or-test-key',
  });

  try {
    const res = await postJson(proxy.url, '/v1/messages', {
      model: 'test-model',
      messages: [{ role: 'user', content: 'test tool choice' }],
      tool_choice: { type: 'tool', name: 'browser' },
      custom_vendor_param: 'preserved_value',
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(receivedBody.tool_choice, { type: 'function', function: { name: 'browser' } });
    assert.equal(receivedBody.custom_vendor_param, 'preserved_value');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('non-streaming response with both text and reasoning preserves thinking block and missing usage', async () => {
  const upstream = await startMockUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-reasoning',
      model: 'upstream-reasoner',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'Here is the result.',
          reasoning: 'I thought through the problem carefully.',
        },
        finish_reason: 'stop',
      }],
      // Notice: usage is intentionally omitted to verify missing usage fidelity
    }));
  });

  const proxy = await startProxy({
    targetBase: upstream.url,
    isOpenRouterKey: true,
    openRouterKey: 'sk-or-test-key',
  });

  try {
    const res = await postJson(proxy.url, '/v1/messages', {
      model: 'test-model',
      messages: [{ role: 'user', content: 'solve this' }],
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.content.length, 2);
    assert.equal(res.body.content[0].type, 'thinking');
    assert.equal(res.body.content[0].thinking, 'I thought through the problem carefully.');
    assert.equal(res.body.content[1].type, 'text');
    assert.equal(res.body.content[1].text, 'Here is the result.');

    // Missing usage is reported honestly without faking 0/0
    assert.equal(res.body.usage.missing, true);
    assert.equal(res.body.usage.input_tokens, null);
    assert.equal(res.body.usage.output_tokens, null);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
