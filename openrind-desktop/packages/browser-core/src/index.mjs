import { BrowserFault, Capabilities, LIMITS, failure, parseTool } from '@openrind/browser-contract';
import { Repository } from './repository.mjs';
import { Grants, Approvals, newId, canonical, hash, validateDestination } from './security.mjs';
import { References } from './references.mjs';
import { ArtifactsManager } from './artifacts.mjs';
export { Repository, Grants, BrowserFault, ArtifactsManager };

const terminal = new Set(['Closed', 'Failed']);
const actionTools = new Set(['browser_click', 'browser_fill', 'browser_select', 'browser_press', 'browser_scroll', 'browser_upload_file']);
const capability = { browser_navigate: 'navigation', browser_snapshot: 'semanticSnapshot', browser_screenshot: 'screenshots',
  browser_upload_file: 'fileUpload', browser_downloads: 'fileDownload' };
const publicCapabilities = (value, hasArtifacts) => {
  if (!hasArtifacts) return { ...value, screenshots: false, fileUpload: false, fileDownload: false };
  return { ...value };
};
const success = (s, data, operationId) => ({ ok: true, sessionId: s.id, sessionEpoch: s.epoch,
  ...(operationId ? { operationId } : {}), data, warnings: [] });
const transitions = {
  Creating: ['Ready', 'Failed', 'Uncertain'], Ready: ['Executing', 'HumanControl', 'Disconnected', 'Closing'],
  Executing: ['Ready', 'Uncertain', 'Disconnected'], HumanControl: ['Ready', 'Closing', 'Disconnected'],
  Disconnected: ['Ready', 'Lost', 'Closing'], Uncertain: ['Ready', 'Lost', 'Closing'],
  Lost: ['Closing'], Closing: ['Closed', 'CleanupPending'], CleanupPending: ['Closed', 'Closing'], Failed: [], Closed: [],
};

