import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "../../../../..");

async function source(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

test("desktop image and runtime share the current PTY bridge contract", async () => {
  const [dockerfile, sandbox] = await Promise.all([
    source("Dockerfile.openrind-shell"),
    source("openrind-desktop/apps/desktop/electron/openshell/fuse-sandbox.mjs"),
  ]);
  assert.match(dockerfile, /fuse-haloop-required-v29-browser-client/);
  assert.match(dockerfile, /openrind-pty-bridge\.py/);
  assert.match(sandbox, /IMAGE_CONTRACT = "fuse-haloop-required-v29-browser-client"/);
});

test("developer image builder targets the dedicated WSL daemon and validates all runtime contracts", async () => {
  const [builder, desktopPackage] = await Promise.all([
    source("openrind-desktop/apps/desktop/scripts/build-openshell-runtime-images.mjs"),
    source("openrind-desktop/apps/desktop/package.json"),
  ]);
  assert.match(builder, /openrind-desktop-openshell/);
  assert.match(builder, /openrind-shell-fuse:local/);
  assert.match(builder, /haloop-gateway:local/);
  assert.match(builder, /haloop-collector:local/);
  assert.match(builder, /ghcr\.io\/openrind\/openrind-shell\/haloop-gateway/);
  assert.match(builder, /ghcr\.io\/openrind\/openrind-shell\/haloop-collector/);
  assert.match(builder, /w8-haloop-openrind-v6-durable-analysis/);
  assert.match(builder, /--production-haloop/);
  assert.match(builder, /"docker",\s*"image",\s*"push"/);
  assert.match(builder, /fuse-haloop-required-v29-browser-client/);
  assert.match(builder, /openrind-haloop-v2/);
  assert.match(builder, /openrind-haloop-collector-v1/);
  assert.match(builder, /openrind-desktop-collector/);
  assert.match(builder, /com\.openrind\.desktop\.haloop-version/);
  assert.match(builder, /"docker",\s*"build"/);
  assert.match(builder, /"docker",\s*"image",\s*"inspect"/);
  assert.match(
    desktopPackage,
    /"build:openshell-runtime-images": "node \.\/scripts\/build-openshell-runtime-images\.mjs"/,
  );
  assert.match(desktopPackage, /"verify:openshell-haloop-images:production"/);
  assert.match(desktopPackage, /"publish:openshell-haloop-images:production"/);
});

test("Windows Electron launchers keep nested processes on the workspace pnpm version", async () => {
  const [windowsLauncher, electronDev, electronBuild, prepareSidecar] = await Promise.all([
    source("openrind-desktop/scripts/dev-windows.cmd"),
    source("openrind-desktop/apps/desktop/scripts/electron-dev.mjs"),
    source("openrind-desktop/apps/desktop/scripts/electron-build.mjs"),
    source("openrind-desktop/apps/desktop/scripts/prepare-sidecar.mjs"),
  ]);
  assert.match(windowsLauncher, /corepack pnpm@10\.27\.0/);
  assert.match(electronDev, /OPENRIND_DESKTOP_USE_COREPACK_PNPM === "1"/);
  for (const launcher of [electronDev, electronBuild]) {
    assert.match(launcher, /"corepack\.cmd"/);
    assert.match(launcher, /\["pnpm@10\.27\.0"\]/);
  }
  assert.match(electronBuild, /a\.includes\(" "\)/);
  assert.match(electronDev, /\.\.\.pnpmArgs, "--filter", "@openrind\/app", "dev:windows"/);
  assert.match(electronDev, /\.\.\.pnpmArgs, "exec", "electron"/);
  assert.doesNotMatch(electronDev, /shell: process\.platform === "win32"/);
  assert.doesNotMatch(prepareSidecar, /shell: process\.platform === "win32"/);
});

test("Desktop Haloop profiles require synchronous capture through a private collector", async () => {
  const runtime = await source(
    "openrind-desktop/apps/desktop/electron/openshell/haloop-runtime.mjs",
  );

  assert.match(runtime, /"halo\.mark": \{ collectorURL: HALOOP_COLLECTOR_URL \}/);
  assert.match(runtime, /"halo\.export": \{/);
  assert.ok((runtime.match(/async: false/g) ?? []).length >= 2);
  assert.ok((runtime.match(/deny: false/g) ?? []).length >= 2);
  assert.match(runtime, /HALOOP_COLLECTOR_CONTAINER_NAME = "openrind-desktop-haloop-collector"/);
  assert.match(runtime, /HALOOP_NETWORK_NAME = "openrind-desktop-haloop"/);
  assert.match(runtime, /W8_KEEP_RAW=0/);
  assert.match(runtime, /requireCollectorFromGateway/);
  assert.match(runtime, /HALOOP_ROUTE_POLICY = "incumbent-only"/);
  assert.match(runtime, /provider: "anthropic"/);
  assert.match(runtime, /api_key: upstream\.apiKey/);
  assert.doesNotMatch(
    runtime,
    /strategy: \{ mode: "loadbalance" \}|targets: \[|weight:/,
  );
  assert.match(
    runtime,
    /override_params: \{ model: HALOOP_TEMPORARY_OPENROUTER_MODEL \}/,
  );
  assert.doesNotMatch(runtime, /8788:8788/);
});

test("trusted application spans stay host-owned and share the LLM trace root", async () => {
  const [runtime, main, sandboxSetup] = await Promise.all([
    source("openrind-desktop/apps/desktop/electron/openshell/haloop-runtime.mjs"),
    source("openrind-desktop/apps/desktop/electron/main.mjs"),
    source("sandboxes/openeral/setup-fuse.sh"),
  ]);

  assert.match(runtime, /event\.parentSpanId \|\| capture\.rootSpanId/);
  assert.match(runtime, /APP_SPAN_KINDS = new Set\(\["AGENT", "TOOL", "CHAIN"\]\)/);
  assert.match(runtime, /"exec",\s*"-i",\s*HALOOP_COLLECTOR_CONTAINER_NAME/);
  assert.match(runtime, /MAX_APP_CAPTURE_BYTES_PER_TRACE/);
  assert.match(main, /recordHaloopApplicationSpans\(haloopCapture/);
  assert.doesNotMatch(sandboxSetup, /\/spans/);
});

test("FUSE policy permits bridge PTY allocation without exposing dev fuse", async () => {
  const policy = await source("sandboxes/openeral/policy.yaml");
  assert.match(policy, /^\s*- \/dev\/pts\s*$/m);
  assert.match(policy, /^\s*- \/home\/agent\/\.openrind-shell\s*$/m);
  assert.doesNotMatch(policy, /^\s*- \/dev\/fuse\s*$/m);
});

test("desktop provisioning preserves one-shot FUSE create with only scoped Haloop", async () => {
  const sandbox = await source(
    "openrind-desktop/apps/desktop/electron/openshell/fuse-sandbox.mjs",
  );
  for (const fragment of [
    '"  --fuse"',
    "--driver-config-json",
    "/sandbox/db-url",
    '"--provider"',
    "haloop.providerName",
    '"  --no-tty"',
    '"  -- openrind-shell-init"',
  ]) {
    assert.ok(sandbox.includes(fragment), `missing create fragment: ${fragment}`);
  }
  assert.doesNotMatch(sandbox, /--auto-providers/);
  assert.doesNotMatch(sandbox, /ensureClaudeProvider|ensureGatewayProvider/);
  assert.match(
    sandbox,
    /buildFuseWslEnv\(\{[\s\S]*?ANTHROPIC_API_KEY: clientToken[\s\S]*?\}\)/,
  );
  assert.match(
    sandbox,
    /"--credential", "ANTHROPIC_API_KEY"/,
  );
  assert.match(
    sandbox,
    /buildFuseWslEnv\(\{[\s\S]*?HALOOP_CLIENT_TOKEN: clientToken[\s\S]*?\}\)/,
  );
});

test("new, resumed, and pop-out sessions require Haloop before connecting", async () => {
  const [main, terminal] = await Promise.all([
    source("openrind-desktop/apps/desktop/electron/main.mjs"),
    source(
      "openrind-desktop/apps/app/src/react-app/domains/session/surface/openrind-shell-terminal.tsx",
    ),
  ]);
  assert.equal(
    (main.match(/openrindShell\.ensureOpenrindShellHaloop\(/g) ?? []).length,
    3,
  );
  assert.ok(
    (main.match(/if \(!workspaceId\) throw new Error\("workspaceId is required"\)/g) ?? [])
      .length >= 3,
  );
  assert.match(
    main,
    /key === "anthropicApiKey"[\s\S]*?openrindShell\.stopHaloopRuntime\(\)/,
  );
  assert.match(
    terminal,
    /"openrindPtyAttachOrOpen", \{[\s\S]*?workspaceId: props\.workspaceId/,
  );
  assert.match(
    terminal,
    /"openrindPtyOpen", \{[\s\S]*?workspaceId: props\.workspaceId/,
  );
});

test("Desktop settings expose required Haloop controls in a dedicated global tab", async () => {
  const [credentialsPanel, environmentView, haloopView, settingsPage, locale, state, route, main] = await Promise.all([
    source(
      "openrind-desktop/apps/app/src/react-app/domains/settings/pages/openrind-shell-credentials-panel.tsx",
    ),
    source(
      "openrind-desktop/apps/app/src/react-app/domains/settings/pages/environment-view.tsx",
    ),
    source(
      "openrind-desktop/apps/app/src/react-app/domains/settings/pages/haloop-view.tsx",
    ),
    source(
      "openrind-desktop/apps/app/src/react-app/domains/settings/shell/settings-page.tsx",
    ),
    source("openrind-desktop/apps/app/src/i18n/locales/en.ts"),
    source(
      "openrind-desktop/apps/app/src/react-app/domains/settings/state/openshell-state.ts",
    ),
    source("openrind-desktop/apps/app/src/react-app/shell/settings-route.tsx"),
    source("openrind-desktop/apps/desktop/electron/main.mjs"),
  ]);

  for (const settingsSource of [credentialsPanel, environmentView]) {
    assert.match(settingsSource, /required Haloop edge/);
    assert.match(settingsSource, /neither this key nor a direct-provider route/);
    assert.match(settingsSource, /always use the required Haloop edge/);
    assert.doesNotMatch(
      settingsSource,
      /Leave unset to talk to Anthropic directly|directly or via the OpenShell provider/i,
    );
  }
  assert.match(locale, /The required Haloop edge needs an upstream Anthropic API key/);
  assert.doesNotMatch(environmentView, /Haloop inference route|Restart Haloop|Rotate token/);
  assert.match(settingsPage, /\["billing", "sandbox", "haloop", "appearance", "environment"\]/);
  assert.match(route, /case "haloop":/);
  assert.match(route, /<HaloopView/);
  assert.match(haloopView, /Haloop inference route/);
  assert.match(haloopView, /Active route:/);
  assert.match(haloopView, /Trace collector health:/);
  assert.match(state, /collectorHealth: string \| null/);
  assert.match(haloopView, /Trusted Desktop spans:/);
  assert.match(haloopView, /Trace capture is incomplete/);
  assert.match(state, /incomplete: number/);
  assert.match(haloopView, /Last connection error:/);
  assert.doesNotMatch(haloopView, /Observability & Traces|Open Web Dashboard|Run analysis|Generate eval cases|Download report|Download Harbor dataset/);
  assert.match(state, /openrindHaloopCaptureStatus/);
  assert.match(route, /onDownloadTraces/);
  assert.match(haloopView, /Restart Haloop/);
  assert.match(state, /invoke<HaloopRuntimeStatus>\("openrindHaloopRestart"\)/);
  assert.match(route, /onRestart=\{\(\) => openshellState\.restartHaloop\(\)\}/);
  assert.match(haloopView, /Restore incumbent/);
  assert.match(haloopView, /Route policy:/);
  assert.match(haloopView, /Incumbent only/);
  assert.match(
    state,
    /invoke<HaloopIncumbentRollbackResult>\(\s*"openrindHaloopRollbackIncumbent"/,
  );
  assert.match(
    route,
    /onRestoreIncumbent=\{\(\) => openshellState\.restoreHaloopIncumbent\(\)\}/,
  );
  assert.match(haloopView, /Rotate token/);
  assert.match(haloopView, /external agent terminal must also be closed and relaunched/);
  assert.match(state, /invoke<HaloopTokenRotationResult>\("openrindHaloopRotateToken"/);
  assert.match(route, /onRotateToken=\{\(\) => openshellState\.rotateHaloopToken\(\)\}/);
  assert.doesNotMatch(haloopView, /Disable Haloop|Use Haloop/);
  assert.match(state, /invoke<HaloopRuntimeStatus>\("openrindHaloopStatus"\)/);
  assert.match(route, /haloopActive: route\.tab === "haloop"/);
  assert.match(main, /case "openrindHaloopStatus":/);
  assert.match(main, /case "openrindHaloopAnalysisStatus":/);
  assert.match(main, /case "openrindHaloopAnalysisStart":/);
  assert.match(main, /case "openrindHaloopAnalysisReport":/);
  assert.match(main, /case "openrindHaloopAnalysisReportDownload":/);
  assert.match(main, /case "openrindHaloopEvalGenerate":/);
  assert.match(main, /case "openrindHaloopEvalCases":/);
  assert.match(main, /case "openrindHaloopEvalDownload":/);
  assert.match(main, /case "openrindHaloopHarborDownload":/);
  assert.match(main, /case "openrindHaloopRestart":/);
  assert.match(
    main,
    /openrindShell\.restartHaloopRuntime\(\{ anthropicApiKey: upstreamApiKey \}\)/,
  );
  assert.match(main, /case "openrindHaloopRollbackIncumbent":/);
  assert.match(main, /openrindShell\.restoreOpenrindShellHaloopIncumbent/);
  assert.match(main, /case "openrindHaloopRotateToken":/);
  assert.match(main, /"haloop-token-rotation"/);
  assert.match(main, /openrindHaloopCredentialMaintenanceSandboxes/);
  assert.match(main, /openrindShell\.rotateOpenrindShellHaloop/);
});

test("Desktop delegates analysis and Harbor generation to the web app", async () => {
  const [main, runtime, state] = await Promise.all([
    source("openrind-desktop/apps/desktop/electron/main.mjs"),
    source("openrind-desktop/apps/desktop/electron/openshell/haloop-runtime.mjs"),
    source("openrind-desktop/apps/app/src/react-app/domains/settings/state/openshell-state.ts"),
  ]);
  assert.match(runtime, /W8_DESKTOP_CAPTURE_ONLY=1/);
  assert.doesNotMatch(state, /invoke[^\n]*"openrindHaloopAnalysisStart"|invoke[^\n]*"openrindHaloopEvalGenerate"/);
  const disabled = main.slice(main.indexOf('case "openrindHaloopAnalysisStart"'), main.indexOf('case "openrindHaloopRestart"'));
  assert.match(disabled, /throw new Error/);
  assert.doesNotMatch(disabled, /openrindShell\./);
});

test("sandbox navigation retains Haloop artifacts and reuses live PTYs without restart work", async () => {
  const [main, runtime, state, sessionRoute, sandbox] = await Promise.all([
    source("openrind-desktop/apps/desktop/electron/main.mjs"),
    source("openrind-desktop/apps/desktop/electron/openshell/haloop-runtime.mjs"),
    source("openrind-desktop/apps/app/src/react-app/domains/settings/state/openshell-state.ts"),
    source("openrind-desktop/apps/app/src/react-app/shell/session-route.tsx"),
    source("openrind-desktop/apps/desktop/electron/openshell/fuse-sandbox.mjs"),
  ]);

  const attachStart = main.indexOf('case "openrindPtyAttachOrOpen":');
  const attachEnd = main.indexOf('case "openrindPtyAttach":', attachStart);
  const attachCase = main.slice(attachStart, attachEnd);
  assert.ok(attachStart >= 0 && attachEnd > attachStart);
  assert.ok(
    attachCase.indexOf("activateExistingHaloopRoute") <
      attachCase.indexOf("ensureOpenrindShellHaloop"),
  );
  assert.match(attachCase, /if \(existing && !existing\.exitInfo\)[\s\S]*?reused: true/);
  assert.match(attachCase, /resolveOpenrindShellSandboxWorkspaceId/);
  assert.match(attachCase, /workspaceId: routeWorkspaceId/);
  assert.match(sandbox, /com\.openrind\.desktop\.workspace/);
  assert.match(sandbox, /resolveOpenrindShellSandboxWorkspaceId/);
  assert.match(runtime, /discoverAnalysisProject/);
  assert.match(runtime, /collector's durable run index/);
  assert.match(state, /retainedHaloopAnalysisReport/);
  assert.match(state, /retainedHaloopEvalPreview/);
  assert.match(state, /mergeHaloopAnalysisSnapshot/);
  assert.match(state, /incoming\.stats\.spans < previous\.stats\.spans/);
  assert.doesNotMatch(state, /haloopHydrationRef/);
  assert.match(state, /Only positive replacement evidence invalidates rendered artifacts/);
  assert.doesNotMatch(
    state,
    /current\s*&&\s*\(!status\.run\s*\|\|\s*status\.run\.runId\s*!==\s*current\.runId\)/,
  );
  assert.match(sessionRoute, /retainedSandboxSelection/);
});

test("sandbox deletion revokes scoped Haloop access before destructive teardown", async () => {
  const [main, sandbox, runtime, credentials] = await Promise.all([
    source("openrind-desktop/apps/desktop/electron/main.mjs"),
    source("openrind-desktop/apps/desktop/electron/openshell/fuse-sandbox.mjs"),
    source("openrind-desktop/apps/desktop/electron/openshell/haloop-runtime.mjs"),
    source(
      "openrind-desktop/apps/desktop/electron/openshell/openrind-shell-credentials.mjs",
    ),
  ]);
  const deleteStart = main.indexOf('case "openrindDeleteSandbox":');
  const deleteEnd = main.indexOf('case "openrindDeriveSandboxName":', deleteStart);
  const deleteCase = main.slice(deleteStart, deleteEnd);

  assert.ok(deleteStart >= 0 && deleteEnd > deleteStart);
  assert.match(deleteCase, /openrindHaloopCredentialMaintenanceSandboxes\.add\(name\)/);
  assert.match(deleteCase, /"sandbox-delete"/);
  assert.ok(
    deleteCase.indexOf("revokeOpenrindShellHaloopForSandbox") <
      deleteCase.indexOf("deleteOpenrindShellSandbox"),
  );
  assert.match(deleteCase, /revokedHaloopProfiles: revocation\.revokedProfiles/);
  assert.match(
    sandbox,
    /\["sandbox", "provider", "detach", sandboxName, providerName\]/,
  );
  assert.match(sandbox, /\["provider", "delete", providerName\]/);
  const detachHelper = sandbox.indexOf("async function detachHaloopProvidersFromSandbox");
  const prepareHelper = sandbox.indexOf("async function prepareRequiredHaloop", detachHelper);
  const revocationHelpers = sandbox.slice(detachHelper, prepareHelper);
  assert.ok(
    revocationHelpers.indexOf('["sandbox", "provider", "detach", sandboxName, providerName]') <
      revocationHelpers.indexOf('["provider", "delete", providerName]'),
  );
  assert.match(sandbox, /revokeHaloopSandboxProfiles/);
  assert.match(runtime, /Withdraw the edge before deleting its encrypted source token/);
  assert.match(credentials, /revokeHaloopClientProfilesForSandbox/);
  assert.match(credentials, /before ciphertext changes/);
});

test("sandbox action errors use a popup instead of consuming sidebar space", async () => {
  const [panel, rows] = await Promise.all([
    source("openrind-desktop/apps/app/src/react-app/domains/session/sidebar/sandbox-panel.tsx"),
    source("openrind-desktop/apps/app/src/react-app/domains/session/sidebar/use-sandbox-rows.ts"),
  ]);
  assert.match(panel, /<ErrorDialog message=\{error\}/);
  assert.match(panel, /role="alertdialog"/);
  assert.doesNotMatch(panel, /<span className="min-w-0 flex-1 break-words">\{error\}<\/span>/);
  assert.match(rows, /Error invoking remote method '\[\^'\]\+'/);
});

test("distro reset revokes the complete Haloop integration before unregistering WSL", async () => {
  const [main, sandbox, runtime, credentials] = await Promise.all([
    source("openrind-desktop/apps/desktop/electron/main.mjs"),
    source("openrind-desktop/apps/desktop/electron/openshell/fuse-sandbox.mjs"),
    source("openrind-desktop/apps/desktop/electron/openshell/haloop-runtime.mjs"),
    source(
      "openrind-desktop/apps/desktop/electron/openshell/openrind-shell-credentials.mjs",
    ),
  ]);
  const resetStart = main.indexOf('case "openshellResetDistro":');
  const resetEnd = main.indexOf("default:", resetStart);
  const resetCase = main.slice(resetStart, resetEnd);

  assert.ok(resetStart >= 0 && resetEnd > resetStart);
  assert.match(resetCase, /openrindHaloopIntegrationMaintenance = true/);
  assert.match(
    resetCase,
    /Promise\.allSettled\(Array\.from\(openrindHaloopOperations\)\)/,
  );
  assert.match(resetCase, /Promise\.allSettled\(Array\.from\(openrindFreshOpenChains\.values\(\)\)\)/);
  assert.match(resetCase, /closeAllSessions\("openshell-reset"\)/);
  assert.ok(
    resetCase.indexOf("revokeOpenrindShellHaloopIntegration") <
      resetCase.indexOf('"--unregister"'),
  );
  assert.match(resetCase, /terminated\.exitCode !== 0/);
  assert.match(resetCase, /unregistered\.exitCode !== 0/);
  assert.match(resetCase, /cleanupMode = "stopped-distro-quarantine"/);
  assert.ok(
    resetCase.indexOf("await terminateDistro();") <
      resetCase.indexOf("revokeAllHaloopClientProfiles"),
  );
  assert.ok(
    resetCase.indexOf("revokeAllHaloopClientProfiles") <
      resetCase.indexOf('"--unregister"'),
  );
  assert.match(resetCase, /openrindHaloopIntegrationMaintenance = false/);
  assert.match(sandbox, /revokeHaloopIntegration/);
  assert.match(runtime, /revokeAllHaloopClientProfiles/);
  assert.match(runtime, /removeManagedNetwork/);
  assert.match(credentials, /export function revokeAllHaloopClientProfiles/);
  assert.match(main, /function trackHaloopOperation/);
  assert.match(main, /function assertHaloopIntegrationNotResetting/);
});

test("Claude state uses a persistent per-workspace Docker volume", async () => {
  const [sandbox, setup, wrapper] = await Promise.all([
    source("openrind-desktop/apps/desktop/electron/openshell/fuse-sandbox.mjs"),
    source("sandboxes/openeral/setup-fuse.sh"),
    source("sandboxes/openeral/openeral-claude-fuse.sh"),
  ]);
  assert.match(sandbox, /openrind-claude-home-/);
  assert.match(sandbox, /target: agent\.homeMount/);
  assert.match(setup, /OPENRIND_SHELL_CLAUDE_HOME=\/sandbox\/claude-home/);
  assert.match(setup, /\.local\/bin\/claude/);
  assert.match(wrapper, /OPENRIND_SHELL_CLAUDE_HOME:-\/sandbox\/claude-home/);
});

test("OpenClaw uses the same FUSE workspace with a separate persistent agent home", async () => {
  const [
    dockerfile,
    sandbox,
    setup,
    launcher,
    nativeLauncher,
    config,
    runtimePackage,
    bridge,
    modal,
    provider,
  ] = await Promise.all([
    source("Dockerfile.openrind-shell"),
    source("openrind-desktop/apps/desktop/electron/openshell/fuse-sandbox.mjs"),
    source("sandboxes/openeral/setup-fuse.sh"),
    source("sandboxes/openeral/openrind-openclaw-fuse.sh"),
    source("sandboxes/openeral/openclaw-agent-launcher.c"),
    source("sandboxes/openeral/configure-openclaw-fuse.mjs"),
    source("openeral-js/package.json"),
    source("sandboxes/openeral/openrind-pty-bridge.py"),
    source(
      "openrind-desktop/apps/app/src/react-app/domains/session/modals/create-sandbox-modal.tsx",
    ),
    source("vendor/openshell/providers/haloop-anthropic.yaml"),
  ]);
  assert.match(dockerfile, /openclaw@\$\{OPENCLAW_VERSION\}/);
  assert.match(dockerfile, /2\.1\.227/);
  assert.match(dockerfile, /\/sandbox\/openclaw-home/);
  assert.match(sandbox, /openrind-openclaw-home-/);
  assert.match(sandbox, /OPENRIND_SHELL_AGENT=\$\{agent\.id\}/);
  assert.match(sandbox, /getCredential\("anthropicApiKey"\)/);
  assert.match(sandbox, /resolveHaloopUpstreamApiKey\(anthropicApiKey\)/);
  assert.match(sandbox, /ensureHaloopRuntime/);
  assert.doesNotMatch(sandbox, /TEMPORARY_USE_OPENROUTER/);
  assert.match(setup, /OPENRIND_SHELL_OPENCLAW_HOME=\/sandbox\/openclaw-home/);
  assert.match(setup, /\/usr\/local\/bin\/openrind-openclaw/);
  assert.match(launcher, /openrind-openclaw-agent "\$\{session_args\[@\]\}"/);
  assert.doesNotMatch(launcher, /^\s*set\s+[-+][A-Za-z]*e[A-Za-z]*\b/m);
  assert.match(launcher, /if ! install -d -m 0700/);
  assert.match(launcher, /if ! cd "\$OPENRIND_SHELL_HOME"/);
  assert.doesNotMatch(launcher, /configure-openclaw-fuse\.mjs/);
  assert.doesNotMatch(launcher, /for target_skills_dir/);
  assert.match(setup, /\/usr\/lib\/node_modules\/openclaw\/openclaw\.mjs tui --help/);
  assert.match(setup, /NODE_COMPILE_CACHE="\$OPENRIND_OPENCLAW_COMPILE_CACHE"/);
  assert.match(setup, /configure-openclaw-fuse\.mjs/);
  assert.match(launcher, /if ! exec 3<&0/);
  assert.match(launcher, /if \[ ! -x \/usr\/local\/bin\/openrind-openclaw-agent \]/);
  assert.match(launcher, /if wait "\$child"/);
  assert.match(launcher, /if ! openrind-shell-fused flush-all/);
  assert.match(nativeLauncher, /\(char \*\)"tui"/);
  assert.match(nativeLauncher, /\(char \*\)"--local"/);
  assert.match(nativeLauncher, /static const char prefix\[\] = "--session="/);
  assert.match(nativeLauncher, /if \(argc > 2\)/);
  assert.match(dockerfile, /openrind-openclaw-agent openclaw-agent-launcher\.c/);
  assert.match(dockerfile, /test -x \/usr\/bin\/openclaw/);
  assert.match(nativeLauncher, /NODE_BIN\[\] = "\/usr\/bin\/node"/);
  assert.match(
    nativeLauncher,
    /OPENCLAW_ENTRYPOINT\[\] = "\/usr\/lib\/node_modules\/openclaw\/openclaw\.mjs"/,
  );
  assert.match(nativeLauncher, /unsetenv\("NODE_OPTIONS"\)/);
  assert.match(nativeLauncher, /execv\(NODE_BIN, openclaw_argv\)/);
  assert.match(provider, /\/usr\/local\/bin\/openrind-openclaw-agent/);
  assert.doesNotMatch(provider, /\/usr\/bin\/node/);
  assert.match(config, /const WORKSPACE = "\/sandbox\/work"/);
  assert.match(setup, /OPENRIND_SHELL_PTY_KEEP_SCROLLBACK=0/);
  assert.doesNotMatch(setup, /OPENRIND_SHELL_PTY_PIN_OPENCLAW_BANNER/);
  assert.match(setup, /OPENRIND_SHELL_PTY_SHOW_OPENCLAW_BANNER=1/);
  assert.match(bridge, /OPENCLAW_BANNER_MARKER = b"OpenClaw "/);
  assert.match(bridge, /def _observe_openclaw_banner/);
  assert.doesNotMatch(bridge, /_capture_openclaw_banner|_banner_capture/);
  assert.match(
    bridge,
    /if \(self\.enabled or self\._openclaw_banner\) and window\.startswith\(/,
  );
  assert.match(
    bridge,
    /if self\.scrolls < self\._max_rewrites:[\s\S]*?if self\._openclaw_banner:[\s\S]*?self\.scrolls \+= 1/,
  );
  assert.match(
    bridge,
    /self\.passthroughs \+= 1\s+out \+= CLEAR_AND_HOME/,
  );
  assert.doesNotMatch(
    bridge,
    /if self\._openclaw_banner and window\.startswith\(CLEAR_AND_HOME\)/,
  );
  assert.match(setup, /shared clear-rewrite budget/);
  assert.match(config, /config\.agents\.defaults\.models\[primaryModel\]/);
  assert.match(config, /const PROVIDER_ID = "openrind-gateway"/);
  assert.match(config, /http:\/\/136\.112\.93\.84:8787/);
  assert.match(config, /const DEFAULT_MODEL_ID = "claude-sonnet-4-6"/);
  assert.doesNotMatch(config, /OPENRIND_SHELL_USE_OPENROUTER_TEST|openrouter\/openrouter\/free/);
  assert.match(config, /delete config\.env\.OPENROUTER_API_KEY/);
  assert.match(config, /delete config\.models\.providers\.openrouter/);
  assert.match(config, /delete config\.models\.providers\["openrind-haloop"\]/);
  assert.match(config, /api: "anthropic-messages"/);
  assert.match(config, /models: \[\{ id: modelId/);
  assert.match(
    config,
    /"x-openrind-haloop-session": "\$\{OPENRIND_HALOOP_SESSION_CONTEXT\}"/,
  );
  assert.match(config, /import JSON5 from "json5"/);
  assert.match(config, /JSON5\.parse\(source\)/);
  assert.doesNotMatch(config, /JSON\.parse\(normalized\)|\.replace\(/);
  assert.equal(JSON.parse(runtimePackage).dependencies.json5, "2.2.3");
  assert.doesNotMatch(launcher, /OPENROUTER_API_KEY|OPENRIND_SHELL_USE_OPENROUTER_TEST/);
  assert.doesNotMatch(config, /sk-or-v1-/);
  assert.doesNotMatch(launcher, /sk-or-v1-/);
  assert.doesNotMatch(sandbox, /sk-or-v1-/);
  assert.match(modal, /option value="openrind-shell-openclaw"/);
});

test("agent launches require a host-signed conversation context", async () => {
  const [runtime, main, facade, launcher, openclawConfig, openclawLauncher, proxy] =
    await Promise.all([
      source("openrind-desktop/apps/desktop/electron/openshell/haloop-runtime.mjs"),
      source("openrind-desktop/apps/desktop/electron/main.mjs"),
      source("openrind-desktop/apps/desktop/electron/openshell/openrind-shell.mjs"),
      source("sandboxes/openeral/openrind-desktop-claude-launch.sh"),
      source("sandboxes/openeral/configure-openclaw-fuse.mjs"),
      source("sandboxes/openeral/openrind-openclaw-fuse.sh"),
      source("vendor/openshell/crates/openshell-supervisor-network/src/proxy.rs"),
    ]);

  assert.match(runtime, /issueHaloopConversationContext/);
  assert.match(runtime, /session_hmac_key: deriveHaloopSessionHmacKey\(profile\)/);
  assert.match(runtime, /openrind-haloop-trace-v2/);
  assert.match(main, /issueConversation: true/);
  assert.match(main, /haloopSessionAssertion: haloop\.sessionAssertion/);
  assert.match(main, /extraEnv\.OPENRIND_SHELL_AGENT = agent/);
  assert.match(main, /buildHaloopAgentLifecycleEvent\(agent, event\)/);
  assert.doesNotMatch(
    runtime,
    /buildHaloopAgentLifecycleEvent\(profile[\s\S]*?profile === "openrind-shell-/,
  );
  assert.match(facade, /A signed Haloop conversation context is required/);
  assert.match(launcher, /OPENRIND_HALOOP_SESSION_CONTEXT/);
  assert.match(launcher, /ANTHROPIC_CUSTOM_HEADERS=/);
  assert.match(openclawConfig, /OPENRIND_HALOOP_SESSION_CONTEXT/);
  assert.match(openclawLauncher, /a signed Desktop Haloop conversation context is required/);
  assert.match(
    proxy,
    /test_rewrite_haloop_request_resolves_token_and_preserves_signed_session_header/,
  );
});

test("desktop uploads and file listings use the agent-visible FUSE inbox", async () => {
  const [sandbox, facade, management, main, terminal] = await Promise.all([
    source("openrind-desktop/apps/desktop/electron/openshell/fuse-sandbox.mjs"),
    source("openrind-desktop/apps/desktop/electron/openshell/openrind-shell.mjs"),
    source("openrind-desktop/apps/desktop/electron/openshell/fuse-management.mjs"),
    source("openrind-desktop/apps/desktop/electron/main.mjs"),
    source(
      "openrind-desktop/apps/app/src/react-app/domains/session/surface/openrind-shell-terminal.tsx",
    ),
  ]);
  assert.match(sandbox, /destinationDirectory = "\/sandbox\/work\/inbox"/);
  assert.match(facade, /uploadWorkspaceFile/);
  assert.match(facade, /listWorkspaceFiles/);
  assert.match(facade, /deleteWorkspaceFile/);
  assert.match(sandbox, /export async function listWorkspaceFiles/);
  assert.match(sandbox, /const directory = "\/sandbox\/work\/inbox"/);
  assert.match(management, /\["sandbox", "list", "-o", "json"\]/);
  assert.doesNotMatch(management, /"--names"/);
  assert.match(main, /openrindShell\.uploadWorkspaceFile/);
  assert.match(main, /case "openrindShellListFiles"/);
  assert.match(main, /openrindShell\.listWorkspaceFiles/);
  assert.match(main, /openrindShell\.deleteWorkspaceFile/);
  assert.doesNotMatch(main, /\/home\/agent\/inbox/);
  assert.match(terminal, /"openrindShellListFiles"/);
  assert.doesNotMatch(terminal, /setUploadedFiles/);
});

test("desktop downloads sandbox artifacts to a user-selected host path with OpenShell", async () => {
  const [sandbox, main, terminal] = await Promise.all([
    source("openrind-desktop/apps/desktop/electron/openshell/fuse-sandbox.mjs"),
    source("openrind-desktop/apps/desktop/electron/main.mjs"),
    source(
      "openrind-desktop/apps/app/src/react-app/domains/session/surface/openrind-shell-terminal.tsx",
    ),
  ]);
  assert.match(sandbox, /export async function downloadWorkspaceFile/);
  assert.match(
    sandbox,
    /const source = `\/sandbox\/work\/inbox\/\$\{safeFilename\}`/,
  );
  assert.match(
    sandbox,
    /\["sandbox", "download", name, source, destination\]/,
  );
  assert.match(main, /case "openrindShellDownloadFile"/);
  assert.match(main, /dialog\.showSaveDialog/);
  assert.match(main, /app\.getPath\("downloads"\)/);
  assert.match(main, /filters: downloadDialogFilters\(filename\)/);
  assert.match(
    main,
    /preserveDownloadExtension\(result\.filePath, filename\)/,
  );
  assert.match(main, /toWslPath\(destinationPath\)/);
  assert.match(terminal, /"openrindShellDownloadFile"/);
  assert.match(terminal, /title="Download to computer"/);
});

test("Claude launch uses the marker, Linux PTY bridge, and native provider binary", async () => {
  const [setup, provider] = await Promise.all([
    source("sandboxes/openeral/setup-fuse.sh"),
    source("vendor/openshell/providers/haloop-anthropic.yaml"),
  ]);
  assert.match(setup, /desktop-session/);
  assert.match(setup, /openrind-pty-bridge\.py/);
  assert.match(setup, /\/usr\/local\/bin\/claude/);
  assert.match(provider, /\/usr\/local\/bin\/claude-real/);
});

test("composed FUSE policy removes direct inference and restricts Haloop executables", async () => {
  const policy = await source("sandboxes/openeral/policy.yaml");
  assert.match(policy, /host: host\.openshell\.internal[\s\S]*?port: 8787/);
  assert.match(policy, /method: POST, path: "\/v1\/messages"/);
  const haloopBlock = policy.slice(
    policy.indexOf("haloop_anthropic:"),
    policy.indexOf("claude_support:"),
  );
  assert.match(haloopBlock, /\/usr\/local\/bin\/claude-real/);
  assert.match(haloopBlock, /\/usr\/local\/bin\/openrind-openclaw-agent/);
  assert.doesNotMatch(haloopBlock, /\/usr\/bin\/node/);
  assert.doesNotMatch(
    policy,
    /api\.anthropic\.com|proxy\.openrind\.com|proxy\.stringcost\.com/,
  );
});

test("Haloop provider binds its scoped token to the inference edge only", async () => {
  const provider = await source(
    "vendor/openshell/providers/haloop-anthropic.yaml",
  );
  assert.match(provider, /^id: haloop-anthropic$/m);
  assert.match(provider, /env_vars: \[HALOOP_CLIENT_TOKEN, ANTHROPIC_API_KEY\]/);
  assert.match(provider, /header_name: x-api-key/);
  assert.match(provider, /host: host\.openshell\.internal/);
  assert.match(provider, /port: 8787/);
  assert.match(provider, /method: POST, path: "\/v1\/messages"/);
  assert.match(provider, /method: POST, path: "\/v1\/messages\/count_tokens"/);
  assert.match(provider, /\/usr\/local\/bin\/claude-real/);
  assert.match(provider, /\/usr\/local\/bin\/openrind-openclaw-agent/);
  assert.doesNotMatch(provider, /\/usr\/bin\/node/);
  assert.doesNotMatch(provider, /api\.anthropic\.com/);
});

test("FUSE images package the fixed Haloop configurator", async () => {
  const [rootDockerfile, sandboxDockerfile, configurator] = await Promise.all([
    source("Dockerfile.openrind-shell"),
    source("sandboxes/openeral/Dockerfile"),
    source("sandboxes/openeral/configure-haloop.mjs"),
  ]);
  for (const dockerfile of [rootDockerfile, sandboxDockerfile]) {
    assert.match(dockerfile, /configure-haloop\.mjs/);
    assert.match(
      dockerfile,
      /node --check \/opt\/openrind-shell\/configure-haloop\.mjs/,
    );
  }
  assert.match(
    configurator,
    /http:\/\/136\.112\.93\.84:8787/,
  );
  assert.doesNotMatch(configurator, /api\.anthropic\.com/);
  assert.doesNotMatch(configurator, /process\.env\.OPENRIND_HALOOP/);
  assert.match(configurator, /\/home\/agent\/\.openrind-shell\/env\.sh/);
  assert.match(configurator, /export \$\{name\}=/);
  assert.match(configurator, /retained\.push/);
  assert.match(rootDockerfile, /\/home\/agent\/\.openrind-shell/);
  assert.match(sandboxDockerfile, /\/home\/agent\/\.openrind-shell/);
});

test("desktop connections replace the login shell and keep first paint free of setup work", async () => {
  const [facade, main, setup, desktopLauncher, claudeLauncher, openclawLauncher] = await Promise.all([
    source("openrind-desktop/apps/desktop/electron/openshell/openrind-shell.mjs"),
    source("openrind-desktop/apps/desktop/electron/main.mjs"),
    source("sandboxes/openeral/setup-fuse.sh"),
    source("sandboxes/openeral/openrind-desktop-claude-launch.sh"),
    source("sandboxes/openeral/openeral-claude-fuse.sh"),
    source("sandboxes/openeral/openrind-openclaw-fuse.sh"),
  ]);

  assert.match(facade, /exec \/usr\/local\/bin\/openrind-desktop-claude-launch/);
  assert.match(desktopLauncher, /set -- \/usr\/local\/bin\/claude/);
  assert.match(desktopLauncher, /set -- \/usr\/local\/bin\/openrind-openclaw/);
  assert.match(
    desktopLauncher,
    /exec \/usr\/local\/bin\/openrind-pty-bridge\.py --framed "\$@"/,
  );
  assert.doesNotMatch(desktopLauncher, /AGENT_BIN|command -v openclaw|\/usr\/bin\/opencode/);
  assert.doesNotMatch(desktopLauncher, /exec \/bin\/bash/);
  assert.doesNotMatch(main, /OPENROUTER_API_KEY|openrouterApiKey/);
  assert.match(desktopLauncher, /node \/opt\/openrind-shell\/configure-haloop\.mjs/);
  assert.doesNotMatch(desktopLauncher, /configure-openrind-gateway/);
  assert.match(setup, /"\$OPENRIND_SHELL_HOME\/\.claude\/skills"/);
  assert.match(setup, /claude-real --version/);
  assert.match(
    setup,
    /\[ -f \/home\/agent\/\.openrind-shell\/env\.sh \] && \. \/home\/agent\/\.openrind-shell\/env\.sh/,
  );

  assert.match(claudeLauncher, /OPENRIND_SHELL_HOME=\/sandbox\/work/);
  assert.match(claudeLauncher, /if \[ "\$STATE" != writable \]/);
  assert.match(
    claudeLauncher,
    /OPENRIND_DESKTOP_CLAUDE_LAUNCH:-0}" != "1"[\s\S]*?openrind-shell init --ensure/,
  );
  assert.doesNotMatch(claudeLauncher, /for target_skills_dir/);
  assert.match(claudeLauncher, /\/usr\/local\/bin\/claude-real/);

  assert.match(openclawLauncher, /OPENRIND_SHELL_HOME=\/sandbox\/work/);
  assert.match(openclawLauncher, /if ! cd "\$OPENRIND_SHELL_HOME"/);
  assert.match(openclawLauncher, /if \[ "\$STATE" != writable \]/);
  assert.match(openclawLauncher, /\/usr\/local\/bin\/openrind-openclaw-agent/);
  assert.doesNotMatch(openclawLauncher, /configure-openclaw-fuse\.mjs/);
  assert.doesNotMatch(openclawLauncher, /for target_skills_dir/);
});

test("framed PTY output unconditionally filters scrollback erasure", async () => {
  const bridge = await source("sandboxes/openeral/openrind-pty-bridge.py");
  assert.match(
    bridge,
    /\(self\.enabled or self\._openclaw_banner\) and window\.startswith\(/,
  );
  assert.match(bridge, /if ERASE_SCROLLBACK\.startswith\(self\._held\):\s+return b""/);
  assert.match(
    bridge,
    /write_all\(1, _keeper\.feed\(TERMINAL_RESET\) \+ _keeper\.flush\(\)\)/,
  );
  assert.doesNotMatch(bridge, /if not self\.enabled:\s+return chunk/);
  assert.doesNotMatch(bridge, /write_all\(1, TERMINAL_RESET\)/);
  assert.doesNotMatch(bridge, /write_all\(1, TERMINAL_RESTORE\)/);
});
