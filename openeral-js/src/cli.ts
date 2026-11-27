#!/usr/bin/env node

/**
 * Openrind Shell CLI — run Claude Code inside an OpenShell sandbox.
 *
 * `openrind-shell` launches the primary PostgreSQL FUSE runtime. Inside the
 * sandbox, openrind-shell-init prepares the selected runtime and Claude starts
 * through its runtime-specific wrapper. `--compat` selects scoped just-bash
 * persistence explicitly.
 *
 * Usage:
 *   openrind-shell                          # primary PostgreSQL FUSE runtime
 *   openrind-shell --compat                 # scoped just-bash compatibility
 *   openrind-shell -- -p 'hello'            # non-interactive
 *   openrind-shell --workspace myid         # custom workspace ID
 *
 * Auth:
 *   OpenShell providers inject credential placeholders into each sandbox
 *   process. Openrind Gateway presigns are created inside the sandbox so raw keys
 *   remain inside OpenShell's credential boundary.
 *
 * Optional env:
 *   DATABASE_URL            Required by FUSE; optional in compatibility mode
 *   OPENRIND_SHELL_WORKSPACE_ID   Workspace ID (default: openrind-shell-claude)
 *   OPENRIND_SHELL_FUSE_IMAGE     Primary FUSE Dockerfile/image override
 *   OPENRIND_SHELL_COMPAT_IMAGE   Compatibility image override
 *   OPENSHELL_BIN            OpenShell CLI path (use the vendored build for FUSE)
 *   OPENSHELL_GATEWAY_ENDPOINT  Direct patched gateway endpoint
 *
 * Requires OpenShell >= 0.0.59 and a configured, reachable gateway.
 */

import { spawn, spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dbUrlFileForMarker,
  dataDirForMarker,
  initMarkerMatches,
  stateDirForMarker,
  workspaceIdForMarker,
  writeInitMarker,
} from './init-marker.js';
import { createPool } from './db/pool.js';
import type { DbPool } from './db/pool.js';
import {
  diffWorkspaces,
  emitWorkspacePatch,
  parseSnapshot,
  resolveWorkspaceCaptureConfig,
  serializeSnapshot,
  snapshotWorkspace,
} from './workspace-manifest.js';
import type { WorkspaceSnapshot } from './workspace-manifest.js';

const OPENSHELL_BIN = process.env.OPENSHELL_BIN?.trim() || 'openshell';
const OPENSHELL_GLOBAL_ARGS = process.env.OPENSHELL_GATEWAY_ENDPOINT?.trim()
  ? ['--gateway-endpoint', process.env.OPENSHELL_GATEWAY_ENDPOINT.trim()]
  : [];
const DEFAULT_WORKSPACE_ID = 'openrind-shell-claude';
const DEFAULT_COMPATIBILITY_IMAGE = 'ghcr.io/openrind/openrind-shell/sandbox:just-bash';

function renamedEnv(primary: string, legacy: string): string | undefined {
  return process.env[primary]?.trim() || process.env[legacy]?.trim() || undefined;
}

function openShellArgs(args: string[]): string[] {
  return [...OPENSHELL_GLOBAL_ARGS, ...args];
}

// ---------------------------------------------------------------------------
// Presign persistence. Read the old path, but write only the canonical path.
// ---------------------------------------------------------------------------

interface StoredPresign {
  /** Full URL as returned by Openrind Gateway or legacy StringCost. */
  url: string;
  createdAt: string;
  openrindGatewayApiKey?: string;
  /** Legacy field retained when importing ~/.config/openeral/presign.json. */
  stringcostApiKey?: string;
}

function getPresignConfigPath(): string {
  return join(homedir(), '.config', 'openrind-shell', 'presign.json');
}

function loadStoredPresign(): StoredPresign | null {
  const paths = [
    getPresignConfigPath(),
    join(homedir(), '.config', 'openeral', 'presign.json'),
  ];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      const data = JSON.parse(readFileSync(path, 'utf8')) as StoredPresign;
      if (data?.url) return data;
    } catch {
      // Try the legacy path before reporting no stored presign.
    }
  }
  return null;
}

