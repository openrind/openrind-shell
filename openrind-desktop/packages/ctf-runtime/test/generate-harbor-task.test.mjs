import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildHarborTaskFilesFromCtf,
  createTarGzBuffer,
  createZipBuffer,
  generateHarborTaskFromTrajectory,
  obfuscateClientSideFlags,
} from "../bin/generate-harbor-task.mjs";

const SYNTHETIC_FLAG = "flag{synthetic_harbor_test}";

// Synthetic fixture: a tiny throwaway challenge directory that follows the
// standard conventions (chall/ server, static client asset, flag.txt).
async function createSyntheticTaskDir() {
  const dir = await mkdtemp(join(tmpdir(), "harbor-synthetic-task-"));
  await mkdir(join(dir, "chall"), { recursive: true });
  await mkdir(join(dir, "static"), { recursive: true });
  await writeFile(
    join(dir, "chall", "server.py"),
    'from flask import Flask\napp = Flask(__name__)\n\n@app.route("/")\ndef index():\n    return "ok"\n'
  );
  await writeFile(
    join(dir, "static", "app.js"),
    `const secret = "${SYNTHETIC_FLAG}";\nconsole.log(secret);\n`
  );
  await writeFile(join(dir, "flag.txt"), `${SYNTHETIC_FLAG}\n`);
  await writeFile(
    join(dir, "challenge.json"),
    JSON.stringify({ name: "Synthetic Web", description: "Fixture challenge.", internal_port: 8080 })
  );
  return dir;
}

function syntheticTrajectory(folderPath) {
  return {
    task: {
      id: "synthetic-web",
      title: "Synthetic Web",
      description: "A synthetic fixture challenge for Harbor generation tests.",
      sitePath: "/",
      folderPath,
    },
    judge: {
      accepted: true,
      submission: SYNTHETIC_FLAG,
    },
    steps: [],
  };
}

test("obfuscateClientSideFlags obfuscates plaintext flag tokens in client assets", () => {
  const files = [
    {
      path: "environment/workspace/site/app.js",
      content: 'const secret = "flag{super_secret_123}";',
    },
    {
      path: "environment/workspace/chall/server.py",
      content: 'FLAG = "flag{super_secret_123}"',
    },
  ];

  obfuscateClientSideFlags(files, "flag{super_secret_123}");

  // Client-side JS is obfuscated with atob
  assert.match(files[0].content, /atob\(/);
  assert.ok(!files[0].content.includes("flag{super_secret_123}"));

  // Backend Python code is untouched
  assert.equal(files[1].content, 'FLAG = "flag{super_secret_123}"');
});

test("buildHarborTaskFilesFromCtf generates leak-free, anti-cheat Harbor 1.5 task files", async () => {
  const taskDir = await createSyntheticTaskDir();
  try {
    const files = await buildHarborTaskFilesFromCtf(syntheticTrajectory(taskDir));
    const filePaths = files.map((f) => f.path);

    // 1. Invariant: NO HARBOR-RESULTS.md or logs/ in task package
    assert.ok(!filePaths.includes("HARBOR-RESULTS.md"), "Task package must not include HARBOR-RESULTS.md");
    assert.ok(!filePaths.some((p) => p.startsWith("logs/")), "Task package must not include logs/");

    // 2. Invariant: instruction.md must NOT leak the flag
    const instructionFile = files.find((f) => f.path === "instruction.md");
    assert.ok(instructionFile, "instruction.md must exist");
    assert.ok(
      !instructionFile.content.includes(SYNTHETIC_FLAG),
      "instruction.md must not contain the flag string"
    );
    assert.match(instructionFile.content, /flag\{\.\.\.\}/, "instruction.md should specify flag format");

    // 3. Invariant: verify.py must include anti-cheat log checks
    const verifyFile = files.find((f) => f.path === "tests/verify.py");
    assert.ok(verifyFile, "tests/verify.py must exist");
    assert.match(verifyFile.content, /web-service\.log/, "verify.py must include anti-cheat log verification");
    assert.match(verifyFile.content, /ANTI-CHEAT/, "verify.py must label anti-cheat failure");

    // 4. Invariant: task.toml must adhere to schema 1.5
    const taskTomlFile = files.find((f) => f.path === "task.toml");
    assert.ok(taskTomlFile, "task.toml must exist");
    assert.match(taskTomlFile.content, /schema_version = "1\.5"/);
    assert.match(taskTomlFile.content, /network_mode = "no-network"/);

    // 5. Workspace files come from the task folderPath, without flag.txt
    assert.ok(filePaths.includes("environment/workspace/chall/server.py"), "workspace must include the chall server");
    assert.ok(!filePaths.some((p) => p.endsWith("flag.txt")), "workspace must not include flag.txt");

    // 6. Client-side flag material in the workspace is obfuscated
    const appJs = files.find((f) => f.path === "environment/workspace/static/app.js");
    assert.ok(appJs, "workspace must include the client asset");
    const appJsText = Buffer.isBuffer(appJs.content) ? appJs.content.toString("utf8") : String(appJs.content);
    assert.match(appJsText, /atob\(/);
    assert.ok(!appJsText.includes(SYNTHETIC_FLAG));

    // 7. The environment installs the server flag for both challenge conventions
    const dockerfile = files.find((f) => f.path === "environment/Dockerfile");
    assert.ok(dockerfile, "environment/Dockerfile must exist");
    assert.match(dockerfile.content, /\/flag\.txt/, "Dockerfile must install /flag.txt");
    assert.match(dockerfile.content, /\/opt\/openrind-ctf\/task\/flag\.txt/, "Dockerfile must install the runtime task flag");
  } finally {
    await rm(taskDir, { recursive: true, force: true });
  }
});

test("generateHarborTaskFromTrajectory creates valid zip and tar.gz packages", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "harbor-gen-test-"));
  const taskDir = await createSyntheticTaskDir();
  const zipPath = join(tempDir, "task.zip");
  const tarPath = join(tempDir, "task.tar.gz");

  try {
    const mockTrajectory = syntheticTrajectory(taskDir);

    const zipRes = await generateHarborTaskFromTrajectory({
      trajectory: mockTrajectory,
      outPath: zipPath,
    });
    assert.ok(zipRes.ok);
    assert.ok(zipRes.size > 0);

    const tarRes = await generateHarborTaskFromTrajectory({
      trajectory: mockTrajectory,
      outPath: tarPath,
    });
    assert.ok(tarRes.ok);
    assert.ok(tarRes.size > 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    await rm(taskDir, { recursive: true, force: true });
  }
});
