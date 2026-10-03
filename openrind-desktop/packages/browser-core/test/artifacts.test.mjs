import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { BrowserCore, Repository, ArtifactsManager } from '../src/index.mjs';
import { createLocalChromiumProvider } from '../../browser-providers/src/local-chromium.mjs';
import { createLocalTransfers, assertPathBeneath, verifyNoSymlinkEscape } from '../../browser-client/src/transfers.mjs';

test('ArtifactsManager: staging, quotas, hash verification, and TTL cleanup', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'artifacts-mgr-'));
  const artifacts = new ArtifactsManager({ stagingDir: dir });
  t.after(async () => { await artifacts.close(); });

  const owner = 'owner_one';
  const sessionId = 'bs_test_session';
  const content = Buffer.from('test artifact data for step 5\n');
  const expectedSha256 = createHash('sha256').update(content).digest('hex');

  // Successful staging
  const staged = await artifacts.stage(owner, sessionId, content, {
    filename: 'test.txt',
    mimeType: 'text/plain',
    expectedSha256,
  });

  assert.ok(staged.id.startsWith('art_'));
  assert.equal(staged.byteCount, content.length);
  assert.equal(staged.sha256, expectedSha256);

  // Hash mismatch detection
  await assert.rejects(
    artifacts.stage(owner, sessionId, content, {
      expectedSha256: '0000000000000000000000000000000000000000000000000000000000000000',
    }),
    error => error.code === 'INVALID_ARGUMENT'
  );

  // Retrieval
  const fetched = await artifacts.get(owner, staged.id);
  assert.equal(fetched.id, staged.id);
  assert.deepEqual(fetched.buffer, content);

  // Cross-owner isolation
  await assert.rejects(
    artifacts.get('owner_intruder', staged.id),
    error => error.code === 'ARTIFACT_EXPIRED'
  );

  // Quota enforcement
  const tinyManager = new ArtifactsManager({
    stagingDir: await mkdtemp(join(tmpdir(), 'artifacts-tiny-')),
    maxQuota: 100,
  });
  t.after(async () => { await tinyManager.close(); });

  await assert.rejects(
    tinyManager.stage(owner, sessionId, Buffer.alloc(150)),
    error => error.code === 'RATE_LIMITED'
  );

  // TTL sweeping
  let clockTime = 1000;
  const expiringManager = new ArtifactsManager({
    stagingDir: await mkdtemp(join(tmpdir(), 'artifacts-exp-')),
    clock: () => clockTime,
  });
  t.after(async () => { await expiringManager.close(); });

  const expRecord = await expiringManager.stage(owner, sessionId, content, { ttlMs: 500 });
  assert.ok(await expiringManager.get(owner, expRecord.id));

  // Advance clock past TTL
  clockTime += 600;
  await assert.rejects(
    expiringManager.get(owner, expRecord.id),
    error => error.code === 'ARTIFACT_EXPIRED'
  );
});

