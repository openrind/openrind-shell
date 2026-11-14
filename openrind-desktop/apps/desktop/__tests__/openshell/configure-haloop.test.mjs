import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "../../../../..");
const configurator = path.join(
  repositoryRoot,
  "sandboxes",
  "openeral",
  "configure-haloop.mjs",
);

test("Haloop configurator pins the edge and pre-provisions the persistent Claude home", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openrind-haloop-test-"));
  const home = path.join(root, "workspace");
  const claudeHome = path.join(root, "claude-home");
  const runtime = path.join(root, "runtime");
  const shellEnvPath = path.join(root, "home", "agent", ".openrind-shell", "env.sh");
  const settingsPath = path.join(home, ".claude", "settings.json");
  const claudeSettingsPath = path.join(claudeHome, ".claude", "settings.json");
  const claudeConfigPath = path.join(claudeHome, ".claude.json");
  const currentPresign = path.join(home, ".openrind-shell", "presign.json");
  const legacyPresign = path.join(home, ".openeral", "presign.json");

  try {
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await mkdir(path.dirname(claudeSettingsPath), { recursive: true });
    await mkdir(path.dirname(currentPresign), { recursive: true });
    await mkdir(path.dirname(legacyPresign), { recursive: true });
    await mkdir(path.dirname(shellEnvPath), { recursive: true });
    await writeFile(
      shellEnvPath,
      "export KEEP_SHELL_VALUE='safe'\nexport ANTHROPIC_BASE_URL='https://legacy.invalid'\n",
    );
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_API_KEY: "upstream-secret",
          ANTHROPIC_AUTH_TOKEN: "direct-token",
          ANTHROPIC_CUSTOM_HEADERS: "x-openrind-haloop-session: attacker",
          OPENRIND_GATEWAY_PROXY_URL: "https://legacy.invalid",
          KEEP_ME: "safe",
        },
      }),
    );
    await writeFile(currentPresign, "legacy");
    await writeFile(legacyPresign, "legacy");
    await writeFile(
      claudeSettingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: "direct-token",
          KEEP_HOME: "safe",
        },
      }),
    );
    await writeFile(
      claudeConfigPath,
      JSON.stringify({ firstStartVersion: "2.1.263", keepConfig: true }),
    );

    const result = await run(process.execPath, [configurator], {
      env: {
        ...process.env,
        HALOOP_GATEWAY_URL: "http://127.0.0.1:8787",
        OPENRIND_SHELL_HOME: home,
        OPENRIND_SHELL_CLAUDE_HOME: claudeHome,
        OPENRIND_SHELL_AGENT: "claude",
        OPENRIND_SHELL_RUNTIME_DIR: runtime,
        OPENRIND_SHELL_ENV_FILE: shellEnvPath,
      },
    });
    assert.match(result.stdout, /Required Haloop routing configured/);

    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(
      settings.env.ANTHROPIC_BASE_URL,
      "http://127.0.0.1:8787",
    );
    assert.equal(settings.env.KEEP_ME, "safe");
    assert.equal(settings.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(settings.env.ANTHROPIC_CUSTOM_HEADERS, undefined);
    assert.equal(settings.env.OPENRIND_GATEWAY_PROXY_URL, undefined);
    const claudeSettings = JSON.parse(
      await readFile(claudeSettingsPath, "utf8"),
    );
    assert.equal(
      claudeSettings.env.ANTHROPIC_BASE_URL,
      "http://127.0.0.1:8787",
    );
    assert.equal(claudeSettings.env.KEEP_HOME, "safe");
    assert.equal(claudeSettings.env.ANTHROPIC_AUTH_TOKEN, undefined);
    const claudeConfig = JSON.parse(await readFile(claudeConfigPath, "utf8"));
    assert.equal(claudeConfig.hasCompletedOnboarding, true);
    assert.equal(claudeConfig.firstStartVersion, "2.1.263");
    assert.equal(claudeConfig.keepConfig, true);
    assert.equal(
      await readFile(path.join(runtime, "anthropic-base-url"), "utf8"),
      "http://127.0.0.1:8787\n",
    );
    assert.equal(
      await readFile(shellEnvPath, "utf8"),
      "export KEEP_SHELL_VALUE='safe'\nexport ANTHROPIC_BASE_URL='http://127.0.0.1:8787'\n",
    );
    await assert.rejects(readFile(currentPresign, "utf8"), /ENOENT/);
    await assert.rejects(readFile(legacyPresign, "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
