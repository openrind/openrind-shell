#!/usr/bin/env node
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

process.on('uncaughtException', err => {
  console.error('PROXY UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', err => {
  console.error('PROXY UNHANDLED REJECTION:', err);
});

export function anthropicToOpenAiMessages(body) {
  const messages = [];
  if (body?.system) {
    const systemText = typeof body.system === 'string'
      ? body.system
      : Array.isArray(body.system)
        ? body.system.map(s => s.text || '').join('\n')
        : '';
    if (systemText) {
      messages.push({ role: 'system', content: systemText });
    }
  }

  if (Array.isArray(body?.messages)) {
    for (const m of body.messages) {
      if (typeof m.content === 'string') {
        messages.push({ role: m.role || 'user', content: m.content });
        continue;
      }

      if (Array.isArray(m.content)) {
        if (m.role === 'assistant') {
          let text = '';
          let reasoning = '';
          let reasoningSignature = null;
          const unknownBlocks = [];
          const toolCalls = [];
          for (const c of m.content) {
            if (c.type === 'text') {
              text += (c.text || '');
            } else if (c.type === 'thinking') {
              reasoning += (c.thinking || '');
              if (c.signature) reasoningSignature = c.signature;
            } else if (c.type === 'redacted_thinking') {
              reasoning += '[REDACTED_THINKING]';
            } else if (c.type === 'tool_use') {
              toolCalls.push({
                id: c.id,
                type: 'function',
                function: {
                  name: c.name,
                  arguments: typeof c.input === 'string' ? c.input : JSON.stringify(c.input || {}),
                },
              });
            } else {
              unknownBlocks.push(c);
            }
          }
          const msgObj = { role: 'assistant', content: text || null };
          if (reasoning) {
            msgObj.reasoning = reasoning;
          }
          if (reasoningSignature) {
            msgObj.reasoning_signature = reasoningSignature;
          }
          if (toolCalls.length > 0) {
            msgObj.tool_calls = toolCalls;
          }
          if (unknownBlocks.length > 0) {
            msgObj.custom_content_blocks = unknownBlocks;
          }
          messages.push(msgObj);
        } else {
          const textPieces = [];
          const toolResults = [];
          const contentBlocks = [];
          let hasImage = false;

          for (const c of m.content) {
            if (c.type === 'text') {
              textPieces.push(c.text || '');
              contentBlocks.push({ type: 'text', text: c.text || '' });
            } else if (c.type === 'image' && c.source) {
              hasImage = true;
              let url = '';
              if (c.source.type === 'base64') {
                const mediaType = c.source.media_type || 'image/png';
                url = `data:${mediaType};base64,${c.source.data || ''}`;
              } else if (c.source.type === 'url' && c.source.url) {
                url = c.source.url;
              }
              if (url) {
                contentBlocks.push({
                  type: 'image_url',
                  image_url: { url }
                });
              }
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
          if (hasImage && contentBlocks.length > 0) {
            messages.push({ role: m.role || 'user', content: contentBlocks });
          } else if (textPieces.length > 0) {
            messages.push({ role: m.role || 'user', content: textPieces.join('\n') });
          } else if (toolResults.length === 0) {
            messages.push({ role: m.role || 'user', content: ' ' });
          }
        }
      }
    }
  }

  return messages;
}

export function anthropicToOpenAiTools(tools) {
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

export function mapToolNameToClient(name, clientToolNames = []) {
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

function readRuntimeEnv() {
  const env = {};
  const paths = [
    '/var/lib/openrind-shell/runtime/api-key.env',
    '/var/lib/openrind-shell/runtime/session.env',
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) {
      try {
        const lines = fs.readFileSync(p, 'utf8').split('\n');
        for (const line of lines) {
          const match = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)=['"]?(.*?)['"]?\s*$/);
          if (match) {
            env[match[1]] = match[2];
          }
        }
      } catch {}
    }
  }
  return env;
}

export function createHaloopAgentProxy(options = {}) {
  let targetBase = options.targetBase || process.env.HALOOP_UPSTREAM_URL || process.env.HALOOP_GATEWAY_URL || 'http://136.112.93.84:8787';
  if (targetBase.includes(':8785') || targetBase.includes('127.0.0.1:8785')) {
    targetBase = options.targetBase || process.env.HALOOP_UPSTREAM_URL || process.env.HALOOP_GATEWAY_URL || 'http://136.112.93.84:8787';
    if (targetBase.includes(':8785') || targetBase.includes('127.0.0.1:8785')) {
      targetBase = 'http://136.112.93.84:8787';
    }
  }
  const targetUrl = new URL(targetBase);
  const isHttps = targetUrl.protocol === 'https:';
  const client = isHttps ? https : http;

  const proxyEnv = options.httpProxy ?? (process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy);
  const proxyUrl = proxyEnv ? new URL(proxyEnv) : null;

  const openRouterKey = (options.openRouterKey ?? process.env.OPENROUTER_API_KEY ?? '').trim();
  const anthropicKey = (options.anthropicKey ?? process.env.ANTHROPIC_API_KEY ?? '').trim();
  const isOpenRouterKey = options.isOpenRouterKey !== undefined
    ? Boolean(options.isOpenRouterKey)
    : (Boolean(openRouterKey) || anthropicKey.startsWith('sk-or-') || (process.env.W8_HALOOP_PROVIDER === 'openrouter'));
  const defaultKey = isOpenRouterKey ? (openRouterKey || anthropicKey) : (anthropicKey || openRouterKey);
  const provider = isOpenRouterKey ? 'openrouter' : (process.env.W8_HALOOP_PROVIDER || 'anthropic');
  const adminToken = options.adminToken ?? process.env.ADMIN_TOKEN ?? process.env.W8_BYOH_ADMIN_TOKEN ?? '';
  const defaultModel = options.defaultModel || process.env.OPENROUTER_MODEL || process.env.LLM_MODEL || process.env.OPENRIND_SHELL_OPENHANDS_MODEL || 'openrouter/free';

  let proxySessionId = (
    process.env.OPENRIND_HALOOP_SESSION_ID ||
    process.env.OPENRIND_SHELL_SESSION_ID ||
    process.env.OPENRIND_SESSION_ID ||
    ''
  ).trim();
  if (!proxySessionId && fs.existsSync('/var/lib/openrind-shell/runtime/session-id')) {
    try { proxySessionId = fs.readFileSync('/var/lib/openrind-shell/runtime/session-id', 'utf8').trim(); } catch {}
  }
  if (!proxySessionId) {
    proxySessionId = randomBytes(16).toString('hex');
  }

  function sendUpstream(reqPath, reqMethod, reqHeaders, callback) {
    const headers = { ...reqHeaders, host: targetUrl.host };

    // When NODE_USE_ENV_PROXY=1 is active (Node 22 built-in proxy agent),
    // client.request automatically tunnels through HTTP_PROXY to targetUrl.hostname:targetUrl.port.
    if (process.env.NODE_USE_ENV_PROXY === '1') {
      return client.request({
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port || (isHttps ? 443 : 80),
        path: reqPath,
        method: reqMethod,
        headers,
      }, callback);
    }

    // Fallback if NODE_USE_ENV_PROXY is not active and proxyUrl is defined
    if (proxyUrl && targetUrl.protocol === 'http:') {
      const fullUrl = `${targetUrl.protocol}//${targetUrl.host}${reqPath}`;
      return http.request({
        protocol: proxyUrl.protocol,
        hostname: proxyUrl.hostname,
        port: proxyUrl.port,
        path: fullUrl,
        method: reqMethod,
        headers,
      }, callback);
    }

    return client.request({
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: reqPath,
      method: reqMethod,
      headers,
    }, callback);
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/healthz' || req.url === '/health' || req.url === '/api/hello' || req.url?.startsWith('/api/hello')) {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': 0 });
      res.end();
      return;
    }
    if (req.url === '/v1/models' || req.url?.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [
          { id: 'gpt-4o', object: 'model' },
          { id: 'openai/gpt-4o', object: 'model' },
          { id: 'gpt-4o-mini', object: 'model' },
          { id: 'claude-sonnet-4-6', object: 'model' },
        ],
      }));
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
      const isResponses = req.url === '/v1/responses' || req.url?.startsWith('/v1/responses') || req.url === '/responses';
      const isStream = Boolean(body?.stream);

      const runtimeEnv = readRuntimeEnv();
      const openRouterKey = (options.openRouterKey || process.env.OPENROUTER_API_KEY || runtimeEnv.OPENROUTER_API_KEY || '').trim();
      const anthropicKey = (options.anthropicKey || process.env.ANTHROPIC_API_KEY || runtimeEnv.ANTHROPIC_API_KEY || '').trim();
      const openAiKey = (options.openAiKey || process.env.OPENAI_API_KEY || runtimeEnv.OPENAI_API_KEY || process.env.CODEX_API_KEY || runtimeEnv.CODEX_API_KEY || '').trim();

      function resolveProviderAndAuth(endpointType) {
        if (endpointType === 'responses') {
          if (openRouterKey && !openRouterKey.startsWith('sk-ant-')) {
            return { provider: 'openrouter', key: openRouterKey };
          }
          if (openAiKey && !openAiKey.startsWith('sk-ant-') && !openAiKey.startsWith('sk-or-')) {
            return { provider: 'openai', key: openAiKey };
          }
          if (anthropicKey.startsWith('sk-or-')) {
            return { provider: 'openrouter', key: anthropicKey };
          }
          if (anthropicKey.startsWith('sk-proj-') || (anthropicKey.startsWith('sk-') && !anthropicKey.startsWith('sk-ant-'))) {
            return { provider: 'openai', key: anthropicKey };
          }
          if (openRouterKey) return { provider: 'openrouter', key: openRouterKey };
          if (openAiKey) return { provider: 'openai', key: openAiKey };
          return { provider: 'anthropic', key: anthropicKey };
        }

        if (endpointType === 'messages') {
          if (anthropicKey && anthropicKey.startsWith('sk-ant-')) {
            return { provider: 'anthropic', key: anthropicKey, format: 'messages' };
          }
          if (openRouterKey && !openRouterKey.startsWith('sk-ant-')) {
            return { provider: 'openrouter', key: openRouterKey, format: 'chat_completions' };
          }
          if (openAiKey && !openAiKey.startsWith('sk-ant-') && !openAiKey.startsWith('sk-or-')) {
            return { provider: 'openai', key: openAiKey, format: 'chat_completions' };
          }
          if (anthropicKey.startsWith('sk-or-')) {
            return { provider: 'openrouter', key: anthropicKey, format: 'chat_completions' };
          }
          if (anthropicKey.startsWith('sk-proj-')) {
            return { provider: 'openai', key: anthropicKey, format: 'chat_completions' };
          }
          if (anthropicKey) return { provider: 'anthropic', key: anthropicKey, format: 'messages' };
          if (openRouterKey) return { provider: 'openrouter', key: openRouterKey, format: 'chat_completions' };
          if (openAiKey) return { provider: 'openai', key: openAiKey, format: 'chat_completions' };
          return { provider: 'anthropic', key: '', format: 'messages' };
        }

        if (openRouterKey && !openRouterKey.startsWith('sk-ant-')) {
          return { provider: 'openrouter', key: openRouterKey };
        }
        if (openAiKey && !openAiKey.startsWith('sk-ant-') && !openAiKey.startsWith('sk-or-')) {
          return { provider: 'openai', key: openAiKey };
        }
        if (anthropicKey && anthropicKey.startsWith('sk-ant-')) {
          return { provider: 'anthropic', key: anthropicKey };
        }
        if (anthropicKey.startsWith('sk-or-')) {
          return { provider: 'openrouter', key: anthropicKey };
        }
        if (anthropicKey.startsWith('sk-proj-') || (anthropicKey.startsWith('sk-') && !anthropicKey.startsWith('sk-ant-'))) {
          return { provider: 'openai', key: anthropicKey };
        }
        if (openRouterKey) return { provider: 'openrouter', key: openRouterKey };
        if (openAiKey) return { provider: 'openai', key: openAiKey };
        if (anthropicKey) return { provider: 'anthropic', key: anthropicKey };
        return { provider: 'openrouter', key: '' };
      }

      // Handle OpenAI Responses API (used by Codex CLI v0.165+)
      if (isResponses && body) {
        const route = resolveProviderAndAuth('responses');
        const messages = [];
        if (Array.isArray(body.input)) {
          for (const item of body.input) {
            if (item.type === 'message') {
              const role = item.role === 'developer' ? 'system' : (item.role || 'user');
              let text = '';
              if (typeof item.content === 'string') {
                text = item.content;
              } else if (Array.isArray(item.content)) {
                text = item.content.map(c => c.text || c.input_text || c.output_text || '').join('\n');
              }
              messages.push({ role, content: text });
            } else if (item.type === 'function_call' || item.type === 'tool_call' || item.type === 'custom_tool_call') {
              const tc = {
                id: item.call_id || item.id,
                type: 'function',
                function: {
                  name: item.name,
                  arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}),
                },
              };
              const lastMsg = messages[messages.length - 1];
              if (lastMsg && lastMsg.role === 'assistant') {
                lastMsg.tool_calls = lastMsg.tool_calls || [];
                lastMsg.tool_calls.push(tc);
              } else {
                messages.push({
                  role: 'assistant',
                  tool_calls: [tc],
                });
              }
            } else if (item.type === 'function_call_output' || item.type === 'tool_call_output' || item.type === 'tool_response') {
              messages.push({
                role: 'tool',
                tool_call_id: item.call_id || item.id,
                content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output || ''),
              });
            }
          }
        }
        if (messages.length === 0) {
          messages.push({ role: 'user', content: 'hello' });
        }

        let tools = undefined;
        if (Array.isArray(body.tools) && body.tools.length > 0) {
          tools = body.tools.map(t => {
            if (t.type === 'function') {
              if (t.function) return t;
              return {
                type: 'function',
                function: {
                  name: t.name,
                  description: t.description || '',
                  parameters: t.parameters || { type: 'object', properties: {} },
                  ...(t.strict !== undefined ? { strict: t.strict } : {}),
                },
              };
            }
            return t;
          });
        }

        let requested = body?.model || process.env.OPENROUTER_MODEL || process.env.LLM_MODEL || defaultModel;
        if (!requested || requested === 'default' || requested.includes('openrind-gateway') || requested === 'claude-sonnet-4-6') {
          requested = route.provider === 'openai' ? 'gpt-4o' : 'openai/gpt-4o';
        } else if (route.provider === 'openai' && requested.startsWith('openai/')) {
          requested = requested.slice(7);
        } else if (route.provider === 'openrouter' && !requested.includes('/')) {
          requested = 'openai/' + requested;
        }

        const payloadObj = {
          model: requested,
          messages,
          stream: true,
          ...(tools ? { tools } : {}),
        };
        if (body.temperature !== undefined) payloadObj.temperature = body.temperature;
        if (body.top_p !== undefined) payloadObj.top_p = body.top_p;
        if (body.max_tokens !== undefined) payloadObj.max_tokens = body.max_tokens;
        if (body.tool_choice !== undefined) payloadObj.tool_choice = body.tool_choice;

        const openAiPayload = JSON.stringify(payloadObj);

        const projectName = resolveProjectName();
        const collectorUrl = process.env.HALOOP_COLLECTOR_URL || 'http://136.112.93.84:8788';
        const sessionContext = process.env.OPENRIND_HALOOP_SESSION_CONTEXT || req.headers['x-openrind-haloop-session'] || '';
        const forwardHeaders = {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(openAiPayload),
          'x-w8-haloop-provider': route.provider,
          ...(adminToken ? { 'x-w8-haloop-admin-token': adminToken } : {}),
          'x-w8-haloop-metadata': JSON.stringify({ project: projectName, session_id: proxySessionId, trace_id: proxySessionId }),
          'x-w8-haloop-config': JSON.stringify({
            input_guardrails: [{ 'halo.mark': { collectorURL: collectorUrl }, async: false, deny: false }],
            output_guardrails: [{ 'halo.export': { collectorURL: collectorUrl, defaultProject: projectName }, async: false, deny: false }],
          }),
        };

        if (sessionContext) {
          forwardHeaders['x-openrind-haloop-session'] = sessionContext;
        }

        if (route.key) {
          if (route.provider === 'anthropic') {
            forwardHeaders['x-api-key'] = route.key;
            forwardHeaders['x-w8-haloop-api-key'] = route.key;
          } else {
            forwardHeaders['authorization'] = route.key.startsWith('Bearer ') ? route.key : `Bearer ${route.key}`;
            forwardHeaders['x-api-key'] = route.key;
            forwardHeaders['x-w8-haloop-api-key'] = route.key;
          }
        }

        const upstream = sendUpstream('/v1/chat/completions', 'POST', forwardHeaders, upstreamRes => {
          if (upstreamRes.statusCode < 200 || upstreamRes.statusCode >= 300) {
            let errChunks = [];
            upstreamRes.on('data', c => errChunks.push(c));
            upstreamRes.on('end', () => {
              const errBody = Buffer.concat(errChunks).toString('utf8');
              res.writeHead(upstreamRes.statusCode || 500, { 'content-type': 'application/json' });
              res.end(errBody);
            });
            return;
          }

          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
          });

          const respId = `resp_${randomBytes(12).toString('hex')}`;
          const msgId = `msg_${randomBytes(12).toString('hex')}`;

          res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: respId, status: 'in_progress' } })}\n\n`);

          let textStarted = false;
          let textItemIndex = 0;
          let accumulatedText = '';
          let activeToolCalls = new Map();
          let outputIndexCounter = 0;
          let sseBuffer = '';

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
                const textPiece = delta?.content || delta?.reasoning || (delta?.reasoning_details?.[0]?.text) || '';
                if (textPiece) {
                  if (!textStarted) {
                    textStarted = true;
                    textItemIndex = outputIndexCounter++;
                    res.write(`event: response.output_item.added\ndata: ${JSON.stringify({
                      type: 'response.output_item.added',
                      response_id: respId,
                      output_index: textItemIndex,
                      item: { id: msgId, type: 'message', role: 'assistant', content: [] },
                    })}\n\n`);
                    res.write(`event: response.content_part.added\ndata: ${JSON.stringify({
                      type: 'response.content_part.added',
                      response_id: respId,
                      output_index: textItemIndex,
                      content_index: 0,
                      part: { type: 'output_text', text: '' },
                    })}\n\n`);
                  }
                  accumulatedText += textPiece;
                  res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({
                    type: 'response.output_text.delta',
                    response_id: respId,
                    output_index: textItemIndex,
                    content_index: 0,
                    delta: textPiece,
                  })}\n\n`);
                }

                if (Array.isArray(delta?.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!activeToolCalls.has(idx)) {
                      const toolItemIndex = outputIndexCounter++;
                      const callId = tc.id || `call_${randomBytes(8).toString('hex')}`;
                      const name = tc.function?.name || '';
                      const toolCallInfo = {
                        id: callId,
                        call_id: callId,
                        name,
                        arguments: '',
                        outputIndex: toolItemIndex,
                      };
                      activeToolCalls.set(idx, toolCallInfo);
                      res.write(`event: response.output_item.added\ndata: ${JSON.stringify({
                        type: 'response.output_item.added',
                        response_id: respId,
                        output_index: toolItemIndex,
                        item: { id: callId, type: 'function_call', call_id: callId, name, arguments: '' },
                      })}\n\n`);
                    }
                    const info = activeToolCalls.get(idx);
                    if (tc.function?.arguments) {
                      info.arguments += tc.function.arguments;
                      res.write(`event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
                        type: 'response.function_call_arguments.delta',
                        response_id: respId,
                        output_index: info.outputIndex,
                        call_id: info.call_id,
                        delta: tc.function.arguments,
                      })}\n\n`);
                    }
                  }
                }
              } catch {}
            }
          });

          upstreamRes.on('end', () => {
            if (textStarted) {
              res.write(`event: response.output_text.done\ndata: ${JSON.stringify({
                type: 'response.output_text.done',
                response_id: respId,
                output_index: textItemIndex,
                content_index: 0,
                text: accumulatedText,
              })}\n\n`);
              res.write(`event: response.output_item.done\ndata: ${JSON.stringify({
                type: 'response.output_item.done',
                response_id: respId,
                output_index: textItemIndex,
                item: { id: msgId, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: accumulatedText }] },
              })}\n\n`);
            }
            for (const info of activeToolCalls.values()) {
              res.write(`event: response.function_call_arguments.done\ndata: ${JSON.stringify({
                type: 'response.function_call_arguments.done',
                response_id: respId,
                output_index: info.outputIndex,
                call_id: info.call_id,
                arguments: info.arguments,
              })}\n\n`);
              res.write(`event: response.output_item.done\ndata: ${JSON.stringify({
                type: 'response.output_item.done',
                response_id: respId,
                output_index: info.outputIndex,
                item: { id: info.id, type: 'function_call', call_id: info.call_id, name: info.name, arguments: info.arguments },
              })}\n\n`);
            }

            const outputItems = [];
            if (textStarted) {
              outputItems.push({ id: msgId, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: accumulatedText }] });
            }
            for (const info of activeToolCalls.values()) {
              outputItems.push({ id: info.id, type: 'function_call', call_id: info.call_id, name: info.name, arguments: info.arguments });
            }
            if (outputItems.length === 0) {
              outputItems.push({ id: msgId, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Task completed.' }] });
            }
            const inTokens = Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(messages)) / 4));
            const outTokens = Math.max(1, Math.ceil(Buffer.byteLength(accumulatedText) / 4));
            res.write(`event: response.completed\ndata: ${JSON.stringify({
              type: 'response.completed',
              response: {
                id: respId,
                object: 'response',
                status: 'completed',
                output: outputItems,
                usage: { total_tokens: inTokens + outTokens, input_tokens: inTokens, output_tokens: outTokens, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
              },
            })}\n\n`);
            setTimeout(() => res.end(), 50);
          });
        });

        upstream.on('error', err => {
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: err.message, type: 'haloop_proxy_error' } }));
          } else {
            res.end();
          }
        });

        upstream.end(openAiPayload);
        return;
      }

      // If using OpenRouter or OpenAI, adapt /v1/messages to /v1/chat/completions
      const messagesRoute = isMessages ? resolveProviderAndAuth('messages') : null;
      if (isMessages && body && messagesRoute && messagesRoute.format === 'chat_completions') {
        const clientToolNames = Array.isArray(body?.tools) ? body.tools.map(t => t.name) : [];
        let chosenModel = body?.model || process.env.OPENROUTER_MODEL || process.env.LLM_MODEL || defaultModel;
        if (!chosenModel || chosenModel === 'default' || chosenModel.includes('openrind-gateway') || chosenModel === 'claude-sonnet-4-6') {
          chosenModel = messagesRoute.provider === 'openai' ? 'gpt-4o' : 'anthropic/claude-3.5-sonnet';
        } else if (chosenModel === 'gpt-5.5' || chosenModel === 'openai/gpt-5.5') {
          chosenModel = messagesRoute.provider === 'openai' ? 'gpt-4o' : 'openai/gpt-4o';
        } else if (messagesRoute.provider === 'openrouter' && !chosenModel.includes('/')) {
          if (chosenModel.startsWith('claude-')) chosenModel = 'anthropic/' + chosenModel;
          else if (chosenModel.startsWith('gpt-')) chosenModel = 'openai/' + chosenModel;
        } else if (messagesRoute.provider === 'openai' && chosenModel.startsWith('openai/')) {
          chosenModel = chosenModel.slice(7);
        }

        const candidates = [
          chosenModel,
          'anthropic/claude-3.5-sonnet',
          'openai/gpt-4o',
          'google/gemini-2.0-flash-exp:free',
          'meta-llama/llama-3.3-70b-instruct:free'
        ];
        const fallbackModels = [...new Set(candidates)].slice(0, 3);
        const openAiMessages = anthropicToOpenAiMessages(body);
        const openAiTools = anthropicToOpenAiTools(body.tools);
        const maxTokens = (body.max_tokens !== undefined && body.max_tokens !== null)
          ? Number(body.max_tokens)
          : 4096;

        const payloadObj = {
          model: chosenModel,
          models: fallbackModels,
          messages: openAiMessages,
          max_tokens: maxTokens,
          stream: isStream,
        };

        if (body.temperature !== undefined && body.temperature !== null) {
          payloadObj.temperature = Number(body.temperature);
        }
        if (body.top_p !== undefined && body.top_p !== null) {
          payloadObj.top_p = Number(body.top_p);
        }
        if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
          payloadObj.stop = body.stop_sequences;
        }
        if (isStream) {
          payloadObj.stream_options = { include_usage: true };
        }
        if (openAiTools) {
          payloadObj.tools = openAiTools;
        }
        if (body.tool_choice !== undefined && body.tool_choice !== null) {
          if (typeof body.tool_choice === 'string') {
            payloadObj.tool_choice = body.tool_choice;
          } else if (body.tool_choice.type === 'auto') {
            payloadObj.tool_choice = 'auto';
          } else if (body.tool_choice.type === 'any') {
            payloadObj.tool_choice = 'required';
          } else if (body.tool_choice.type === 'tool' && body.tool_choice.name) {
            payloadObj.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
          } else {
            payloadObj.tool_choice = body.tool_choice;
          }
        }
        // Preserve and forward unknown top-level request fields
        const knownAnthropicKeys = new Set([
          'model', 'messages', 'system', 'max_tokens', 'temperature', 'top_p', 'top_k',
          'stop_sequences', 'stream', 'tools', 'tool_choice', 'metadata', 'thinking'
        ]);
        for (const [k, v] of Object.entries(body)) {
          if (!knownAnthropicKeys.has(k) && payloadObj[k] === undefined) {
            payloadObj[k] = v;
          }
        }
        const openAiPayload = JSON.stringify(payloadObj);

        const projectName = resolveProjectName();
        const collectorUrl = process.env.HALOOP_COLLECTOR_URL || 'http://136.112.93.84:8788';
        const sessionContext = process.env.OPENRIND_HALOOP_SESSION_CONTEXT || req.headers['x-openrind-haloop-session'] || '';
        const forwardHeaders = {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(openAiPayload),
          'x-w8-haloop-provider': messagesRoute.provider,
          ...(adminToken ? { 'x-w8-haloop-admin-token': adminToken } : {}),
          'x-w8-haloop-metadata': JSON.stringify({ project: projectName, session_id: proxySessionId, trace_id: proxySessionId }),
          'x-w8-haloop-config': JSON.stringify({
            input_guardrails: [{ 'halo.mark': { collectorURL: collectorUrl }, async: false, deny: false }],
            output_guardrails: [{ 'halo.export': { collectorURL: collectorUrl, defaultProject: projectName }, async: false, deny: false }],
          }),
        };

        if (sessionContext) {
          forwardHeaders['x-openrind-haloop-session'] = sessionContext;
        }

        const authKey = messagesRoute.key || openRouterKey || defaultKey;
        if (authKey) {
          forwardHeaders['authorization'] = authKey.startsWith('Bearer ')
            ? authKey
            : `Bearer ${authKey}`;
          forwardHeaders['x-api-key'] = authKey;
          forwardHeaders['x-w8-haloop-api-key'] = authKey;
        }

        const upstream = sendUpstream('/v1/chat/completions', 'POST', forwardHeaders, upstreamRes => {
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
                    if (tc.function?.arguments) {
                      try {
                        input = JSON.parse(tc.function.arguments);
                      } catch (err) {
                        input = { _raw_arguments: tc.function.arguments, _parse_error: err.message };
                      }
                    }
                    const mappedName = mapToolNameToClient(tc.function?.name, clientToolNames);
                    content.push({
                      type: 'tool_use',
                      id: tc.id || `call_${randomBytes(8).toString('hex')}`,
                      name: mappedName,
                      input,
                    });
                  }
                }
                const reasoningText = msg?.reasoning || (msg?.reasoning_details?.[0]?.text);
                const reasoningSig = msg?.reasoning_signature || msg?.signature;
                if (reasoningText) {
                  content.unshift({
                    type: 'thinking',
                    thinking: reasoningText,
                    ...(reasoningSig ? { signature: reasoningSig } : {}),
                  });
                }
                if (content.length === 0) {
                  const replyText = msg?.refusal;
                  if (replyText) {
                    content.push({ type: 'text', text: replyText });
                  } else {
                    res.writeHead(502, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({
                      error: {
                        type: 'provider_error',
                        message: 'Upstream provider returned an empty response with no content or tool calls.'
                      }
                    }));
                    return;
                  }
                }

                const rawFinishReason = resData.choices?.[0]?.finish_reason;
                let stopReason = 'end_turn';
                if (rawFinishReason === 'length') {
                  stopReason = 'max_tokens';
                } else if (rawFinishReason === 'tool_calls' || rawFinishReason === 'function_call') {
                  stopReason = 'tool_use';
                } else if (rawFinishReason === 'content_filter') {
                  stopReason = 'stop_sequence';
                } else if (rawFinishReason === 'stop') {
                  stopReason = 'end_turn';
                } else if (msg?.tool_calls && msg.tool_calls.length > 0) {
                  stopReason = 'tool_use';
                }

                let usage = null;
                const hasUsage = resData.usage && (
                  typeof resData.usage.prompt_tokens === 'number' ||
                  typeof resData.usage.input_tokens === 'number' ||
                  typeof resData.usage.completion_tokens === 'number' ||
                  typeof resData.usage.output_tokens === 'number'
                );

                if (hasUsage) {
                  const promptTokens = typeof resData.usage?.prompt_tokens === 'number'
                    ? resData.usage.prompt_tokens
                    : (typeof resData.usage?.input_tokens === 'number' ? resData.usage.input_tokens : 0);
                  const completionTokens = typeof resData.usage?.completion_tokens === 'number'
                    ? resData.usage.completion_tokens
                    : (typeof resData.usage?.output_tokens === 'number' ? resData.usage.output_tokens : 0);
                  usage = {
                    input_tokens: promptTokens,
                    output_tokens: completionTokens,
                  };
                } else {
                  usage = {
                    input_tokens: null,
                    output_tokens: null,
                    missing: true,
                  };
                }

                const anthropicResponse = {
                  id: `msg_${randomBytes(12).toString('hex')}`,
                  type: 'message',
                  role: 'assistant',
                  content,
                  model: resData.model || body.model || defaultModel,
                  stop_reason: stopReason,
                  usage,
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
                model: body?.model || defaultModel,
                usage: { input_tokens: 0, output_tokens: 0 }
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
            let providerOutputTokens = null;
            let providerInputTokens = null;
            let providerStreamModel = null;
            let rawStreamFinishReason = null;

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

                  if (parsed.model) {
                    providerStreamModel = parsed.model;
                  }

                  if (parsed.usage) {
                    if (typeof parsed.usage.prompt_tokens === 'number') {
                      providerInputTokens = parsed.usage.prompt_tokens;
                    } else if (typeof parsed.usage.input_tokens === 'number') {
                      providerInputTokens = parsed.usage.input_tokens;
                    }
                    if (typeof parsed.usage.completion_tokens === 'number') {
                      providerOutputTokens = parsed.usage.completion_tokens;
                    } else if (typeof parsed.usage.output_tokens === 'number') {
                      providerOutputTokens = parsed.usage.output_tokens;
                    }
                  }

                  if (parsed.choices?.[0]?.finish_reason) {
                    rawStreamFinishReason = parsed.choices[0].finish_reason;
                  }

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
                const fallbackText = accumulatedReasoning.trim();
                if (fallbackText) {
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
              }

              let streamStopReason = 'end_turn';
              if (rawStreamFinishReason === 'length') {
                streamStopReason = 'max_tokens';
              } else if (rawStreamFinishReason === 'tool_calls' || rawStreamFinishReason === 'function_call' || hasToolCalls) {
                streamStopReason = 'tool_use';
              } else if (rawStreamFinishReason === 'content_filter') {
                streamStopReason = 'stop_sequence';
              } else if (rawStreamFinishReason === 'stop') {
                streamStopReason = 'end_turn';
              }

              const finalOutputTokens = providerOutputTokens !== null
                ? providerOutputTokens
                : Math.max(totalOutputTokens, 1);
              const usageEstimated = providerOutputTokens === null;

              const deltaUsage = {
                output_tokens: finalOutputTokens,
                ...(providerInputTokens !== null ? { input_tokens: providerInputTokens } : {}),
                ...(usageEstimated ? { estimated: true } : {}),
              };

              res.write(`event: message_delta\ndata: ${JSON.stringify({
                type: 'message_delta',
                delta: {
                  stop_reason: streamStopReason,
                  ...(providerStreamModel ? { model: providerStreamModel } : {}),
                },
                usage: deltaUsage,
              })}\n\n`);
              res.write(`event: message_stop\ndata: ${JSON.stringify({
                type: 'message_stop'
              })}\n\n`);
              res.end();
            });
          }
        });

        upstream.on('error', err => {
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: err.message, type: 'haloop_proxy_error' } }));
          } else {
            res.end();
          }
        });

        upstream.end(openAiPayload);
        return;
      }

      // Default passthrough for other routes or if using native anthropic key
      const passthroughRoute = resolveProviderAndAuth(req.url?.includes('chat/completions') ? 'chat_completions' : (isMessages ? 'messages' : 'chat_completions'));
      const projectName = resolveProjectName();
      const collectorUrl = process.env.HALOOP_COLLECTOR_URL || 'http://136.112.93.84:8788';
      const sessionContext = process.env.OPENRIND_HALOOP_SESSION_CONTEXT || req.headers['x-openrind-haloop-session'] || '';
      const headers = { ...req.headers };
      headers['x-w8-haloop-provider'] = passthroughRoute.provider || provider;
      headers['x-w8-haloop-admin-token'] = adminToken;
      headers['x-w8-haloop-metadata'] = JSON.stringify({ project: projectName, session_id: proxySessionId, trace_id: proxySessionId });
      headers['x-w8-haloop-config'] = JSON.stringify({
        input_guardrails: [{ 'halo.mark': { collectorURL: collectorUrl }, async: false, deny: false }],
        output_guardrails: [{ 'halo.export': { collectorURL: collectorUrl, defaultProject: projectName }, async: false, deny: false }],
      });

      if (sessionContext) {
        headers['x-openrind-haloop-session'] = sessionContext;
      }

      const passKey = passthroughRoute.key || defaultKey;
      if (passKey) {
        if (passthroughRoute.provider === 'anthropic') {
          headers['x-api-key'] = passKey;
          headers['x-w8-haloop-api-key'] = passKey;
          delete headers['authorization'];
        } else {
          headers['authorization'] = passKey.startsWith('Bearer ')
            ? passKey
            : `Bearer ${passKey}`;
          headers['x-api-key'] = passKey;
          headers['x-w8-haloop-api-key'] = passKey;
        }
      }

      const clientReq = sendUpstream(req.url, req.method, headers, clientRes => {
        res.writeHead(clientRes.statusCode || 500, clientRes.headers);
        clientRes.pipe(res);
      });

      clientReq.on('error', err => {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: err.message, type: 'haloop_proxy_error' } }));
        } else {
          res.end();
        }
      });

      if (rawBody.length > 0) {
        clientReq.write(rawBody);
      }
      clientReq.end();
    });
  });

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      process.exit(0);
    }
  });

  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = createHaloopAgentProxy();
  server.listen(8785, '127.0.0.1', () => {});
}