function saveStoredPresign(url: string, apiKey?: string): void {
  const configDir = join(homedir(), '.config', 'openrind-shell');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const presignPath = getPresignConfigPath();
  const data: StoredPresign = { url, createdAt: new Date().toISOString() };
  if (apiKey) data.openrindGatewayApiKey = apiKey;
  writeFileSync(presignPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  // Ensure restrictive permissions (covers cases where mode is ignored)
  try {
    chmodSync(presignPath, 0o600);
  } catch {
    // Ignore chmod errors on platforms that don't support it
  }
}

export function openrindGatewayProxyBaseUrl(presignUrl: string): string {
  const url = new URL(presignUrl.trim());
  url.pathname = url.pathname.replace(/\/v1\/.*$/, '');
  url.search = '';
  url.hash = '';
  const normalized = url.toString().replace(/\/$/, '');
  if (!/^https:\/\/(?:proxy\.openrind\.com\/openrind-gateway-proxy|proxy\.stringcost\.com\/stringcost-proxy)\/t\/[^/]+$/.test(normalized)) {
    throw new Error('Unexpected Openrind Gateway presign URL shape');
  }
  return normalized;
}

/**
 * Create a new Openrind Gateway presign. Legacy StringCost keys use the legacy
 * endpoint so existing installations continue to work during the rename.
 */
async function createPresignUrl(
  anthropicKey: string,
  gatewayKey: string,
  legacyGateway = false,
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

  try {
    const response = await fetch(
      legacyGateway ? 'https://app.stringcost.com/v1/presign' : 'https://app.openrind.com/v1/presign',
      {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${gatewayKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        provider: 'anthropic',
        client_api_key: anthropicKey,
        path: ['/v1/messages'],
        expires_in: -1,
        max_uses: -1,
        cost_limit: 10000000, // $10 in micro-dollars
        tags: ['openrind-shell'],
        metadata: { source: 'openrind-shell' },
      }),
      signal: controller.signal,
      },
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Openrind Gateway presign failed (${response.status}): ${text}`);
    }

    const data = await response.json() as { url: string };
    if (!data?.url) throw new Error('Openrind Gateway presign returned no URL');
    return data.url;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Openrind Gateway presign request timed out after 30 seconds');
    }
    throw err;
  }
}


type ParsedArgs = 
  | { kind: 'launch'; workspaceId: string; claudeArgs: string[] }
  | { kind: 'memory-refresh'; workspaceId: string; projectRoot: string; query: string; dryRun: boolean; backup: boolean }
  | { kind: 'help' };

export function parseCliArgs(args: string[]): ParsedArgs {
  // Check for help
  if (args.includes('--help') || args.includes('-h')) {
    const dashIdx = args.indexOf('--');
    const helpIdx = Math.max(args.indexOf('--help'), args.indexOf('-h'));
    if (dashIdx === -1 || helpIdx < dashIdx) {
      return { kind: 'help' };
    }
  }

  // Check for memory refresh command
  if (args[0] === 'memory' && args[1] === 'refresh') {
    let workspaceId = renamedEnv('OPENRIND_SHELL_WORKSPACE_ID', 'OPENERAL_WORKSPACE_ID')
      || DEFAULT_WORKSPACE_ID;
    let projectRoot = '';
    let query = '';
    let dryRun = false;
    let backup = true;

    for (let i = 2; i < args.length; i++) {
      if ((args[i] === '--workspace' || args[i] === '-w') && args[i + 1]) {
        workspaceId = args[++i];
      } else if (args[i] === '--project-root' && args[i + 1]) {
        projectRoot = args[++i];
      } else if (args[i] === '--query' && args[i + 1]) {
        query = args[++i];
      } else if (args[i] === '--dry-run') {
        dryRun = true;
      } else if (args[i] === '--no-backup') {
        backup = false;
      }
    }

    // Normalize workspace ID to be Kubernetes-compliant
    const originalId = workspaceId;
    workspaceId = workspaceId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
    
    // Prevent empty workspace ID
    if (workspaceId.length === 0) {
      workspaceId = DEFAULT_WORKSPACE_ID;
      process.stderr.write(`\x1b[33mwarning: workspace ID "${originalId}" normalized to empty string, using default: ${workspaceId}\x1b[0m\n`);
    }

    return { kind: 'memory-refresh', workspaceId, projectRoot, query, dryRun, backup };
  }

  // Default: launch mode
  let workspaceId = renamedEnv('OPENRIND_SHELL_WORKSPACE_ID', 'OPENERAL_WORKSPACE_ID')
    || DEFAULT_WORKSPACE_ID;
  let claudeArgs: string[] = [];

  const dashIdx = args.indexOf('--');
  const ownArgs = dashIdx >= 0 ? args.slice(0, dashIdx) : args;
  claudeArgs = dashIdx >= 0 ? args.slice(dashIdx + 1) : [];

  for (let i = 0; i < ownArgs.length; i++) {
    if ((ownArgs[i] === '--workspace' || ownArgs[i] === '-w') && ownArgs[i + 1]) {
      workspaceId = ownArgs[++i];
    }
  }

  // Normalize workspace ID to be Kubernetes-compliant (lowercase, alphanumeric + hyphens)
  const originalId = workspaceId;
  workspaceId = workspaceId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
  
  // Prevent empty workspace ID
  if (workspaceId.length === 0) {
    workspaceId = DEFAULT_WORKSPACE_ID;
    process.stderr.write(`\x1b[33mwarning: workspace ID "${originalId}" normalized to empty string, using default: ${workspaceId}\x1b[0m\n`);
  }

  return { kind: 'launch', workspaceId, claudeArgs };
}

function printHelp(): void {
  console.log(`Usage:
  openrind-shell [options] [-- claude-args]  Launch primary PostgreSQL FUSE runtime
  openrind-shell --compat [options] [-- args]  Launch scoped compatibility runtime
  openrind-shell presign                     Show the current gateway presign
  openrind-shell presign renew               Create and store a gateway presign
  openrind-shell init [--ensure]             Initialize or verify sandbox state
  openrind-shell workspace-manifest snapshot|diff
                                             Capture FUSE workspace change manifests
  openrind-shell stats [options]             Show API usage statistics
  openrind-shell analyze [options]           Analyze session history
  openrind-shell apply [options]             Apply optimization suggestions
  openrind-shell memory refresh [options]    Refresh Claude memory

Launch Options:
  --workspace, -w <id>    Workspace ID (default: openrind-shell-claude)
  --compat                Use stock-OpenShell/PGlite compatibility runtime
  --dev, -d               Legacy alias for the primary source FUSE runtime
  --help, -h              Show this help

Stats / Analyze / Apply Options:
  --workspace, -w <id>    Workspace ID (default: hostname)
  --days <n>              Number of days to look back (default: 7)
  --project-root <p>      Project root directory (analyze/apply only)
  --dry-run               Preview changes without applying (apply only)
  --proposal <id>         Apply a specific proposal by ID (apply only)
  --json                  Output as JSON (analyze only)

Memory Refresh Options:
  --workspace, -w <id>    Workspace ID
  --project-root <path>   Project root directory
  --query <text>          Search query
  --dry-run               Preview changes without applying
  --no-backup             Skip backup creation

Auth:
  ANTHROPIC_API_KEY is resolved through the OpenShell Claude provider.
  OPENRIND_GATEWAY_API_KEY enables Openrind Gateway metering. The legacy
  STRINGCOST_API_KEY name is accepted during migration. Raw keys stay behind
  OpenShell provider resolution.

Optional env:
  DATABASE_URL             Required by FUSE; optional for compatibility
  OPENRIND_SHELL_WORKSPACE_ID    Default workspace ID
  OPENRIND_SHELL_FUSE_IMAGE      FUSE Dockerfile/image (default: repository Dockerfile)
  OPENRIND_SHELL_COMPAT_IMAGE    Compatibility image (default: ${DEFAULT_COMPATIBILITY_IMAGE})
  OPENSHELL_BIN             OpenShell CLI path (vendored patched build for FUSE)
  OPENSHELL_GATEWAY_ENDPOINT  Direct gateway endpoint

Features:
  - OpenShell-managed credentials and default-deny network policy
  - OpenShell-supervised /sandbox/work FUSE home; no host filesystem injection
  - Full PostgreSQL-backed FUSE workspace by default
  - Scoped PostgreSQL/PGlite persistence only with --compat
  - API usage statistics and optimization suggestions

Notes:
  - Presign stored in ~/.config/openrind-shell/presign.json (mode 600)
  - Legacy openeral command and OPENERAL_* environment aliases remain supported
  - Internal PostgreSQL schema stays _openeral to preserve existing volumes
  - Workspace IDs are automatically normalized to be Kubernetes-compliant
  - OpenShell >= 0.0.59 and a selected gateway are required
  - Claude CLI comes from the OpenShell Community base image
  - Existing sandboxes with the same name will be cleaned up automatically
`);
}

// ---------------------------------------------------------------------------
// Openrind Gateway organization skills
// ---------------------------------------------------------------------------

/**
 * Fetch the org skills bundle and return only validated entries.
 *
 * Handles timeout, HTTP errors, and slug validation.
 * Slugs are validated against `[a-z0-9][a-z0-9-]*` to prevent path traversal.
 *
 * Throws on network/HTTP failure — callers decide whether to propagate or warn.
 */
export async function fetchOrgSkills(
  apiKey: string,
  legacyGateway = false,
): Promise<Array<{ slug: string; content: string }>> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  let res: Response;
  try {
    res = await fetch(
      legacyGateway
        ? 'https://app.stringcost.com/v2/skills/bundle'
        : 'https://app.openrind.com/v2/skills/bundle',
      {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      },
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { skills: Array<{ slug: string; content: string }> };

  return (data.skills ?? []).filter(s => /^[a-z0-9][a-z0-9-]*$/.test(s.slug));
}

/**
 * Download organization skills into `homeDir/.claude/skills/`.
 *
 * Each skill is a directory named by its slug with a `SKILL.md` file inside.
 *
 * Returns the number of skills written.
 */
export async function downloadOrgSkills(homeDir: string, apiKey: string): Promise<number> {
  const skills = await fetchOrgSkills(apiKey);

  const skillsDir = join(homeDir, '.claude', 'skills');
  mkdirSync(skillsDir, { recursive: true });

  for (const skill of skills) {
    const skillDir = join(skillsDir, skill.slug);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), skill.content);
  }

  return skills.length;
}

function refreshClaudeProxySettings(): void {
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  if (!baseUrl) return;

  const home = process.env.OPENRIND_SHELL_HOME
    || process.env.OPENERAL_HOME
    || process.env.HOME
    || '/sandbox';
  const settingsPath = join(home, '.claude', 'settings.json');
  mkdirSync(dirname(settingsPath), { recursive: true });

  let settings: Record<string, any> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, any>;
    } catch {
      settings = {};
    }
  }
  settings.env = settings.env && typeof settings.env === 'object' ? settings.env : {};
  settings.env.ANTHROPIC_BASE_URL = baseUrl;
  delete settings.env.ANTHROPIC_API_KEY;
  delete settings.env.ANTHROPIC_AUTH_TOKEN;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

async function cmdInit(args: string[]): Promise<void> {
  if (args.includes('--check-marker')) {
    process.exit(initMarkerMatches() ? 0 : 1);
  }

  if (args.includes('--write-marker')) {
    writeInitMarker();
    return;
  }

  const ensure = args.includes('--ensure');
  if (ensure && initMarkerMatches()) {
    refreshClaudeProxySettings();
    process.stderr.write('\x1b[2mopenrind-shell: init already complete\x1b[0m\n');
    return;
  }

  const setupPath = existsSync('/opt/openrind-shell/setup.sh')
    ? '/opt/openrind-shell/setup.sh'
    : '/opt/openeral/setup.sh';
  if (!existsSync(setupPath)) {
    if (ensure) {
      throw new Error(`init marker is missing or stale, and ${setupPath} is not available`);
    }
    throw new Error(`${setupPath} is required for in-sandbox init`);
  }

  const result = spawnSync(setupPath, [], {
    stdio: 'inherit',
    env: {
      ...process.env,
      HOME: process.env.HOME || '/sandbox',
      OPENRIND_SHELL_HOME: process.env.OPENRIND_SHELL_HOME
        || process.env.OPENERAL_HOME
        || '/sandbox',
      OPENERAL_HOME: process.env.OPENRIND_SHELL_HOME
        || process.env.OPENERAL_HOME
        || '/sandbox',
      OPENRIND_SHELL_STATE_DIR: stateDirForMarker(),
      OPENERAL_STATE_DIR: stateDirForMarker(),
      OPENRIND_SHELL_DATA_DIR: dataDirForMarker(),
      OPENERAL_DATA_DIR: dataDirForMarker(),
      OPENRIND_SHELL_DB_URL_FILE: dbUrlFileForMarker(),
      OPENERAL_DB_URL_FILE: dbUrlFileForMarker(),
      WORKSPACE_ID: workspaceIdForMarker(),
    },
  });

  if (result.error) throw result.error;
  const status = result.status ?? 1;
  if (status !== 0) process.exit(status);
}

// ---------------------------------------------------------------------------
// OpenShell sandbox launch
// ---------------------------------------------------------------------------

const MIN_OPENSHELL_VERSION = [0, 0, 59] as const;

function parseOpenShellVersion(output: string): [number, number, number] | null {
  const match = output.match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:\s|$)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(
  actual: readonly number[],
  minimum: readonly number[],
): boolean {
  for (let i = 0; i < Math.max(actual.length, minimum.length); i++) {
    const current = actual[i] ?? 0;
    const required = minimum[i] ?? 0;
    if (current !== required) return current > required;
  }
  return true;
}

function requireCurrentOpenShell(requireFuse = false): void {
  const versionResult = spawnSync(OPENSHELL_BIN, ['--version'], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (versionResult.error) {
    const code = (versionResult.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(
        `OpenShell is not installed or executable at ${OPENSHELL_BIN}. Install OpenShell first: https://docs.nvidia.com/openshell/latest`,
      );
    }
    throw versionResult.error;
  }
  if (versionResult.status !== 0) {
    throw new Error('openshell --version failed');
  }

  const versionText = `${versionResult.stdout ?? ''} ${versionResult.stderr ?? ''}`;
  const version = parseOpenShellVersion(versionText);
  if ((!version || !versionAtLeast(version, MIN_OPENSHELL_VERSION)) && !requireFuse) {
    throw new Error(
      `OpenShell >= ${MIN_OPENSHELL_VERSION.join('.')} is required; found ${versionText.trim() || 'an unknown version'}`,
    );
  }

  const gateway = spawnSync(OPENSHELL_BIN, openShellArgs(['gateway', 'info']), {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 15_000,
  });
  if (gateway.error || gateway.status !== 0) {
    throw new Error(
      'no reachable OpenShell gateway is selected. Configure one or set OPENSHELL_GATEWAY_ENDPOINT.',
    );
  }

  if (requireFuse) {
    const help = spawnSync(OPENSHELL_BIN, openShellArgs(['sandbox', 'create', '--help']), {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 15_000,
    });
    const output = `${help.stdout ?? ''}\n${help.stderr ?? ''}`;
    if (help.error || help.status !== 0 || !output.includes('--fuse')) {
      throw new Error(
        'this Openrind Shell image requires an OpenShell build with the policy-gated --fuse capability',
      );
    }
  }
}

/**
 * Walk up from the compiled file's directory to find the repository root.
 *
 * Looks for `sandboxes/openeral/Dockerfile` as a landmark file so the
 * result is correct regardless of where in the build output the CLI ends up.
 */
export function findRepoRoot(maxLevels = 6): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < maxLevels; i++) {
    if (existsSync(join(dir, 'sandboxes', 'openeral', 'Dockerfile'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function ensureGenericProvider(name: string, credentialKey: string): void {
  const existing = spawnSync(OPENSHELL_BIN, openShellArgs(['provider', 'get', name]), {
    stdio: 'ignore',
    timeout: 15_000,
  });
  const args = existing.status === 0
    ? ['provider', 'update', name, '--credential', credentialKey]
    : ['provider', 'create', '--name', name, '--type', 'generic', '--credential', credentialKey];
  const result = spawnSync(OPENSHELL_BIN, openShellArgs(args), {
    stdio: 'inherit',
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`failed to register OpenShell provider ${name}`);
  }
}

function removeExistingSandbox(name: string): void {
  const existing = spawnSync(OPENSHELL_BIN, openShellArgs(['sandbox', 'get', name]), {
    stdio: 'ignore',
    timeout: 15_000,
  });
  if (existing.status !== 0) return;

  process.stderr.write(`\x1b[2mopenrind-shell: replacing existing sandbox ${name}...\x1b[0m\n`);
  const removed = spawnSync(OPENSHELL_BIN, openShellArgs(['sandbox', 'delete', name]), {
    stdio: 'inherit',
    timeout: 120_000,
  });
  if (removed.error) throw removed.error;
  if (removed.status !== 0) {
    throw new Error(`failed to delete existing sandbox ${name}`);
  }
}

// ---------------------------------------------------------------------------
// presign commands
// ---------------------------------------------------------------------------

/**
 * Show the currently stored Openrind Gateway presign.
 */
async function cmdPresignShow(): Promise<void> {
  const stored = loadStoredPresign();
  if (!stored) {
    console.log('No presign stored.');
    console.log('');
    console.log('Set OPENRIND_GATEWAY_API_KEY and ANTHROPIC_API_KEY, then run:');
    console.log('  openrind-shell presign renew');
    return;
  }

  const gateway = stored.url.includes('/stringcost-proxy/')
    ? await import('./optimize/stringcost-api.js')
    : await import('./optimize/openrind-gateway-api.js');
  const decoded = gateway.decodePresignUrl(stored.url);

  console.log('Openrind Gateway presign (currently in use):');
  console.log(`  Proxy URL:  ${stored.url.replace(/\/v1\/.*$/, '')}`);
  console.log(`  Full URL:   ${stored.url}`);
  console.log(`  Created:    ${new Date(stored.createdAt).toLocaleString()}`);
  if (decoded.sessionId) console.log(`  Session ID: ${decoded.sessionId}`);
  const storedGatewayKey = stored.openrindGatewayApiKey || stored.stringcostApiKey;
  if (storedGatewayKey) {
    const k = storedGatewayKey;
    const masked = k.length > 8 ? `${k.slice(0, 4)}...${k.slice(-4)}` : '****';
    console.log(`  Gateway API key: ${masked}  (stored for automatic skill downloads)`);
  } else {
    console.log('  Gateway API key: not stored; run `openrind-shell presign renew`');
  }
  console.log('');
  console.log('Settings: expires_in=-1  max_uses=-1  cost_limit=10$  (all infinite, never exhausts)');
}

/**
 * Create a new Openrind Gateway presign and persist it.
 *
 * Prompts for ANTHROPIC_API_KEY and OPENRIND_GATEWAY_API_KEY if needed.
 * Writes the new presign to:
 *   - ~/.config/openrind-shell/presign.json
 *   - ~/.claude/settings.json          (Claude Code picks this up automatically)
 */
async function cmdPresignRenew(): Promise<void> {
  let anthropicKey = (process.env.ANTHROPIC_API_KEY ?? '').replace('@anthropic_api_key', '').trim();
  const openrindGatewayKey = (process.env.OPENRIND_GATEWAY_API_KEY ?? '')
    .replace('@openrind_gateway_api_key', '')
    .trim();
  const legacyGatewayKey = (process.env.STRINGCOST_API_KEY ?? '')
    .replace('@stringcost_api_key', '')
    .trim();
  let gatewayKey = openrindGatewayKey || legacyGatewayKey;
  let legacyGateway = !openrindGatewayKey && !!legacyGatewayKey;

  if (!anthropicKey || !gatewayKey) {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        '\x1b[31merror: ANTHROPIC_API_KEY and OPENRIND_GATEWAY_API_KEY must be set\x1b[0m\n',
      );
      process.exit(1);
    }

    const { createInterface } = await import('node:readline');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const question = (prompt: string): Promise<string> =>
      new Promise(resolve => rl.question(prompt, resolve));

    try {
      if (!anthropicKey) {
        anthropicKey = (await question('Anthropic API key: ')).trim();
      }
      if (!gatewayKey) {
        gatewayKey = (await question('Openrind Gateway API key: ')).trim();
        legacyGateway = false;
      }
    } finally {
      rl.close();
    }
  }

  if (!anthropicKey || !gatewayKey) {
    process.stderr.write('\x1b[31merror: both API keys are required\x1b[0m\n');
    process.exit(1);
  }

  console.log('Creating new presign (expires_in=-1, max_uses=-1, cost_limit=10$)...');

  try {
    const fullUrl = await createPresignUrl(anthropicKey, gatewayKey, legacyGateway);
    const baseUrl = openrindGatewayProxyBaseUrl(fullUrl);

    // Store the API key so organization skills can be downloaded later.
    saveStoredPresign(fullUrl, gatewayKey);
    console.log(`\x1b[32m✓ Stored in ${getPresignConfigPath()}\x1b[0m`);

    // 2. Write into host Claude Code settings so Claude picks it up automatically
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    try {
      mkdirSync(join(homedir(), '.claude'), { recursive: true });
      let settings: Record<string, unknown> = {};
      if (existsSync(settingsPath)) {
        try {
          settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
        } catch { /* corrupt/empty — start fresh */ }
      }
      const env = (settings.env ?? {}) as Record<string, string>;
      env.ANTHROPIC_BASE_URL = baseUrl;
      env.ANTHROPIC_AUTH_TOKEN = 'dummy';
      settings.env = env;
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      console.log(`\x1b[32m✓ Written to ${settingsPath}\x1b[0m`);
    } catch (err) {
      process.stderr.write(
        `\x1b[33mwarning: could not write to ~/.claude/settings.json: ${(err as Error).message}\x1b[0m\n`,
      );
    }

    console.log('');
    console.log(`\x1b[32m✓ Presign created and stored\x1b[0m`);
    console.log(`  Proxy URL: ${baseUrl}`);
    console.log('');
    console.log('This presign will be reused for all future sessions (never expires).');
    console.log('Run "openrind-shell presign" to view or renew it.');
  } catch (err) {
    process.stderr.write(`\x1b[31merror: ${(err as Error).message}\x1b[0m\n`);
    process.exit(1);
  }
}
/**
 * Launch Claude Code through the public OpenShell CLI contract.
 *
 * The create-time command performs one-shot initialization and exits. Claude is
 * then started with sandbox exec; its wrapper owns lazy daemon startup and the
 * post-session persistence flush.
 */
async function launchViaSandbox(
  workspaceId: string,
  claudeArgs: string[],
  runtime: 'fuse' | 'compatibility' = 'fuse',
): Promise<void> {
  const fuseRuntime = runtime === 'fuse';
  const repoRoot = fuseRuntime ? findRepoRoot() : null;
  const sandboxSource = fuseRuntime
    ? (renamedEnv('OPENRIND_SHELL_FUSE_IMAGE', 'OPENERAL_FUSE_IMAGE')
      ?? renamedEnv('OPENRIND_SHELL_DEV_IMAGE', 'OPENERAL_DEV_IMAGE')
      ?? (repoRoot
        ? join(
          repoRoot,
          existsSync(join(repoRoot, 'Dockerfile.openrind-shell'))
            ? 'Dockerfile.openrind-shell'
            : 'Dockerfile.openeral',
        )
        : null))
    : (renamedEnv('OPENRIND_SHELL_COMPAT_IMAGE', 'OPENERAL_COMPAT_IMAGE')
      ?? renamedEnv('OPENRIND_SHELL_SANDBOX_IMAGE', 'OPENERAL_SANDBOX_IMAGE')
      ?? DEFAULT_COMPATIBILITY_IMAGE);
  if (!sandboxSource) {
    throw new Error('could not locate Dockerfile.openrind-shell; set OPENRIND_SHELL_FUSE_IMAGE');
  }
  requireCurrentOpenShell(fuseRuntime);

  removeExistingSandbox(workspaceId);

  const storedPresign = loadStoredPresign();
  const openrindGatewayKey = (process.env.OPENRIND_GATEWAY_API_KEY ?? '')
    .replace('@openrind_gateway_api_key', '')
    .trim();
  const legacyGatewayKey = (process.env.STRINGCOST_API_KEY ?? '')
    .replace('@stringcost_api_key', '')
    .trim();
  const gatewayKey = openrindGatewayKey || legacyGatewayKey;
  const legacyGateway = !openrindGatewayKey && !!legacyGatewayKey;
  if (!storedPresign && gatewayKey) {
    ensureGenericProvider(
      legacyGateway ? 'stringcost' : 'openrind-gateway',
      legacyGateway ? 'STRINGCOST_API_KEY' : 'OPENRIND_GATEWAY_API_KEY',
    );
  }

  const temporaryPaths: string[] = [];
  const sandboxArgs: string[] = [
    'sandbox', 'create',
    '--name', workspaceId,
    '--from', sandboxSource,
    '--no-tty',
  ];
  if (fuseRuntime) sandboxArgs.push('--fuse');

  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
  if (fuseRuntime && !dbUrl) {
    throw new Error('DATABASE_URL is required by the FUSE runtime; use the compatibility image for PGlite');
  }
  if (dbUrl) {
    const dbUploadPath = join(tmpdir(), `openrind-shell-db-url-${process.pid}-${Date.now()}`);
    writeFileSync(dbUploadPath, dbUrl, { mode: 0o600 });
    chmodSync(dbUploadPath, 0o600);
    temporaryPaths.push(dbUploadPath);
    sandboxArgs.push('--upload', `${dbUploadPath}:/sandbox/db-url`);
  }

  // Workspace change capture (FUSE/DB manifest). The start snapshot's merkle
  // root is exported into the sandbox so the in-sandbox proxy can stamp it as
  // a session attribute; the end-of-session diff is emitted after Claude exits.
  let workspacePool: DbPool | null = null;
  let workspaceStartSnapshot: WorkspaceSnapshot | null = null;
  if (fuseRuntime && dbUrl) {
    try {
      workspacePool = createPool(dbUrl);
      workspaceStartSnapshot = await snapshotWorkspace(workspacePool, workspaceId, { includeContent: true });
      sandboxArgs.push('--env', `OPENRIND_WORKSPACE_HASH=${workspaceStartSnapshot.rootHash}`);
      process.stderr.write(
        `\x1b[2mopenrind-shell: workspace start hash ${workspaceStartSnapshot.rootHash.slice(0, 16)} (${workspaceStartSnapshot.entries.length} files)\x1b[0m\n`,
      );
    } catch (err) {
      process.stderr.write(`\x1b[33mwarning: workspace start snapshot failed: ${(err as Error).message}\x1b[0m\n`);
      workspaceStartSnapshot = null;
      if (workspacePool) {
        await workspacePool.end().catch(() => {});
        workspacePool = null;
      }
    }
  }

  if (storedPresign) {
    const presignUploadPath = join(tmpdir(), `openrind-shell-presign-${process.pid}-${Date.now()}.json`);
    writeFileSync(
      presignUploadPath,
      JSON.stringify({ url: storedPresign.url }, null, 2),
      { mode: 0o600 },
    );
    chmodSync(presignUploadPath, 0o600);
    temporaryPaths.push(presignUploadPath);
    sandboxArgs.push('--upload', `${presignUploadPath}:/sandbox/openrind-gateway-presign`);
  } else {
    sandboxArgs.push('--provider', 'claude');
    if (gatewayKey) sandboxArgs.push('--provider', legacyGateway ? 'stringcost' : 'openrind-gateway');
    sandboxArgs.push('--auto-providers');
  }

  sandboxArgs.push(
    '--env', `OPENRIND_SHELL_WORKSPACE_ID=${workspaceId}`,
    '--env', `WORKSPACE_ID=${workspaceId}`,
    '--',
    'openrind-shell-init',
  );

  let skillsRoot: string | undefined;
  const skillsKey = gatewayKey
    || storedPresign?.openrindGatewayApiKey?.trim()
    || storedPresign?.stringcostApiKey?.trim()
    || '';
  const legacySkillsGateway = legacyGateway
    || (!storedPresign?.openrindGatewayApiKey && !!storedPresign?.stringcostApiKey);
  if (skillsKey) {
    try {
      const skills = await fetchOrgSkills(skillsKey, legacySkillsGateway);
      if (skills.length > 0) {
        skillsRoot = join(tmpdir(), `openrind-shell-skills-${process.pid}-${Date.now()}`);
        const skillsDir = join(skillsRoot, 'skills');
        for (const skill of skills) {
          const skillDir = join(skillsDir, skill.slug);
          mkdirSync(skillDir, { recursive: true });
          writeFileSync(join(skillDir, 'SKILL.md'), skill.content);
        }
        temporaryPaths.push(skillsRoot);
        process.stderr.write(
          `\x1b[32mDownloaded ${skills.length} Openrind Gateway org skill${skills.length === 1 ? '' : 's'}\x1b[0m\n`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `\x1b[33mwarning: Openrind Gateway skill download failed: ${message}\x1b[0m\n`,
      );
    }
  }

  process.stderr.write(
    `\x1b[2mopenrind-shell: creating OpenShell sandbox ${workspaceId} from ${sandboxSource}...\x1b[0m\n`,
  );

  try {
    const created = spawnSync(OPENSHELL_BIN, openShellArgs(sandboxArgs), {
      stdio: 'inherit',
      timeout: 15 * 60_000,
    });
    if (created.error) throw created.error;
    if (created.status !== 0) {
      throw new Error(`openshell sandbox create failed with exit code ${created.status ?? 1}`);
    }

    if (skillsRoot) {
      const uploaded = spawnSync(
        OPENSHELL_BIN,
        openShellArgs([
          'sandbox', 'upload', workspaceId, join(skillsRoot, 'skills'),
          fuseRuntime ? '/sandbox/work/.claude/' : '/sandbox/.claude/',
        ]),
        { stdio: 'inherit', timeout: 120_000 },
      );
      if (uploaded.error) throw uploaded.error;
      if (uploaded.status !== 0) {
        process.stderr.write(
          '\x1b[33mwarning: Openrind Gateway org skills could not be uploaded\x1b[0m\n',
        );
      }
    }
  } finally {
    for (const path of temporaryPaths) {
      try { rmSync(path, { recursive: true, force: true }); } catch {}
    }
  }

  process.stderr.write(
    `\x1b[2mopenrind-shell: starting Claude Code in ${workspaceId}...\x1b[0m\n`,
  );
  const child = spawn(
    OPENSHELL_BIN,
    openShellArgs([
      'sandbox', 'exec', '--name', workspaceId,
      '--workdir', fuseRuntime ? '/sandbox/work' : '/sandbox',
      '--', 'claude', ...claudeArgs,
    ]),
    { stdio: 'inherit' },
  );

  const forwarders = new Map<NodeJS.Signals, () => void>();
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    const forward = () => child.kill(signal);
    forwarders.set(signal, forward);
    process.on(signal, forward);
  }

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code !== null) {
        resolve(code);
      } else {
        resolve(signal === 'SIGINT' ? 130 : 1);
      }
    });
  }).finally(() => {
    for (const [signal, forward] of forwarders) {
      process.off(signal, forward);
    }
  });

  // Session end: diff the workspace against the start snapshot and emit the
  // patch as a model_patch artifact. Best-effort: capture failures warn but
  // never change the session's exit code.
  if (workspacePool) {
    try {
      if (workspaceStartSnapshot) {
        const endSnapshot = await snapshotWorkspace(workspacePool, workspaceId, { includeContent: true });
        const diff = diffWorkspaces(workspaceStartSnapshot, endSnapshot);
        const changed = diff.added.length + diff.modified.length + diff.deleted.length;
        if (changed > 0) {
          const capture = resolveWorkspaceCaptureConfig(process.env);
          if (capture.enabled) {
            const result = await emitWorkspacePatch({ ...capture, sessionId: workspaceId, diff });
            process.stderr.write(
              `\x1b[2mopenrind-shell: workspace patch ${result.artifactId} emitted (${diff.added.length} added, ${diff.modified.length} modified, ${diff.deleted.length} deleted)\x1b[0m\n`,
            );
          } else {
            process.stderr.write(
              `\x1b[2mopenrind-shell: workspace changed (${changed} files); collector not configured, patch not emitted\x1b[0m\n`,
            );
          }
        }
      }
    } catch (err) {
      process.stderr.write(`\x1b[33mwarning: workspace end-of-session diff failed: ${(err as Error).message}\x1b[0m\n`);
    } finally {
      await workspacePool.end().catch(() => {});
    }
  }

  if (exitCode !== 0) process.exitCode = exitCode;
}

