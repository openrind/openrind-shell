#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import JSON5 from "json5";

const OPENCLAW_HOME = "/sandbox/openclaw-home";
const WORKSPACE = "/sandbox/work";
const PROVIDER_ID = "openrind-gateway";
const DEFAULT_GATEWAY_URL = "http://136.112.93.84:8787";
const PROVIDER_BASE_URL =
  process.env.OPENRIND_GATEWAY_BASE_URL ||
  "http://127.0.0.1:8785";
const DEFAULT_MODEL_ID = "claude-sonnet-4-6";
const home = resolve(process.env.HOME || OPENCLAW_HOME);

if (home !== OPENCLAW_HOME) {
  throw new Error(`OpenClaw HOME must be ${OPENCLAW_HOME}; received ${home}`);
}

const configPath = join(home, ".openclaw", "openclaw.json");

function readApiKeyEnv() {
  const p = "/var/lib/openrind-shell/runtime/api-key.env";
  if (existsSync(p)) {
    try {
      const lines = readFileSync(p, "utf8").split("\n");
      for (const line of lines) {
        const match = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)=['"]?(.*?)['"]?\s*$/);
        if (match && !process.env[match[1]]) {
          process.env[match[1]] = match[2];
        }
      }
    } catch {}
  }
}
readApiKeyEnv();

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readConfig() {
  if (!existsSync(configPath)) return {};
  const source = readFileSync(configPath, "utf8");
  if (!source.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    // Match OpenClaw's parser: strict JSON first, then json5@2.2.3.
    try {
      parsed = JSON5.parse(source);
    } catch {
      const backup = `${configPath}.invalid-${Date.now()}`;
      renameSync(configPath, backup);
      process.stderr.write(`OpenClaw config was invalid and was preserved at ${backup}\n`);
      return {};
    }
  }
  return isObject(parsed) ? parsed : {};
}

const config = readConfig();
config.gateway = isObject(config.gateway) ? config.gateway : {};
config.gateway.mode = "local";
config.gateway.bind = "loopback";
config.gateway.auth = { mode: "none" };
delete config.gateway.remote;
delete config.gateway.tailscale;
delete config.gateway.tls;

config.agents = isObject(config.agents) ? config.agents : {};
config.agents.defaults = isObject(config.agents.defaults) ? config.agents.defaults : {};
config.agents.defaults.workspace = WORKSPACE;
config.agents.defaults.model = isObject(config.agents.defaults.model)
  ? config.agents.defaults.model
  : {};
config.agents.defaults.models = isObject(config.agents.defaults.models)
  ? config.agents.defaults.models
  : {};
config.models = isObject(config.models) ? config.models : {};
config.models.providers = isObject(config.models.providers)
  ? config.models.providers
  : {};

const requestedModel = String(
  process.env.OPENRIND_SHELL_OPENCLAW_MODEL || "",
).trim();
const configuredModel = String(config.agents.defaults.model.primary || "").trim();
const providerPrefix = `${PROVIDER_ID}/`;
const defaultModel = `${providerPrefix}${DEFAULT_MODEL_ID}`;

const candidateModel = requestedModel || configuredModel;
const primaryModel = candidateModel.startsWith(providerPrefix) && candidateModel.length > providerPrefix.length
    ? candidateModel
    : defaultModel;
config.agents.defaults.model.primary = primaryModel;

for (const model of Object.keys(config.agents.defaults.models)) {
  if (
    model.startsWith("openrouter/") ||
    model.startsWith("openrind-haloop/") ||
    model.startsWith("openrind-gateway/") ||
    model.startsWith("stringcost/") ||
    model.startsWith("anthropic/")
  ) {
    delete config.agents.defaults.models[model];
  }
}
config.agents.defaults.models[primaryModel] = isObject(
  config.agents.defaults.models[primaryModel],
)
  ? config.agents.defaults.models[primaryModel]
  : {};

config.env = isObject(config.env) ? config.env : {};
delete config.env.OPENROUTER_API_KEY;
delete config.env.ANTHROPIC_AUTH_TOKEN;
delete config.env.ANTHROPIC_BASE_URL;
delete config.env.ANTHROPIC_CUSTOM_HEADERS;
let effectiveApiKey = process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || "openrind-haloop-key";
if (effectiveApiKey.startsWith("openshell:") || effectiveApiKey.startsWith("${")) {
  effectiveApiKey = "openrind-haloop-key";
}
config.env.OPENAI_API_KEY = effectiveApiKey;
config.env.ANTHROPIC_API_KEY = effectiveApiKey;
config.env.OPENRIND_HALOOP_SESSION_CONTEXT = process.env.OPENRIND_HALOOP_SESSION_CONTEXT || "v1.00000000000000000000000000000000.1700000000.1800000000.0000000000000000000000000000000000000000000000000000000000000000";
config.env.OPENCLAW_CHILD_OOM_SCORE_ADJ = "0";
config.plugins = isObject(config.plugins) ? config.plugins : {};
config.plugins.deny = ["browser"];
delete config.models.providers.openrouter;
delete config.models.providers["openrind-haloop"];
delete config.models.providers.stringcost;
delete config.models.providers.anthropic;
delete config.models.providers.openai;
const modelId = primaryModel.slice(providerPrefix.length);
config.models.providers[PROVIDER_ID] = {
  baseUrl: PROVIDER_BASE_URL,
  apiKey: effectiveApiKey,
  api: "anthropic-messages",
  headers: {
    "x-openrind-haloop-session": "${OPENRIND_HALOOP_SESSION_CONTEXT}",
  },
  models: [{ id: modelId, name: modelId === DEFAULT_MODEL_ID ? "Claude Sonnet 4.6" : modelId }],
};

mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
mkdirSync(join(home, ".openclaw", "logs"), { recursive: true, mode: 0o700 });
const temporary = `${configPath}.tmp-${process.pid}`;
writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
renameSync(temporary, configPath);
chmodSync(configPath, 0o600);