test('Client-local transfers: confinement checks, import, and atomic save', async t => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'workspace-root-'));
  const stagingDir = await mkdtemp(join(tmpdir(), 'artifacts-staging-'));
  const artifacts = new ArtifactsManager({ stagingDir });

  t.after(async () => {
    await artifacts.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const owner = 'owner_worker';
  const sessionId = 'bs_session_1';
  const transfers = createLocalTransfers({ workspaceRoot, artifacts, owner });

  // Confinement: path traversal rejection
  assert.throws(() => assertPathBeneath(workspaceRoot, '../escape.txt'), e => e.code === 'INVALID_ARGUMENT');
  assert.throws(() => assertPathBeneath(workspaceRoot, 'foo/../../escape.txt'), e => e.code === 'INVALID_ARGUMENT');
  assert.throws(() => assertPathBeneath(workspaceRoot, '/absolute/path.txt'), e => e.code === 'INVALID_ARGUMENT');
  assert.throws(() => assertPathBeneath(workspaceRoot, 'C:\\windows\\win.ini'), e => e.code === 'INVALID_ARGUMENT');

  // Symlink escape rejection
  const externalDir = await mkdtemp(join(tmpdir(), 'external-secret-'));
  t.after(async () => { await rm(externalDir, { recursive: true, force: true }); });
  const secretFile = join(externalDir, 'secret.txt');
  await writeFile(secretFile, 'sensitive data');
  const symlinkPath = join(workspaceRoot, 'symlink_outside');
  try {
    await symlink(externalDir, symlinkPath, 'junction');
    await assert.rejects(
      verifyNoSymlinkEscape(workspaceRoot, join(symlinkPath, 'secret.txt')),
      error => error.code === 'POLICY_DENIED'
    );
  } catch (e) {
    // Windows non-admin symlink skip if not supported
    if (e.code !== 'EPERM') throw e;
  }

  // Import file
  const testFileRel = 'docs/report.txt';
  const fullTestPath = join(workspaceRoot, testFileRel);
  await mkdir(join(workspaceRoot, 'docs'), { recursive: true });
  const fileBytes = Buffer.from('monthly engineering report content\n');
  await writeFile(fullTestPath, fileBytes);

  const importResult = await transfers('browser_import_file', {
    sessionId,
    sessionEpoch: 1,
    operationId: 'op_import_1',
    path: testFileRel,
  });

  assert.equal(importResult.ok, true);
  assert.ok(importResult.data.artifactId);
  assert.equal(importResult.data.byteCount, fileBytes.length);
  const expectedHash = createHash('sha256').update(fileBytes).digest('hex');
  assert.equal(importResult.data.sha256, expectedHash);

  // Save artifact to new workspace destination
  const saveRel = 'exports/saved_report.txt';
  const saveResult = await transfers('browser_save_artifact', {
    sessionId,
    sessionEpoch: 1,
    operationId: 'op_save_1',
    artifactId: importResult.data.artifactId,
    destination: saveRel,
    overwrite: false,
  });

  assert.equal(saveResult.ok, true);
  assert.equal(saveResult.data.saved, true);
  assert.equal(saveResult.data.destination, saveRel);

  // Verify bytes persisted on disk
  const savedDiskBytes = await readFile(join(workspaceRoot, saveRel));
  assert.deepEqual(savedDiskBytes, fileBytes);

  // Overwrite protection: saving again without overwrite should fail
  await assert.rejects(
    transfers('browser_save_artifact', {
      sessionId,
      sessionEpoch: 1,
      operationId: 'op_save_2',
      artifactId: importResult.data.artifactId,
      destination: saveRel,
      overwrite: false,
    }),
    error => error.code === 'POLICY_DENIED'
  );

  // Overwrite allowed when overwrite: true
  const overwriteResult = await transfers('browser_save_artifact', {
    sessionId,
    sessionEpoch: 1,
    operationId: 'op_save_3',
    artifactId: importResult.data.artifactId,
    destination: saveRel,
    overwrite: true,
  });
  assert.equal(overwriteResult.ok, true);
});