export class BrowserCore {
  constructor({ repository, providers = [], clock = Date.now, resolver, actionMs = LIMITS.actionMs, artifacts, ...options }) {
    if (!Number.isInteger(actionMs) || actionMs < 1 || actionMs > LIMITS.maxActionMs) throw new Error('Invalid operation deadline');
    this.repo = repository; this.clock = clock; this.resolver = resolver; this.actionMs = actionMs;
    this.artifacts = artifacts;
    this.grants = new Grants(repository, { clock }); this.approvals = new Approvals(repository, { clock });
    this.refs = new References({ clock }); this.providers = new Map();
    for (const provider of providers) {
      if (this.providers.has(provider.kind)) throw new Error('Duplicate provider');
      Capabilities.parse(provider.capabilities); this.providers.set(provider.kind, provider);
    }
    this.live = new Map(); this.queues = new Map(); this.inFlight = new Map(); this.unsettled = new Set(); this.stopping = false;
  }
  publicCapabilities(value) {
    return publicCapabilities(value, Boolean(this.artifacts));
  }
  transition(session, state) {
    if (!transitions[session.state]?.includes(state)) throw new BrowserFault('ACTION_NOT_POSSIBLE');
    session.state = state; this.repo.saveSession(session);
  }
  owned(auth, id) {
    const session = this.repo.session(id);
    if (!session || session.owner !== auth.owner) throw new BrowserFault('FORBIDDEN');
    return session;
  }
  publicSession(session) {
    const unknown = this.repo.db.prepare("SELECT id FROM operations WHERE owner=? AND session=? AND state='unknown' ORDER BY rowid DESC LIMIT 32").all(session.owner, session.id).map(row => row.id);
    return { state: session.state, transport: session.transport, driver: session.driver, human: session.human,
      provider: session.provider, pages: session.pages.map(({ id, generation }) => ({ pageId: id, documentGeneration: generation })),
      ...(session.handoff ? { handoffId: session.handoff.id } : {}), unknownOperationIds: unknown, cleanupPending: session.state === 'CleanupPending' };
  }
  checkSession(auth, args, name) {
    const session = this.owned(auth, args.sessionId);
    if (args.sessionEpoch !== undefined && args.sessionEpoch !== session.epoch) throw new BrowserFault('STALE_EPOCH');
    if (!auth.policy.providers.includes(session.provider)) throw new BrowserFault('POLICY_DENIED');
    if (name !== 'browser_close' && (session.expiresAt <= this.clock() || session.idleUntil <= this.clock())) throw new BrowserFault('SESSION_LOST');
    if (args.pageId && !session.pages.some(page => page.id === args.pageId)) throw new BrowserFault('FORBIDDEN');
    return session;
  }
  async call(token, name, input, { signal } = {}) {
    let args;
    try {
      if (this.stopping) throw new BrowserFault('BACKEND_UNAVAILABLE');
      args = parseTool(name, input);
      const auth = this.grants.authenticate(token);
      if (name === 'browser_capabilities') {
        if (args.sessionId) { const s = this.owned(auth, args.sessionId); return success(s, { capabilities: this.publicCapabilities(s.capabilities) }); }
        return { ok: true, data: { protocol: 1, providers: [...this.providers.values()].filter(p => auth.policy.providers.includes(p.kind))
          .map(p => ({ ...this.publicCapabilities(p.capabilities), experimental: true })) }, warnings: [] };
      }
      if (name === 'browser_start') return await this.start(token, auth, args, signal);
      const session = this.checkSession(auth, args, name);
      if (name === 'browser_status') return success(session, this.publicSession(session));
      const digest = hash(canonical({ name, args }));
      const previous = args.operationId && this.repo.operation(auth.owner, args.operationId);
      if (previous && previous.hash !== digest) throw new BrowserFault('OPERATION_CONFLICT');
      if (previous?.result) return previous.result;
      const key = args.operationId && `${auth.owner}:${args.operationId}`;
      if (key && this.inFlight.has(key)) return await this.inFlight.get(key);
      const task = this.enqueue(session.id, async () => {
        try {
          const currentAuth = this.grants.authenticate(token);
          const current = this.checkSession(currentAuth, args, name);
          if (signal?.aborted) throw new BrowserFault('CANCELLED');
          if (this.unsettled.has(current.id)) throw new BrowserFault('OUTCOME_UNKNOWN', 'unknown');
          return await this.execute(currentAuth, current, name, args, digest, signal);
        } catch (error) { return failure(error, args.operationId); }
      });
      if (key) this.inFlight.set(key, task);
      try { return await task; } finally { if (key) this.inFlight.delete(key); }
    } catch (error) { return failure(error, args?.operationId); }
  }
  enqueue(sessionId, action) {
    const queue = this.queues.get(sessionId) || { tail: Promise.resolve(), count: 0 };
    if (queue.count >= LIMITS.queue) throw new BrowserFault('RATE_LIMITED');
    queue.count++; this.queues.set(sessionId, queue);
    const task = queue.tail.then(action);
    queue.tail = task.catch(() => {}).finally(() => { queue.count--; if (!queue.count) this.queues.delete(sessionId); });
    return task;
  }
  operation(auth, session, name, args, digest) {
    return { owner: auth.owner, session: session.id, epoch: session.epoch, id: args.operationId,
      hash: digest, state: 'accepted', createdAt: this.clock(), expiresAt: this.clock() + LIMITS.operationRetentionMs, tool: name };
  }
  async start(token, auth, args, signal) {
    const digest = hash(canonical({ name: 'browser_start', args }));
    const prior = this.repo.operation(auth.owner, args.operationId);
    if (prior && prior.hash !== digest) throw new BrowserFault('OPERATION_CONFLICT');
    if (prior?.result) return prior.result;
    const key = `${auth.owner}:${args.operationId}`;
    if (this.inFlight.has(key)) return this.inFlight.get(key);
    // Serialize allocation for this worker, including checks that span sessions.
    const task = this.enqueue('allocation', async () => {
      let session, op;
      try {
        auth = this.grants.authenticate(token);
        if (signal?.aborted) throw new BrowserFault('CANCELLED');
        if (!auth.policy.providers.includes(args.provider)) throw new BrowserFault('POLICY_DENIED');
        const provider = this.providers.get(args.provider);
        if (!provider) throw new BrowserFault('CAPABILITY_UNAVAILABLE');
        if (args.networkEnforcement !== provider.capabilities.networkEnforcement ||
            args.profileMode !== provider.capabilities.profiles || (args.profileId && !auth.policy.profiles.includes(args.profileId))) throw new BrowserFault('POLICY_DENIED');
        const url = args.url ? await validateDestination(args.url, auth.policy, this.resolver) : undefined;
        this.grants.assertActive(auth);
        const now = this.clock();
        session = { id: newId('bs'), owner: auth.owner, epoch: 1, provider: args.provider, state: 'Creating',
          conversationKey: hash(canonical([auth.principal.tenantId, auth.principal.workspaceId, auth.principal.conversationId])),
          transport: 'connected', driver: 'unknown', human: 'none', pages: [], capabilities: provider.capabilities,
          createdAt: now, expiresAt: now + LIMITS.sessionMs, idleUntil: now + LIMITS.idleMs,
          profileId: args.profileId || null, resource: null, handoff: null };
        op = this.operation(auth, session, 'browser_start', args, digest);
        this.repo.transaction(() => {
          const active = this.repo.sessions().filter(s => !terminal.has(s.state));
          if (active.length >= LIMITS.sessionsPerWorker || active.filter(s => s.conversationKey === session.conversationKey).length >= LIMITS.sessionsPerConversation) throw new BrowserFault('RATE_LIMITED');
          if (args.profileId) {
            if (this.repo.db.prepare('SELECT id FROM leases WHERE id=?').get(args.profileId)) throw new BrowserFault('POLICY_DENIED');
            this.repo.db.prepare('INSERT INTO leases VALUES(?,?,?)').run(args.profileId, auth.owner, session.id);
          }
          op.state = 'dispatching'; this.repo.saveSession(session); this.repo.saveOperation(op);
          this.repo.audit('creating', session.id, op.id);
        });
        let created;
        try {
          created = await this.bounded(session, op, context => provider.create(Object.freeze({
            provider: args.provider, profileMode: args.profileMode, profileId: args.profileId, initialUrl: url,
            allowedOrigins: [...auth.policy.origins], networkEnforcement: args.networkEnforcement }), context),
            auth, signal, LIMITS.creationMs);
          const capabilities = Capabilities.parse(created.capabilities);
          if (capabilities.provider !== args.provider || canonical(capabilities) !== canonical(provider.capabilities)) throw new BrowserFault('BACKEND_UNAVAILABLE', 'unknown');
          this.live.set(session.id, created);
          session.resource = created.handle;
          if (typeof session.resource !== 'string' || session.resource.length > 256 || session.resource.includes('://')) throw new BrowserFault('BACKEND_UNAVAILABLE', 'unknown');
          // Persist identity before inspecting pages; a later crash can reconcile it.
          this.repo.saveSession(session);
          const pages = await this.bounded(session, op, () => created.pages(), auth, signal, this.actionMs);
          if (!Array.isArray(pages) || !pages.length || pages.length > LIMITS.pages || new Set(pages.map(p => p.pageId)).size !== pages.length) throw new BrowserFault('BACKEND_UNAVAILABLE', 'unknown');
          session.pages = pages.map(p => this.pageRecord(p));
          session.driver = 'ready'; this.transition(session, 'Ready');
          op.state = 'completed'; op.result = success(session, { ...this.publicSession(session), capabilities: this.publicCapabilities(capabilities) }, op.id);
          this.repo.saveOperation(op); return op.result;
        } catch (innerError) {
          if (created && !session.resource) {
            try { await provider.close(created, 'revoked'); } catch {}
          }
          throw innerError;
        }
      } catch (error) {
        if (session && op && this.repo.session(session.id)) {
          session = this.repo.session(session.id); session.epoch++; session.driver = 'unknown';
          if (!session.resource && !this.live.has(session.id)) {
            session.state = 'Failed';
            op.state = 'failed';
            op.result = failure(error instanceof BrowserFault ? error : new BrowserFault('BACKEND_UNAVAILABLE', 'not-started'), op.id);
            this.repo.transaction(() => {
              this.repo.db.prepare('DELETE FROM leases WHERE session=?').run(session.id);
              this.repo.saveSession(session);
              this.repo.saveOperation(op);
            });
            this.repo.audit('failed', session.id, op.id);
            return op.result;
          }
          session.state = 'Uncertain';
          op.state = 'unknown'; op.result = failure(new BrowserFault('OUTCOME_UNKNOWN', 'unknown'), op.id);
          this.repo.transaction(() => { this.repo.saveSession(session); this.repo.saveOperation(op); });
          return op.result;
        }
        return failure(error, args.operationId);
      }
    });
    this.inFlight.set(key, task);
    try { return await task; } finally { this.inFlight.delete(key); }
  }
  pageRecord(page) {
    if (!page || typeof page.pageId !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{2,127}$/.test(page.pageId) || !Number.isSafeInteger(page.documentGeneration) || page.documentGeneration < 1) throw new BrowserFault('BACKEND_UNAVAILABLE');
    let origin = null;
    if (page.url) { const u = new URL(page.url); if (u.protocol === 'https:') origin = u.origin; else if (page.url !== 'about:blank') throw new BrowserFault('POLICY_DENIED'); }
    return { id: page.pageId, generation: page.documentGeneration, origin };
  }
  binding(auth, session, name, args, digest) {
    const page = session.pages.find(p => p.id === args.pageId);
    return { owner: auth.owner, grantId: auth.principal.grantId, sessionId: session.id, sessionEpoch: session.epoch,
      pageId: args.pageId || '', origin: page?.origin || '', operationId: args.operationId,
      tool: name, inputHash: digest, policyRevision: auth.policy.revision };
  }
  approve(token, name, input, expiresAt) {
    const args = parseTool(name, input), auth = this.grants.authenticate(token);
    if (!actionTools.has(name)) throw new BrowserFault('INVALID_ARGUMENT');
    const session = this.checkSession(auth, args, name);
    return this.approvals.issue(this.binding(auth, session, name, args, hash(canonical({ name, args }))), expiresAt);
  }
  async execute(auth, session, name, args, digest, signal) {
    if (name === 'browser_close' && session.state === 'Closed') return success(session, { closed: true }, args.operationId);
    const uncertainRead = session.state === 'Uncertain' && ['browser_snapshot', 'browser_tabs'].includes(name) && (!args.action || args.action === 'list');
    if (name !== 'browser_close' && name !== 'browser_resume' && session.state !== 'Ready' && !uncertainRead) throw new BrowserFault(session.state === 'Uncertain' ? 'OUTCOME_UNKNOWN' : 'ACTION_NOT_POSSIBLE', session.state === 'Uncertain' ? 'unknown' : 'not-started');
    const live = this.live.get(session.id);
    if (!live) throw new BrowserFault('SESSION_LOST');
    const needed = actionTools.has(name) ? 'elementActions' : capability[name];
    if (needed && !session.capabilities[needed]) throw new BrowserFault('CAPABILITY_UNAVAILABLE');
    if (args.secretId) throw new BrowserFault('CAPABILITY_UNAVAILABLE');
    if (['browser_upload_file', 'browser_screenshot', 'browser_downloads'].includes(name)) {
      if (!this.artifacts) throw new BrowserFault('CAPABILITY_UNAVAILABLE');
      if (needed && !session.capabilities[needed]) throw new BrowserFault('CAPABILITY_UNAVAILABLE');
    }
    const page = args.pageId && session.pages.find(p => p.id === args.pageId);
    const context = { owner: auth.owner, sessionId: session.id, sessionEpoch: session.epoch, pageId: args.pageId };
    const target = args.ref ? this.refs.resolve(args.ref, context, page.generation) : undefined;
    const url = args.url ? await validateDestination(args.url, auth.policy, this.resolver) : undefined;
    if (name === 'browser_tabs' && args.action === 'open' && session.pages.length >= LIMITS.pages) throw new BrowserFault('RATE_LIMITED');
    if (name === 'browser_take_control' && session.capabilities.manualControl === 'none') throw new BrowserFault('CAPABILITY_UNAVAILABLE');
    if (name === 'browser_resume' && (session.state !== 'HumanControl' || !session.handoff?.released || session.handoff.id !== args.handoffId)) throw new BrowserFault('FORBIDDEN');
    if (name === 'browser_close' && !['Ready', 'HumanControl', 'Disconnected', 'Uncertain', 'Lost', 'CleanupPending'].includes(session.state)) throw new BrowserFault('ACTION_NOT_POSSIBLE');
    const op = args.operationId ? this.operation(auth, session, name, args, digest) : null;
    this.grants.assertActive(auth);
    if (this.repo.session(session.id)?.epoch !== session.epoch) throw new BrowserFault('STALE_EPOCH');
    if (signal?.aborted) throw new BrowserFault('CANCELLED');
    this.repo.transaction(() => {
      if (actionTools.has(name) && auth.policy.approveMutations) this.approvals.consume(this.binding(auth, session, name, args, digest));
      if (op) { op.state = 'dispatching'; this.repo.saveOperation(op); }
      if (name === 'browser_close') this.transition(session, 'Closing');
      else if (session.state === 'Ready') this.transition(session, 'Executing');
      this.repo.audit('dispatching', session.id, op?.id || null);
    });
    try {
      const data = await this.bounded(session, op, async ctx => {
        const fresh = () => {
          if (ctx.signal.aborted || this.repo.session(session.id)?.epoch !== ctx.sessionEpoch) throw new BrowserFault('OUTCOME_UNKNOWN', 'unknown');
          this.grants.assertActive(auth);
        };
        fresh();
        if (name === 'browser_tabs') {
          if (args.action === 'list') return { pages: session.pages.map(p => ({ pageId: p.id })) };
          if (args.action === 'open') { const created = await live.openPage(url, ctx); fresh(); session.pages.push(this.pageRecord(created)); return { pageId: created.pageId }; }
          await live.page(args.pageId).close(ctx); fresh(); session.pages = session.pages.filter(p => p.id !== args.pageId); this.refs.invalidate(session.id, args.pageId); return { closed: true };
        }
        if (name === 'browser_navigate') {
          page.origin = null;
          const result = await live.page(args.pageId).navigate(url, ctx);
          const destination = await validateDestination(result.url, auth.policy, this.resolver);
          fresh();
          if (!Number.isSafeInteger(result.documentGeneration) || result.documentGeneration <= page.generation) throw new BrowserFault('BACKEND_UNAVAILABLE');
          page.origin = destination.origin; page.generation = result.documentGeneration; this.refs.invalidate(session.id, page.id);
          return { url: destination.href, documentGeneration: page.generation };
        }
        if (name === 'browser_snapshot') {
          if (session.state === 'Uncertain' || !page.origin || (auth.policy.origins.length > 0 && !auth.policy.origins.includes(page.origin))) {
            const currentPages = await live.pages();
            const current = currentPages.find(p => p.pageId === page.id);
            if (!current?.url || current.url === 'about:blank') {
              if (current?.url && current.url !== 'about:blank') throw new BrowserFault('POLICY_DENIED');
            } else {
              const destination = await validateDestination(current.url, auth.policy, this.resolver);
              page.origin = destination.origin;
            }
          }
          if (page.origin && auth.policy.origins.length > 0 && !auth.policy.origins.includes(page.origin)) throw new BrowserFault('POLICY_DENIED');
          const raw = await live.page(args.pageId).snapshot(args, ctx);
          fresh();
          if (raw.documentGeneration < page.generation) throw new BrowserFault('STALE_REF');
          page.generation = raw.documentGeneration;
          return this.refs.snapshot(raw, context, args);
        }
        if (name === 'browser_screenshot') {
          const raw = await live.page(args.pageId).screenshot(args, ctx);
          fresh();
          const staged = await this.artifacts.stage(auth.owner, session.id, raw, {
            mimeType: 'image/png',
            maxBytes: LIMITS.screenshotBytes,
          });
          return { artifactId: staged.id, byteCount: staged.byteCount, sha256: staged.sha256, mimeType: staged.mimeType };
        }
        if (name === 'browser_downloads') {
          const downloads = this.artifacts.listDownloads(auth.owner, session.id);
          fresh();
          return { downloads };
        }
        if (actionTools.has(name)) {
          const kind = name.slice(8);
          let fileArtifact;
          if (kind === 'upload_file') {
            fileArtifact = await this.artifacts.get(auth.owner, args.artifactId);
          }
          const action = Object.freeze({ kind, ...(target ? { target } : {}),
            ...(fileArtifact ? { artifact: fileArtifact } : {}),
            ...(kind === 'fill' ? { text: args.text } : {}), ...(kind === 'select' ? { values: args.values } : {}),
            ...(kind === 'press' ? { key: args.key } : {}), ...(kind === 'scroll' ? { direction: args.direction, distance: args.distance } : {}) });
          await live.page(args.pageId).act(action, ctx);
          fresh();
          this.refs.invalidate(session.id, args.pageId);
          return kind === 'upload_file' ? { uploaded: true, artifactId: args.artifactId } : { dispatched: true };
        }
        if (name === 'browser_take_control') {
          await live.setHumanControl(true, ctx); fresh(); this.refs.invalidate(session.id); session.epoch++;
          session.handoff = { id: newId('bh'), released: false }; session.human = 'active'; session.state = 'HumanControl';
          return { handoffId: session.handoff.id };
        }
        if (name === 'browser_resume') {
          await live.setHumanControl(false, ctx); fresh(); session.epoch++; this.refs.invalidate(session.id);
          session.handoff = null; session.human = 'none'; session.state = 'Ready'; return { resumed: true };
        }
        if (name === 'browser_close') {
          const result = await this.providers.get(session.provider).close(live, 'requested');
          fresh();
          if (result?.closed !== true) throw new BrowserFault('BACKEND_UNAVAILABLE');
          this.transition(session, 'Closed'); session.driver = 'closed'; session.human = 'none'; session.epoch++;
          this.refs.invalidate(session.id); this.live.delete(session.id);
          this.repo.db.prepare('DELETE FROM leases WHERE session=?').run(session.id);
          return { closed: true };
        }
        throw new BrowserFault('CAPABILITY_UNAVAILABLE');
      }, auth, signal, this.actionMs);
      if (session.state === 'Executing') this.transition(session, 'Ready');
      session.idleUntil = Math.min(session.expiresAt, this.clock() + LIMITS.idleMs);
      this.repo.saveSession(session);
      const result = success(session, data, args.operationId);
      if (op) { op.state = 'completed'; op.result = result; this.repo.saveOperation(op); }
      this.repo.audit('completed', session.id, op?.id || null); return result;
    } catch {
      // Once dispatch starts, even an apparently simple API error can follow a
      // completed website effect. Never replay based on provider error strings.
      session = this.repo.session(session.id); session.epoch++; session.driver = 'unknown';
      session.state = name === 'browser_close' ? 'CleanupPending' : 'Uncertain'; this.refs.invalidate(session.id);
      if (name === 'browser_navigate' && args.pageId) {
        const targetPage = session.pages.find(p => p.id === args.pageId);
        if (targetPage) targetPage.origin = null;
      }
      const result = failure(new BrowserFault('OUTCOME_UNKNOWN', 'unknown'), args.operationId);
      this.repo.transaction(() => { this.repo.saveSession(session); if (op) { op.state = 'unknown'; op.result = result; this.repo.saveOperation(op); }
        this.repo.audit('unknown', session.id, op?.id || null, 'OUTCOME_UNKNOWN'); });
      return result;
    }
  }
  async bounded(session, op, action, auth, outerSignal, milliseconds) {
    const controller = new AbortController(); let timer, abort;
    const originalEpoch = session.epoch;
    const deadline = this.clock() + milliseconds;
    const task = Promise.resolve().then(() => action(Object.freeze({ principal: auth.principal,
      sessionId: session.id, sessionEpoch: originalEpoch, operationId: op?.id,
      deadline, signal: controller.signal })));
    this.unsettled.add(session.id);
    void task.then(() => this.unsettled.delete(session.id), () => this.unsettled.delete(session.id));
    const cancelled = new Promise((_, reject) => {
      abort = () => { controller.abort(); reject(new BrowserFault('OUTCOME_UNKNOWN', 'unknown')); };
      timer = setTimeout(abort, milliseconds);
      outerSignal?.addEventListener('abort', abort, { once: true });
      if (outerSignal?.aborted) abort();
    });
    try {
      const result = await Promise.race([task, cancelled]);
      if (this.repo.session(session.id)?.epoch !== originalEpoch) throw new BrowserFault('OUTCOME_UNKNOWN', 'unknown');
      return result;
    } finally { clearTimeout(timer); outerSignal?.removeEventListener('abort', abort); }
  }
  releaseHuman(token, sessionId, handoffId) {
    const auth = this.grants.authenticate(token), session = this.owned(auth, sessionId);
    if (session.state !== 'HumanControl' || session.handoff?.id !== handoffId || this.unsettled.has(sessionId)) throw new BrowserFault('FORBIDDEN');
    session.handoff.released = true; this.repo.saveSession(session);
  }
  async reconcile(token, sessionId) {
    // Trusted controller operation after inspection, never a public replay tool.
    const auth = this.grants.authenticate(token);
    return this.enqueue(sessionId, async () => {
      this.grants.assertActive(auth);
      const session = this.owned(auth, sessionId);
      if (!['Uncertain', 'Disconnected'].includes(session.state) || this.unsettled.has(sessionId)) throw new BrowserFault('ACTION_NOT_POSSIBLE');
      if (!session.resource || !auth.policy.providers.includes(session.provider)) {
        if (!session.resource) {
          session.state = 'Failed'; session.epoch++;
          this.repo.transaction(() => {
            this.repo.db.prepare('DELETE FROM leases WHERE session=?').run(session.id);
            this.repo.saveSession(session);
          });
        }
        throw new BrowserFault('SESSION_LOST');
      }
      let live = this.live.get(sessionId);
      if (!live) {
        const provider = this.providers.get(session.provider);
        if (!provider || provider.capabilities.reconnect !== 'existing-session') throw new BrowserFault('CAPABILITY_UNAVAILABLE');
        live = await this.bounded(session, null, ctx => provider.recover(Object.freeze({ sessionId, sessionEpoch: session.epoch, handle: session.resource }), ctx), auth, undefined, this.actionMs);
        if (live?.lost) { session.state = 'Lost'; this.repo.saveSession(session); throw new BrowserFault('SESSION_LOST'); }
        if (live.handle !== session.resource || canonical(Capabilities.parse(live.capabilities)) !== canonical(session.capabilities)) throw new BrowserFault('FORBIDDEN');
      }
      const pages = await this.bounded(session, null, () => live.pages(), auth, undefined, this.actionMs);
      if (!Array.isArray(pages) || pages.length > LIMITS.pages || new Set(pages.map(p => p.pageId)).size !== pages.length) throw new BrowserFault('BACKEND_UNAVAILABLE');
      for (const page of pages) if (page.url && page.url !== 'about:blank') await validateDestination(page.url, auth.policy, this.resolver);
      this.grants.assertActive(auth);
      if (this.repo.session(sessionId).epoch !== session.epoch) throw new BrowserFault('STALE_EPOCH');
      session.pages = pages.map(p => this.pageRecord(p)); session.epoch++; this.refs.invalidate(sessionId);
      session.transport = 'connected'; session.driver = 'ready'; session.human = 'none'; session.handoff = null;
      session.idleUntil = Math.min(session.expiresAt, this.clock() + LIMITS.idleMs);
      this.live.set(sessionId, live); this.transition(session, 'Ready');
      this.repo.audit('reconciled', sessionId); return success(session, this.publicSession(session));
    });
  }
  disconnectOwner(owner) {
    this.grants.revokeOwner(owner);
    for (const session of this.repo.sessions().filter(s => s.owner === owner && !terminal.has(s.state))) {
      session.epoch++; session.transport = 'disconnected'; session.driver = 'unknown';
      session.state = ['Executing', 'Creating', 'Uncertain'].includes(session.state) ? 'Uncertain' : session.state === 'CleanupPending' ? 'CleanupPending' : 'Disconnected';
      this.refs.invalidate(session.id); this.repo.saveSession(session);
    }
  }
  async deleteConversation(scope) {
    const conversationKey = hash(canonical([scope.tenantId, scope.workspaceId, scope.conversationId]));
    const owners = new Set(this.repo.sessions().filter(s => s.conversationKey === conversationKey).map(s => s.owner));
    for (const row of this.repo.db.prepare('SELECT owner,data FROM grants').all()) {
      const principal = JSON.parse(row.data).principal;
      if (['tenantId', 'workspaceId', 'conversationId'].every(key => principal[key] === scope[key])) owners.add(row.owner);
    }
    // Revoke every sandbox grant for this conversation before the first close.
    for (const owner of owners) this.disconnectOwner(owner);
    return await Promise.all(this.repo.sessions().filter(s => owners.has(s.owner) && !terminal.has(s.state)).map(async session => {
      const live = this.live.get(session.id);
      if (!session.resource && !live && !this.unsettled.has(session.id)) {
        session.state = 'Closed'; session.driver = 'closed';
        this.repo.db.prepare('DELETE FROM leases WHERE session=?').run(session.id);
        this.repo.saveSession(session);
        return { sessionId: session.id, closed: true };
      }
      // Never race close with an operation whose driver has not settled.
      if (!live || this.unsettled.has(session.id)) { session.state = 'CleanupPending'; this.repo.saveSession(session); return { sessionId: session.id, closed: false }; }
      try {
        const result = await Promise.race([this.providers.get(session.provider).close(live, 'revoked'),
          new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error()), this.actionMs); timer.unref?.(); })]);
        if (!result?.closed) throw new Error();
        session.state = 'Closed'; session.driver = 'closed'; this.live.delete(session.id);
        this.repo.db.prepare('DELETE FROM leases WHERE session=?').run(session.id);
      } catch { session.state = 'CleanupPending'; }
      this.repo.saveSession(session); return { sessionId: session.id, closed: session.state === 'Closed' };
    }));
  }
  async sweep() {
    // Called by a trusted service scheduler. Expired grants never remain usable;
    // expired resources remain visible until provider cleanup is confirmed.
    const now = this.clock();
    this.repo.db.prepare('UPDATE grants SET active=0 WHERE expires<=?').run(now);
    const results = [];
    for (const session of this.repo.sessions().filter(s => !terminal.has(s.state) && (s.expiresAt <= now || s.idleUntil <= now))) {
      session.epoch++; session.state = 'CleanupPending'; this.refs.invalidate(session.id); this.repo.saveSession(session);
      const live = this.live.get(session.id); let timer;
      if (live && !this.unsettled.has(session.id)) {
        try {
          const result = await Promise.race([this.providers.get(session.provider).close(live, 'revoked'),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error()), this.actionMs); })]);
          if (!result?.closed) throw new Error();
          session.state = 'Closed'; session.driver = 'closed'; this.live.delete(session.id);
          this.repo.db.prepare('DELETE FROM leases WHERE session=?').run(session.id);
          this.repo.saveSession(session);
        } catch { /* Pending cleanup stays visible; no silent success. */ } finally { clearTimeout(timer); }
      } else if (!session.resource && !live && !this.unsettled.has(session.id)) {
        session.state = 'Closed'; session.driver = 'closed';
        this.repo.db.prepare('DELETE FROM leases WHERE session=?').run(session.id);
        this.repo.saveSession(session);
      }
      results.push({ sessionId: session.id, closed: session.state === 'Closed' });
    }
    this.repo.db.prepare("DELETE FROM operations WHERE state IN ('completed','failed') AND json_extract(data,'$.expiresAt')<=?").run(now);
    this.repo.db.prepare("DELETE FROM approvals WHERE consumed=1 OR json_extract(data,'$.expiresAt')<=?").run(now);
    return results;
  }
  renewHuman(token, sessionId, handoffId) {
    const auth = this.grants.authenticate(token), session = this.owned(auth, sessionId);
    if (session.state !== 'HumanControl' || session.handoff?.id !== handoffId || session.expiresAt <= this.clock()) throw new BrowserFault('FORBIDDEN');
    session.idleUntil = Math.min(session.expiresAt, this.clock() + LIMITS.idleMs); this.repo.saveSession(session);
  }
  async shutdown() {
    this.stopping = true;
    const owners = [...new Set(this.repo.sessions().map(s => s.owner))];
    for (const owner of owners) this.disconnectOwner(owner);
    // Keep the registry open while uninterruptible callbacks may still settle.
    if (this.unsettled.size) {
      this.repo.close();
      return { closed: false, pending: [...this.unsettled] };
    }
    const result = [];
    for (const session of this.repo.sessions().filter(s => !terminal.has(s.state))) {
      const live = this.live.get(session.id);
      let timer;
      try { if (!live || !(await Promise.race([this.providers.get(session.provider).close(live, 'shutdown'),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error()), this.actionMs); })]))?.closed) throw new Error();
        session.state = 'Closed'; this.repo.db.prepare('DELETE FROM leases WHERE session=?').run(session.id);
      } catch { session.state = 'CleanupPending'; } finally { clearTimeout(timer); }
      this.repo.saveSession(session); result.push({ sessionId: session.id, closed: session.state === 'Closed' });
    }
    this.repo.close(); return { closed: result.every(s => s.closed), sessions: result };
  }
}
