#!/usr/bin/env node
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { URL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

process.on('uncaughtException', err => {
  console.error('PROXY UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', err => {
  console.error('PROXY UNHANDLED REJECTION:', err);
});

const AUTHORIZED_GATEWAY_HOSTS = new Set([
  '136.112.93.84',
  'host.openshell.internal',
  '127.0.0.1',
  'localhost',
  '136.123.45.67'
]);

let targetBase = process.env.HALOOP_UPSTREAM_URL || process.env.HALOOP_GATEWAY_URL || 'http://host.openshell.internal:8787';
if (!targetBase) {
  targetBase = 'http://host.openshell.internal:8787';
}
const targetUrl = new URL(targetBase);
const isHttps = targetUrl.protocol === 'https:';
const isLoopbackOrInternal = targetUrl.hostname === '127.0.0.1' ||
  targetUrl.hostname === 'localhost' ||
  targetUrl.hostname === 'host.openshell.internal';
const isSecureUpstream = isHttps || isLoopbackOrInternal;
const isAuthorizedHost = isSecureUpstream || AUTHORIZED_GATEWAY_HOSTS.has(targetUrl.hostname);
if (!isAuthorizedHost) {
  console.error(`[haloop-proxy] Refusing to start with unauthorized gateway host: ${targetUrl.hostname}`);
  process.exit(1);
}
const client = isHttps ? https : http;

const proxyEnv = process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy;
const proxyUrl = proxyEnv ? new URL(proxyEnv) : null;

let openRouterKey = (process.env.OPENROUTER_API_KEY || '').trim();
let anthropicKey = (process.env.ANTHROPIC_API_KEY || '').trim();

const isOpenRouterKey = Boolean(openRouterKey) || anthropicKey.startsWith('sk-or-');
const defaultKey = openRouterKey || anthropicKey || '';
const provider = isOpenRouterKey ? 'openrouter' : 'anthropic';
const adminToken = process.env.ADMIN_TOKEN || process.env.W8_BYOH_ADMIN_TOKEN || '';
const defaultModel = process.env.OPENROUTER_MODEL || process.env.LLM_MODEL || 'openrouter/auto';

function resolveProjectName() {
  let raw = (
    process.env.OPENRIND_SANDBOX_NAME ||
    process.env.OPENRIND_SHELL_SANDBOX_NAME ||
    process.env.OPENRIND_SHELL_WORKSPACE_ID ||
    process.env.WORKSPACE_ID ||
    ''
  ).trim();
  if (!raw && fs.existsSync('/var/lib/openrind-shell/runtime/sandbox-name')) {
    try { raw = fs.readFileSync('/var/lib/openrind-shell/runtime/sandbox-name', 'utf8').trim(); } catch {}
  }
  if (!raw && fs.existsSync('/var/lib/openrind-shell/runtime/workspace-id')) {
    try { raw = fs.readFileSync('/var/lib/openrind-shell/runtime/workspace-id', 'utf8').trim(); } catch {}
  }
  return raw.replace(/^or-/, '') || 'default';
}

function sendUpstream(reqPath, reqMethod, reqHeaders, reqBody, callback) {
  if (typeof reqBody === 'function') {
    callback = reqBody;
    reqBody = undefined;
  }
  const fullUrl = `${targetUrl.protocol}//${targetUrl.host}${reqPath}`;
  const headers = { ...reqHeaders };
  delete headers['host'];
  delete headers['connection'];
  delete headers['keep-alive'];
  delete headers['transfer-encoding'];
  delete headers['content-length'];

  if (reqBody) {
    headers['content-length'] = String(Buffer.byteLength(reqBody));
  }

  fetch(fullUrl, {
    method: reqMethod,
    headers,
    body: reqBody && ['POST', 'PUT', 'PATCH'].includes(reqMethod) ? reqBody : undefined,
    redirect: 'manual',
  }).then(upstreamRes => {
    let nodeStream;
    if (upstreamRes.body) {
      nodeStream = Readable.fromWeb(upstreamRes.body);
    } else {
      nodeStream = new Readable({ read() { this.push(null); } });
    }
    nodeStream.statusCode = upstreamRes.status;
    const downstreamHeaders = Object.fromEntries(upstreamRes.headers.entries());
    delete downstreamHeaders['content-encoding'];
    delete downstreamHeaders['content-length'];
    delete downstreamHeaders['transfer-encoding'];
    nodeStream.headers = downstreamHeaders;
    callback(nodeStream);
  }).catch(err => {
    console.error('sendUpstream fetch error:', err.message);
    const mockRes = new Readable({ read() { this.push(null); } });
    mockRes.statusCode = 502;
    mockRes.headers = { 'content-type': 'application/json' };
    callback(mockRes);
  });

  return {
    on() {},
    end() {},
    write() {},
  };
}

function anthropicToOpenAiMessages(body) {
  const messages = [];
  if (body.system) {
    const systemText = typeof body.system === 'string'
      ? body.system
      : Array.isArray(body.system)
        ? body.system.map(s => s.text || '').join('\n')
        : '';
    if (systemText) {
      messages.push({ role: 'system', content: systemText });
    }
  }

  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (typeof m.content === 'string') {
        messages.push({ role: m.role || 'user', content: m.content });
        continue;
      }

      if (Array.isArray(m.content)) {
        if (m.role === 'assistant') {
          let text = '';
          const toolCalls = [];
          for (const c of m.content) {
            if (c.type === 'text') {
              text += (c.text || '');
            } else if (c.type === 'tool_use') {
              toolCalls.push({
                id: c.id,
                type: 'function',
                function: {
                  name: c.name,
                  arguments: typeof c.input === 'string' ? c.input : JSON.stringify(c.input || {}),
                },
              });
            }
          }
          const msgObj = { role: 'assistant', content: text || null };
          if (toolCalls.length > 0) {
            msgObj.tool_calls = toolCalls;
          }
          messages.push(msgObj);
        } else {
          const textPieces = [];
          const toolResults = [];
          for (const c of m.content) {
            if (c.type === 'text') {
              textPieces.push(c.text || '');
            } else if (c.type === 'tool_result') {
              toolResults.push({
                role: 'tool',
                tool_call_id: c.tool_use_id,
                content: typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? ''),
              });
            }
          }

          for (const tr of toolResults) {
            messages.push(tr);
          }
          if (textPieces.length > 0) {
            messages.push({ role: 'user', content: textPieces.join('\n') });
          } else if (toolResults.length === 0) {
            messages.push({ role: m.role || 'user', content: ' ' });
          }
        }
      }
    }
  }

  return messages;
}

function anthropicToOpenAiTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));
}

function mapToolNameToClient(name, clientToolNames = []) {
  if (!name) return name;
  if (clientToolNames.includes(name)) return name;

  // 1. Try prefixing with mcp__openrind_browser__
  const mcpPrefixed = `mcp__openrind_browser__${name}`;
  if (clientToolNames.includes(mcpPrefixed)) return mcpPrefixed;

  // 2. Convert PascalCase / camelCase to snake_case and check with prefix
  const snake = name.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
  const mcpSnake = `mcp__openrind_browser__${snake}`;
  if (clientToolNames.includes(mcpSnake)) return mcpSnake;
  if (clientToolNames.includes(snake)) return snake;

  // 3. Extract core action (e.g. "start" from "browser_start" or "BrowserStart")
  const core = snake.replace(/^(?:mcp__)?(?:openrind_)?(?:browser_)?/, '');
  const corePrefixed = `mcp__openrind_browser__browser_${core}`;
  if (clientToolNames.includes(corePrefixed)) return corePrefixed;
  const coreBrowser = `browser_${core}`;
  if (clientToolNames.includes(coreBrowser)) return coreBrowser;

  // 4. Try matching case-insensitively
  const match = clientToolNames.find(t =>
    t.toLowerCase() === name.toLowerCase() ||
    t.toLowerCase() === mcpPrefixed.toLowerCase() ||
    t.toLowerCase() === mcpSnake.toLowerCase() ||
    t.toLowerCase() === corePrefixed.toLowerCase() ||
    t.toLowerCase() === coreBrowser.toLowerCase()
  );
  if (match) return match;

  return name;
}