// ---------------------------------------------------------------------------
// workspace-manifest commands
// ---------------------------------------------------------------------------

function workspaceManifestDir(): string {
  return join(homedir(), '.config', 'openrind-shell', 'workspace-manifest');
}

/**
 * Manual workspace change capture for sessions that did not go through the
 * launch flow: `snapshot` stores a start manifest, `diff` compares the current
 * volume against it and can emit the patch to the collector.
 */
async function cmdWorkspaceManifest(args: string[]): Promise<void> {
  const sub = args[0];
  let workspaceId = renamedEnv('OPENRIND_SHELL_WORKSPACE_ID', 'OPENERAL_WORKSPACE_ID')
    || DEFAULT_WORKSPACE_ID;
  let session = '';
  let emit = false;
  let outPath = '';
  for (let i = 1; i < args.length; i++) {
    if ((args[i] === '--workspace' || args[i] === '-w') && args[i + 1]) {
      workspaceId = args[++i];
    } else if (args[i] === '--session' && args[i + 1]) {
      session = args[++i];
    } else if (args[i] === '--emit') {
      emit = true;
    } else if (args[i] === '--out' && args[i + 1]) {
      outPath = args[++i];
    }
  }
  workspaceId = workspaceId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
  if (workspaceId.length === 0) workspaceId = DEFAULT_WORKSPACE_ID;
  const sessionId = session || workspaceId;

  if (sub !== 'snapshot' && sub !== 'diff') {
    process.stderr.write(
      'Usage: openrind-shell workspace-manifest <snapshot|diff> [--workspace <id>] [--session <id>] [--emit] [--out <path>]\n',
    );
    process.exit(1);
  }

  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
  if (!dbUrl) {
    process.stderr.write('\x1b[31merror: DATABASE_URL is required for workspace-manifest\x1b[0m\n');
    process.exit(1);
  }

  const pool = createPool(dbUrl);
  try {
    if (sub === 'snapshot') {
      const snapshot = await snapshotWorkspace(pool, workspaceId, { includeContent: true });
      mkdirSync(workspaceManifestDir(), { recursive: true, mode: 0o700 });
      const file = join(workspaceManifestDir(), `${sessionId}.json`);
      writeFileSync(file, serializeSnapshot(snapshot), { mode: 0o600 });
      try { chmodSync(file, 0o600); } catch {}
      console.log(`workspace ${workspaceId}: ${snapshot.entries.length} files, root ${snapshot.rootHash}`);
      console.log(`snapshot stored in ${file}`);
      return;
    }

    const file = join(workspaceManifestDir(), `${sessionId}.json`);
    if (!existsSync(file)) {
      process.stderr.write(
        `\x1b[31merror: no stored start snapshot for session ${sessionId} (run: openrind-shell workspace-manifest snapshot --session ${sessionId})\x1b[0m\n`,
      );
      process.exit(1);
    }
    const startSnapshot = parseSnapshot(readFileSync(file, 'utf8'));
    const endSnapshot = await snapshotWorkspace(pool, workspaceId, { includeContent: true });
    const diff = diffWorkspaces(startSnapshot, endSnapshot);
    console.log(
      `workspace ${workspaceId}: ${diff.added.length} added, ${diff.modified.length} modified, ${diff.deleted.length} deleted`,
    );
    console.log(`start ${diff.startRootHash}`);
    console.log(`end   ${diff.endRootHash}`);
    if (outPath) {
      writeFileSync(outPath, diff.patchText, { mode: 0o600 });
      console.log(`patch written to ${outPath}`);
    } else if (diff.patchText) {
      console.log(`\n${diff.patchText}`);
    }
    if (emit) {
      const capture = resolveWorkspaceCaptureConfig(process.env);
      if (!capture.enabled) {
        process.stderr.write(
          '\x1b[31merror: collector URL/producer token not configured (HALOOP_COLLECTOR_URL, W8_CAPTURE_PRODUCER_TOKEN)\x1b[0m\n',
        );
        process.exit(1);
      }
      const result = await emitWorkspacePatch({ ...capture, sessionId, diff });
      console.log(
        `emitted ${result.artifactId} (sha256 ${result.sha256}${result.inlineEvent ? '' : ', inline event skipped: patch over 1 MiB'})`,
      );
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

export async function main() {
  const rawArgs = process.argv.slice(2);

  // Separate Openrind Shell arguments from Claude passthrough arguments.
  const dashIdx = rawArgs.indexOf('--');
  const ownRawArgs = dashIdx >= 0 ? rawArgs.slice(0, dashIdx) : rawArgs;
  const passthroughPart = dashIdx >= 0 ? rawArgs.slice(dashIdx) : [];

  // Runtime flags can appear anywhere before the Claude `--` separator.
  const compatibilityMode = ownRawArgs.some(
    (arg) => arg === '--compat' || arg === '--compatibility',
  );
  const devMode = ownRawArgs.some(a => a === '--dev' || a === '-d' || a === '-dev');
  if (compatibilityMode && devMode) {
    throw new Error('--compat and --dev select different runtimes; use only one');
  }
  const ownArgs = ownRawArgs.filter((arg) => ![
    '--compat',
    '--compatibility',
    '--dev',
    '-d',
    '-dev',
  ].includes(arg));
  const args = [...ownArgs, ...passthroughPart];

  // presign show / renew
  if (ownArgs[0] === 'presign') {
    if (ownArgs[1] === 'renew') {
      await cmdPresignRenew();
    } else {
      await cmdPresignShow();
    }
    return;
  }

  if (ownArgs[0] === 'init') {
    try {
      await cmdInit(ownArgs.slice(1));
    } catch (err: any) {
      process.stderr.write(`\x1b[31mopenrind-shell: init failed: ${err?.message || err}\x1b[0m\n`);
      process.exit(1);
    }
    return;
  }

  if (ownArgs[0] === 'workspace-manifest') {
    try {
      await cmdWorkspaceManifest(ownArgs.slice(1));
    } catch (err: any) {
      process.stderr.write(`\x1b[31mopenrind-shell: workspace-manifest failed: ${err?.message || err}\x1b[0m\n`);
      process.exit(1);
    }
    return;
  }

  // stats / analyze / apply — forward to optimize CLI, passing stored presign URL via env
  if (ownArgs[0] === 'stats' || ownArgs[0] === 'analyze' || ownArgs[0] === 'apply') {
    const { fileURLToPath } = await import('node:url');
    const optimizeCliPath = fileURLToPath(new URL('./optimize/cli.js', import.meta.url));
    const env: NodeJS.ProcessEnv = { ...process.env };
    const stored = loadStoredPresign();
    if (stored) {
      env.OPENRIND_GATEWAY_PRESIGN_URL = stored.url;
      env.OPENERAL_PRESIGN_URL = stored.url;
    }
    const child = spawn('node', [optimizeCliPath, ...ownArgs], { stdio: 'inherit', env });
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }

  // optimize <subcommand> — backwards compatibility alias
  if (ownArgs[0] === 'optimize') {
    const { fileURLToPath } = await import('node:url');
    const optimizeCliPath = fileURLToPath(new URL('./optimize/cli.js', import.meta.url));
    const env: NodeJS.ProcessEnv = { ...process.env };
    const stored = loadStoredPresign();
    if (stored) {
      env.OPENRIND_GATEWAY_PRESIGN_URL = stored.url;
      env.OPENERAL_PRESIGN_URL = stored.url;
    }
    const child = spawn('node', [optimizeCliPath, ...ownArgs.slice(1)], { stdio: 'inherit', env });
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }

  const parsed = parseCliArgs(args);

  if (parsed.kind === 'help') {
    printHelp();
    return;
  }

  if (parsed.kind === 'memory-refresh') {
    const { refreshClaudeMemory } = await import('./memory/refresh.js');
    try {
      const result = await refreshClaudeMemory({
        homeDir: process.env.OPENRIND_SHELL_HOME
          || process.env.OPENERAL_HOME
          || process.env.HOME
          || '/sandbox',
        cwd: process.cwd(),
        projectRoot: parsed.projectRoot || undefined,
        query: parsed.query || undefined,
        dryRun: parsed.dryRun,
        backup: parsed.backup,
      });
      process.stderr.write(
        `\x1b[2mopenrind-shell: memory ${result.mode} mode (project: ${result.context.projectSlug})\x1b[0m\n`,
      );
      process.stderr.write(
        `\x1b[2mopenrind-shell: memory dir  ${result.context.memoryDir}\x1b[0m\n`,
      );
      if (result.backupDir) {
        process.stderr.write(`\x1b[2mopenrind-shell: backup      ${result.backupDir}\x1b[0m\n`);
      }
      for (const f of result.writtenFiles) {
        process.stderr.write(`\x1b[32m  wrote\x1b[0m ${f}\n`);
      }
      if (result.dryRun && result.plannedFiles.length > 0) {
        process.stderr.write('\x1b[2m(dry-run — no files written; planned:)\x1b[0m\n');
        for (const f of result.plannedFiles) {
          process.stderr.write(`  plan  ${f}\n`);
        }
      }
      return;
    } catch (err: any) {
      process.stderr.write(`\x1b[31mopenrind-shell: memory refresh failed: ${err?.message || err}\x1b[0m\n`);
      if (err?.stack) process.stderr.write(err.stack + '\n');
      process.exit(1);
    }
  }

  const { workspaceId, claudeArgs } = parsed;

  process.stderr.write(`\x1b[2mopenrind-shell: workspace  ${workspaceId}\x1b[0m\n`);
  process.stderr.write(
    `\x1b[2mopenrind-shell: mode       ${compatibilityMode ? 'compatibility' : 'primary FUSE'}${devMode ? ' (--dev alias)' : ''}\x1b[0m\n`,
  );
  await launchViaSandbox(
    workspaceId,
    claudeArgs,
    compatibilityMode ? 'compatibility' : 'fuse',
  );
}
