#!/usr/bin/env node

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const isTestingOpenRouter =
  Boolean(process.env.OPENROUTER_API_KEY) ||
  String(process.env.OPENRIND_DESKTOP_HALOOP_TEST_OPENROUTER || "").trim() === "1" ||
  String(process.env.ANTHROPIC_API_KEY || "").trim().startsWith("sk-or-");

export const HALOOP_ANTHROPIC_BASE_URL = isTestingOpenRouter
  ? "http://127.0.0.1:8785"
  : (process.env.HALOOP_ANTHROPIC_BASE_URL || process.env.HALOOP_GATEWAY_URL || "http://136.112.93.84:8787");

const workspaceHome =
  process.env.OPENRIND_SHELL_HOME ||
  process.env.OPENERAL_HOME ||
  "/sandbox/work";
const claudeHome =
  process.env.OPENRIND_SHELL_CLAUDE_HOME || workspaceHome;
const agent = process.env.OPENRIND_SHELL_AGENT || "claude";
const runtimeDir =
  process.env.OPENRIND_SHELL_RUNTIME_DIR ||
  process.env.OPENERAL_RUNTIME_DIR ||
  "/var/lib/openrind-shell/runtime";
const baseUrlPath = join(runtimeDir, "anthropic-base-url");
const shellEnvPath =
  process.env.OPENRIND_SHELL_ENV_FILE ||
  "/home/agent/.openrind-shell/env.sh";

function readObject(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function writeObject(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(path, 0o600);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function persistShellExport(path, name, value) {
  let source = "";
  try {
    source = readFileSync(path, "utf8");
  } catch {
    // A missing environment file is expected on first initialization.
  }
  const assignment = new RegExp(`^\\s*(?:export\\s+)?${name}=`, "u");
  const retained = source
    .split(/\r?\n/u)
    .filter((line) => !assignment.test(line));
  while (retained.at(-1) === "") retained.pop();
  retained.push(`export ${name}=${shellQuote(value)}`, "");

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, retained.join("\n"), { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function configureSettings(settingsPath) {
  const settings = readObject(settingsPath);
  settings.env =
    settings.env &&
    typeof settings.env === "object" &&
    !Array.isArray(settings.env)
      ? settings.env
      : {};
  settings.env.ANTHROPIC_BASE_URL = HALOOP_ANTHROPIC_BASE_URL;

  // OpenShell supplies the scoped client credential at request time. Never
  // persist either that token or an upstream provider key in agent state.
  delete settings.env.ANTHROPIC_API_KEY;
  delete settings.env.ANTHROPIC_AUTH_TOKEN;
  delete settings.env.ANTHROPIC_CUSTOM_HEADERS;
  delete settings.env.CLAUDE_API_KEY;
  delete settings.env.OPENRIND_GATEWAY_API_KEY;
  delete settings.env.STRINGCOST_API_KEY;
  delete settings.env.OPENRIND_GATEWAY_PROXY_URL;
  delete settings.env.STRINGCOST_PROXY_URL;

  writeObject(settingsPath, settings);
}

function configureClaudeHome() {
  configureSettings(join(claudeHome, ".claude", "settings.json"));

  // Claude's first-run UI probes Anthropic's account and OAuth endpoints
  // before it starts an agent. Openrind Shell is pre-provisioned for a scoped
  // API credential and intentionally permits only the Haloop inference paths,
  // so those direct onboarding probes must never run. Preserve unrelated
  // Claude state while recording that host-managed provisioning is complete.
  const configPath = join(claudeHome, ".claude.json");
  const config = readObject(configPath);
  config.hasCompletedOnboarding = true;
  config.customApiKeyResponses = { approved: ["ANTHROPIC_API_KEY"] };
  config.apiKeyApproval = "approved";
  writeObject(configPath, config);
}

function main() {
  configureSettings(join(workspaceHome, ".claude", "settings.json"));
  if (agent === "claude" && claudeHome !== workspaceHome) {
    configureClaudeHome();
  } else if (agent === "claude") {
    const configPath = join(claudeHome, ".claude.json");
    const config = readObject(configPath);
    config.hasCompletedOnboarding = true;
    config.customApiKeyResponses = { approved: ["ANTHROPIC_API_KEY"] };
    config.apiKeyApproval = "approved";
    writeObject(configPath, config);
  }

  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  writeFileSync(baseUrlPath, `${HALOOP_ANTHROPIC_BASE_URL}\n`, {
    mode: 0o600,
  });
  chmodSync(baseUrlPath, 0o600);
  persistShellExport(
    shellEnvPath,
    "ANTHROPIC_BASE_URL",
    HALOOP_ANTHROPIC_BASE_URL,
  );

  // Remove obsolete presign state so a resumed session cannot silently route
  // around Haloop through the retired gateway path.
  rmSync(join(workspaceHome, ".openrind-shell", "presign.json"), { force: true });
  rmSync(join(workspaceHome, ".openeral", "presign.json"), { force: true });
  process.stdout.write("setup-fuse.sh: Required Haloop routing configured\n");
}

main();