test('End-to-End: browser screenshots and file upload with Playwright and BrowserCore', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'artifacts-e2e-'));
  const stagingDir = join(dir, 'staging');
  const workspaceRoot = join(dir, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });

  const repo = new Repository(join(dir, 'registry.sqlite'));
  const artifacts = new ArtifactsManager({ stagingDir });
  const provider = createLocalChromiumProvider({ headless: true });

  const core = new BrowserCore({
    repository: repo,
    providers: [provider],
    artifacts,
  });

  t.after(async () => {
    await core.shutdown();
    await artifacts.close();
    if (repo.db) repo.close();
    await rm(dir, { recursive: true, force: true });
  });

  const scope = { tenantId: 'tenant_test', workspaceId: 'workspace_test', sandboxId: 'sandbox_test', conversationId: 'conversation_test' };
  const policy = { revision: 1, providers: ['local-chromium'], origins: [], approveMutations: false };

  const grant = core.grants.issue(scope, policy);

  // Capabilities should now advertise screenshots and file transfers!
  const caps = await core.call(grant.token, 'browser_capabilities', {});
  const localChromiumCaps = caps.data.providers.find(p => p.provider === 'local-chromium');
  assert.ok(localChromiumCaps);
  assert.equal(localChromiumCaps.screenshots, true);
  assert.equal(localChromiumCaps.fileUpload, true);
  assert.equal(localChromiumCaps.fileDownload, true);

  // Start browser session
  const startResult = await core.call(grant.token, 'browser_start', {
    provider: 'local-chromium',
    operationId: 'op_start_art',
  });
  assert.equal(startResult.ok, true);

  const sessionId = startResult.sessionId;
  const sessionEpoch = startResult.sessionEpoch;
  const pageId = startResult.data.pages[0].pageId;

  // Navigate to page with file input and visual content
  const pageHtml = `
    <!DOCTYPE html>
    <html>
      <head><title>Artifact Page</title></head>
      <body style="background: #123456; color: white;">
        <h1 id="heading">Screenshot & Upload Target</h1>
        <form>
          <label for="uploader">Attach File</label>
          <input id="uploader" type="file">
          <div id="file-info">No file</div>
        </form>
        <script>
          document.getElementById('uploader').addEventListener('change', function() {
            const f = this.files[0];
            if (f) {
              f.text().then(t => {
                document.getElementById('file-info').textContent = f.name + ':' + t;
              });
            }
          });
        </script>
      </body>
    </html>
  `;

  const live = core.live.get(sessionId);
  const pageDriver = live.page(pageId);
  await pageDriver.page.setContent(pageHtml);

  // 1. Test browser_screenshot
  const shotResult = await core.call(grant.token, 'browser_screenshot', {
    sessionId,
    sessionEpoch,
    pageId,
    operationId: 'op_shot_1',
  });

  assert.equal(shotResult.ok, true);
  assert.ok(shotResult.data.artifactId);
  assert.equal(shotResult.data.mimeType, 'image/png');
  assert.ok(shotResult.data.byteCount > 100);

  // Verify screenshot is stored in artifacts and has valid PNG magic bytes
  const auth = core.grants.authenticate(grant.token);
  const shotArtifact = await artifacts.get(auth.owner, shotResult.data.artifactId);
  assert.equal(shotArtifact.buffer.subarray(0, 4).toString('hex'), '89504e47');

  // Save screenshot using transfers
  const transfers = createLocalTransfers({ workspaceRoot, artifacts, owner: auth.owner });
  const saveShot = await transfers('browser_save_artifact', {
    sessionId,
    sessionEpoch,
    operationId: 'op_save_shot',
    artifactId: shotResult.data.artifactId,
    destination: 'screenshots/shot.png',
  });
  assert.equal(saveShot.ok, true);

  const diskShotBytes = await readFile(join(workspaceRoot, 'screenshots/shot.png'));
  assert.deepEqual(diskShotBytes, shotArtifact.buffer);

  // 2. Test file upload via browser_import_file -> browser_upload_file
  const localUploadFile = 'uploads/sample.txt';
  await mkdir(join(workspaceRoot, 'uploads'), { recursive: true });
  const uploadContent = 'unique-upload-payload-content-12345';
  await writeFile(join(workspaceRoot, localUploadFile), uploadContent);

  const imported = await transfers('browser_import_file', {
    sessionId,
    sessionEpoch,
    operationId: 'op_imp_upload',
    path: localUploadFile,
  });
  assert.equal(imported.ok, true);

  // Take snapshot to find file input ref
  const snap = await core.call(grant.token, 'browser_snapshot', {
    sessionId,
    sessionEpoch,
    pageId,
  });

  function findNode(nodes, predicate) {
    for (const n of nodes) {
      if (predicate(n)) return n;
      if (n.children) {
        const found = findNode(n.children, predicate);
        if (found) return found;
      }
    }
    return null;
  }

  const uploaderNode = findNode(snap.data.nodes, n => n.name === 'Attach File' && n.ref);
  assert.ok(uploaderNode, 'File input element must have an action ref');

  // Call browser_upload_file
  const uploadResult = await core.call(grant.token, 'browser_upload_file', {
    sessionId,
    sessionEpoch,
    pageId,
    operationId: 'op_upload_act',
    ref: uploaderNode.ref,
    artifactId: imported.data.artifactId,
  });
  assert.equal(uploadResult.ok, true);
  assert.equal(uploadResult.data.uploaded, true);

  // Verify in the page DOM that the file input received the file
  await new Promise(r => setTimeout(r, 200));
  const fileInfoText = await pageDriver.page.textContent('#file-info');
  assert.equal(fileInfoText, 'sample.txt:' + uploadContent);

  // Close session
  await core.call(grant.token, 'browser_close', {
    sessionId,
    sessionEpoch,
    operationId: 'op_close_art',
  });
});