const server = http.createServer((req, res) => {
  console.error('PROXY REQ:', req.method, req.url);
  if (req.url === '/healthz' || req.url === '/health' || req.url === '/api/hello' || req.url?.startsWith('/api/hello')) {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': 0 });
    res.end();
    return;
  }
  let chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks);
    let body;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {}

    const isMessages = req.url === '/v1/messages' || req.url?.startsWith('/v1/messages');
    const isStream = Boolean(body?.stream);
    const projectName = resolveProjectName();
    const collectorUrl = process.env.HALOOP_COLLECTOR_URL || 'http://136.112.93.84:8788';
    let sessionContext = req.headers['x-openrind-haloop-session'] || process.env.OPENRIND_HALOOP_SESSION_CONTEXT || '';

    // If using OpenRouter with a valid key, adapt /v1/messages to OpenRouter /v1/chat/completions
    if (isMessages && body && isOpenRouterKey && (openRouterKey || anthropicKey.startsWith('sk-or-'))) {
      const clientToolNames = Array.isArray(body?.tools) ? body.tools.map(t => t.name) : [];
      const chosenModel = process.env.OPENROUTER_MODEL || process.env.LLM_MODEL || defaultModel;
      const candidates = [
        chosenModel,
        'openrouter/auto',
        'meta-llama/llama-3.3-70b-instruct',
        'deepseek/deepseek-chat',
        'qwen/qwen-2.5-72b-instruct'
      ];
      const fallbackModels = [...new Set(candidates)].slice(0, 3);
      const openAiMessages = anthropicToOpenAiMessages(body);
      const openAiTools = anthropicToOpenAiTools(body.tools);
      const payloadObj = {
        model: chosenModel,
        models: fallbackModels,
        messages: openAiMessages,
        max_tokens: Math.max(Number(body.max_tokens) || 4096, 4096),
        stream: isStream,
      };
      if (openAiTools) {
        payloadObj.tools = openAiTools;
      }
      const openAiPayload = JSON.stringify(payloadObj);

      const authKey = openRouterKey || defaultKey || '';
      const forwardHeaders = {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(openAiPayload),
        'x-w8-haloop-provider': 'openrouter',
        ...(adminToken && isSecureUpstream ? { 'x-w8-haloop-admin-token': adminToken } : {}),
        'x-w8-haloop-metadata': JSON.stringify({ project: projectName }),
        'x-w8-haloop-config': JSON.stringify({
          input_guardrails: [{ 'halo.mark': { collectorURL: collectorUrl }, async: false, deny: false }],
          output_guardrails: [{ 'halo.export': { collectorURL: collectorUrl, defaultProject: projectName }, async: false, deny: false }],
        }),
      };

      if (authKey && isSecureUpstream) {
        forwardHeaders['authorization'] = authKey.startsWith('Bearer ') ? authKey : `Bearer ${authKey}`;
        forwardHeaders['x-api-key'] = authKey;
        forwardHeaders['x-w8-haloop-api-key'] = authKey;
      }

      if (sessionContext && isSecureUpstream) {
        forwardHeaders['x-openrind-haloop-session'] = sessionContext;
      }

      sendUpstream('/v1/chat/completions', 'POST', forwardHeaders, openAiPayload, upstreamRes => {
        upstreamRes.on('error', err => {
          console.error('Upstream response stream error:', err.message);
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { type: 'api_error', message: err.message } }));
          } else {
            res.end();
          }
        });

        if (upstreamRes.statusCode < 200 || upstreamRes.statusCode >= 300) {
          let errChunks = [];
          upstreamRes.on('data', c => errChunks.push(c));
          upstreamRes.on('end', () => {
            const errBody = Buffer.concat(errChunks).toString('utf8');
            let parsedErr;
            try { parsedErr = JSON.parse(errBody); } catch {}
            const errMsg = parsedErr?.error?.message || errBody || 'Upstream provider error';
            res.writeHead(upstreamRes.statusCode || 500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              error: {
                type: 'api_error',
                message: errMsg,
              },
            }));
          });
          return;
        }

        if (!isStream) {
          let resChunks = [];
          upstreamRes.on('data', c => resChunks.push(c));
          upstreamRes.on('end', () => {
            try {
              const resData = JSON.parse(Buffer.concat(resChunks).toString('utf8'));
              if (resData.error) {
                res.writeHead(upstreamRes.statusCode || 400, { 'content-type': 'application/json' });
                res.end(JSON.stringify(resData));
                return;
              }

              const msg = resData.choices?.[0]?.message;
              const content = [];
              if (msg?.content) {
                content.push({ type: 'text', text: msg.content });
              }
              if (Array.isArray(msg?.tool_calls)) {
                for (const tc of msg.tool_calls) {
                  let input = {};
                  try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {}
                  const mappedName = mapToolNameToClient(tc.function?.name, clientToolNames);
                  content.push({
                    type: 'tool_use',
                    id: tc.id || `call_${randomBytes(8).toString('hex')}`,
                    name: mappedName,
                    input,
                  });
                }
              }
              if (content.length === 0) {
                const replyText = msg?.reasoning || (msg?.reasoning_details?.[0]?.text) || 'Hello! How can I help you?';
                content.push({ type: 'text', text: replyText });
              }

              const anthropicResponse = {
                id: `msg_${randomBytes(12).toString('hex')}`,
                type: 'message',
                role: 'assistant',
                content,
                model: body.model || defaultModel,
                stop_reason: (msg?.tool_calls && msg.tool_calls.length > 0) ? 'tool_use' : 'end_turn',
                usage: {
                  input_tokens: resData.usage?.prompt_tokens || 10,
                  output_tokens: resData.usage?.completion_tokens || 10,
                },
              };

              const outBytes = Buffer.from(JSON.stringify(anthropicResponse));
              res.writeHead(200, {
                'content-type': 'application/json',
                'content-length': outBytes.byteLength,
              });
              res.end(outBytes);
            } catch (err) {
              res.writeHead(502, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: { message: err.message } }));
            }
          });
        } else {
          // SSE streaming transform from OpenAI chunk to Anthropic event stream
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
          });

          const msgId = `msg_${randomBytes(12).toString('hex')}`;
          res.write(`event: message_start\ndata: ${JSON.stringify({
            type: 'message_start',
            message: {
              id: msgId,
              type: 'message',
              role: 'assistant',
              content: [],
              model: defaultModel,
              usage: { input_tokens: 10, output_tokens: 0 }
            }
          })}\n\n`);

          let blockIndex = 0;
          let inThinking = false;
          let inText = false;
          let activeToolCalls = new Map(); // tool_call_index -> anthropic blockIndex
          let hasToolCalls = false;
          let totalOutputTokens = 0;
          let accumulatedReasoning = '';
          let sseBuffer = '';

          const wantsThinking = Boolean(body?.thinking && body.thinking.type === 'enabled');

          upstreamRes.on('data', chunk => {
            sseBuffer += chunk.toString('utf8');
            const lines = sseBuffer.split('\n');
            sseBuffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) continue;
              const payload = trimmed.slice(5).trim();
              if (!payload || payload === '[DONE]') continue;
              try {
                const parsed = JSON.parse(payload);
                const delta = parsed.choices?.[0]?.delta;
                if (!delta) continue;

                const reasoningPiece = delta.reasoning || (delta.reasoning_details?.[0]?.text) || '';
                const contentPiece = delta.content || '';
                const toolCallsPiece = delta.tool_calls;

                if (reasoningPiece) {
                  accumulatedReasoning += reasoningPiece;
                  if (wantsThinking) {
                    totalOutputTokens++;
                    if (!inThinking && !inText && activeToolCalls.size === 0) {
                      inThinking = true;
                      res.write(`event: content_block_start\ndata: ${JSON.stringify({
                        type: 'content_block_start',
                        index: blockIndex,
                        content_block: { type: 'thinking', thinking: '' }
                      })}\n\n`);
                    }
                    if (inThinking) {
                      res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                        type: 'content_block_delta',
                        index: blockIndex,
                        delta: { type: 'thinking_delta', thinking: reasoningPiece }
                      })}\n\n`);
                    }
                  }
                }

                if (contentPiece) {
                  totalOutputTokens++;
                  if (inThinking) {
                    res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                      type: 'content_block_stop',
                      index: blockIndex
                    })}\n\n`);
                    inThinking = false;
                    blockIndex++;
                  }
                  if (!inText) {
                    inText = true;
                    res.write(`event: content_block_start\ndata: ${JSON.stringify({
                      type: 'content_block_start',
                      index: blockIndex,
                      content_block: { type: 'text', text: '' }
                    })}\n\n`);
                  }
                  res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                    type: 'content_block_delta',
                    index: blockIndex,
                    delta: { type: 'text_delta', text: contentPiece }
                  })}\n\n`);
                }

                if (Array.isArray(toolCallsPiece)) {
                  totalOutputTokens++;
                  hasToolCalls = true;
                  if (inThinking) {
                    res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                      type: 'content_block_stop',
                      index: blockIndex
                    })}\n\n`);
                    inThinking = false;
                    blockIndex++;
                  }
                  if (inText) {
                    res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                      type: 'content_block_stop',
                      index: blockIndex
                    })}\n\n`);
                    inText = false;
                    blockIndex++;
                  }

                  for (const tc of toolCallsPiece) {
                    const idx = tc.index ?? 0;
                    if (!activeToolCalls.has(idx)) {
                      const curBlock = blockIndex++;
                      activeToolCalls.set(idx, curBlock);
                      const mappedName = mapToolNameToClient(tc.function?.name || 'tool', clientToolNames);
                      res.write(`event: content_block_start\ndata: ${JSON.stringify({
                        type: 'content_block_start',
                        index: curBlock,
                        content_block: {
                          type: 'tool_use',
                          id: tc.id || `call_${randomBytes(8).toString('hex')}`,
                          name: mappedName,
                          input: {}
                        }
                      })}\n\n`);
                    }

                    const targetBlock = activeToolCalls.get(idx);
                    if (tc.function?.arguments) {
                      res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                        type: 'content_block_delta',
                        index: targetBlock,
                        delta: {
                          type: 'input_json_delta',
                          partial_json: tc.function.arguments
                        }
                      })}\n\n`);
                    }
                  }
                }
              } catch {}
            }
          });

          upstreamRes.on('end', () => {
            if (inThinking) {
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                type: 'content_block_stop',
                index: blockIndex
              })}\n\n`);
              inThinking = false;
              blockIndex++;
            }
            if (inText) {
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                type: 'content_block_stop',
                index: blockIndex
              })}\n\n`);
              inText = false;
              blockIndex++;
            }
            for (const [idx, curBlock] of activeToolCalls.entries()) {
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                type: 'content_block_stop',
                index: curBlock
              })}\n\n`);
            }
            activeToolCalls.clear();

            if (blockIndex === 0 && !hasToolCalls) {
              const fallbackText = accumulatedReasoning.trim() || 'Hello! How can I help you?';
              res.write(`event: content_block_start\ndata: ${JSON.stringify({
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' }
              })}\n\n`);
              res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: fallbackText }
              })}\n\n`);
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                type: 'content_block_stop',
                index: 0
              })}\n\n`);
            }

            res.write(`event: message_delta\ndata: ${JSON.stringify({
              type: 'message_delta',
              delta: { stop_reason: hasToolCalls ? 'tool_use' : 'end_turn' },
              usage: { output_tokens: Math.max(totalOutputTokens, 1) }
            })}\n\n`);
            res.write(`event: message_stop\ndata: ${JSON.stringify({
              type: 'message_stop'
            })}\n\n`);
            res.end();
          });
        }
      });

      return;
    }

    // Default passthrough for other routes or if using native anthropic key
    const headers = { ...req.headers };
    delete headers['host'];
    headers['x-w8-haloop-provider'] = isMessages ? 'anthropic' : provider;
    if (adminToken && isSecureUpstream) {
      headers['x-w8-haloop-admin-token'] = adminToken;
    }
    headers['x-w8-haloop-metadata'] = JSON.stringify({ project: projectName });
    headers['x-w8-haloop-config'] = JSON.stringify({
      input_guardrails: [{ 'halo.mark': { collectorURL: collectorUrl }, async: false, deny: false }],
      output_guardrails: [{ 'halo.export': { collectorURL: collectorUrl, defaultProject: projectName }, async: false, deny: false }],
    });

    if (sessionContext && isSecureUpstream) {
      headers['x-openrind-haloop-session'] = sessionContext;
    }

    const rawKey = defaultKey || req.headers['authorization'] || req.headers['x-api-key'] || '';
    const isPlaceholder = rawKey.includes('openrind-session-token') || rawKey.includes('simulation-admin');
    if (rawKey && !isPlaceholder && isSecureUpstream) {
      headers['authorization'] = rawKey.startsWith('Bearer ') ? rawKey : `Bearer ${rawKey}`;
      headers['x-api-key'] = rawKey;
      headers['x-w8-haloop-api-key'] = rawKey;
    }

    sendUpstream(req.url, req.method, headers, rawBody.length > 0 ? rawBody : undefined, clientRes => {
      res.writeHead(clientRes.statusCode || 500, clientRes.headers);
      clientRes.pipe(res);
    });
  });
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    process.exit(0);
  }
});

server.listen(8785, '127.0.0.1', () => {});
