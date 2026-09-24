import path from 'node:path';
import { privateDir } from '../config.js';
import { BridgeError, cancelled, throwIfAborted, publicError } from '../errors.js';
import { hash, object, uid, deferred, withAbort } from '../util.js';
import { snapshot, fallbackExtractors } from '../context/snapshot.js';
import { Journal } from '../storage/journal.js';
import { CreditLedger } from '../storage/credits.js';
import { Admission } from '../admission/leases.js';
import { Binding } from '../sessions/coordinator.js';
import { Metrics } from '../diagnostics/metrics.js';
import { LocalStream, StreamWriter } from './stream.js';
import { Catalog } from '../tools/catalog.js';
import { V3Session } from '../kiro/v3.js';
import { saveCatalog, withContextWindow } from './models.js';
import { ensureInstallationId } from '../installation.js';
export class ProviderRuntime {
    config;
    extractors;
    journal;
    admission;
    metrics;
    credits;
    bindings = new Map();
    reservations = new Set();
    drains = new Map();
    host = { cwd: process.cwd() };
    hostEpoch = 0;
    fallbackSession = uid('host_');
    closed = false;
    idleTimer;
    lifetime = new AbortController();
    inFlight = new Set();
    discoveries = new Set();
    accountLoad;
    streamFactory;
    constructor(config, extractors = fallbackExtractors, streamFactory) {
        this.config = config;
        this.extractors = extractors;
        // Local-path Pi installs and installs with scripts disabled reach setup here.
        ensureInstallationId(config);
        this.streamFactory = streamFactory ?? (() => new LocalStream(config.limits.maxQueuedEvents));
        this.journal = new Journal(config.stateDir);
        this.journal.reconcileDeadOwners();
        this.journal.prune();
        this.credits = new CreditLedger(this.journal, config.admission.scope, config.budget, config.reporting.timeZone);
        this.metrics = new Metrics(this.credits, this.config.reporting.accountCacheMs);
        this.admission = new Admission(this.journal, config.admission, () => this.credits.assertAvailable());
        this.idleTimer = setInterval(() => { void this.sweep(); }, Math.min(config.sessions.idleTtlMs, 60000));
        this.idleTimer.unref();
    }
    setHost(ctx) { this.host = ctx; }
    generate(model, context, options = {}) {
        const stream = this.streamFactory();
        const signal = options.signal ? AbortSignal.any([options.signal, this.lifetime.signal]) : this.lifetime.signal;
        const task = this.execute(model, context, { ...options, signal }, stream).catch(e => new StreamWriter(stream, model, this.config.limits.maxOutputBytes).fail(e));
        this.inFlight.add(task);
        void task.finally(() => this.inFlight.delete(task));
        return stream;
    }
    async execute(model, context, options, stream) {
        if (this.closed)
            throw new BridgeError('TRANSPORT', 'Provider runtime is closed.');
        if (model.provider !== 'kiro-acp')
            throw new BridgeError('POLICY', 'This provider serves only Kiro-backed models.');
        if (options.temperature !== undefined)
            throw new BridgeError('UNSUPPORTED', 'Temperature cannot be enforced through this Kiro ACP profile.');
        if (options.toolChoice !== undefined && !['none', 'auto'].includes(options.toolChoice))
            throw new BridgeError('UNSUPPORTED', 'Unsupported tool selection policy.');
        if (options.env && Object.keys(options.env).length)
            throw new BridgeError('UNSUPPORTED', 'Per-request environment overrides are not supported; configure the trusted Kiro CLI environment before starting Pi.');
        throwIfAborted(options.signal);
        this.credits.assertAvailable();
        let effective = context;
        if (options.onPayload) {
            const payload = { transport: 'kiro-acp-v3', modelId: model.id, context };
            const replacement = await withAbort(Promise.resolve(options.onPayload(payload, model)), options.signal);
            if (replacement !== undefined) {
                if (!object(replacement) || replacement.transport !== 'kiro-acp-v3' || replacement.modelId !== model.id || !object(replacement.context) || !Array.isArray(replacement.context.messages))
                    throw new BridgeError('POLICY', 'onPayload returned an invalid or re-routed ACP payload.');
                effective = replacement.context;
            }
        }
        throwIfAborted(options.signal);
        if (this.closed)
            throw cancelled();
        const snap = snapshot(effective, this.extractors, options.toolChoice === 'none', this.config.limits.maxPromptBytes);
        const auxiliary = options.toolChoice === 'none' || snap.tools.length === 0;
        const logicalId = options.sessionId || this.host.sessionManager?.getSessionId?.() || this.fallbackSession;
        this.credits.ensureTask({ sessionId: logicalId, sessionName: this.host.sessionManager?.getSessionName?.(), summary: 'Provider or auxiliary request' });
        const key = hash({ scope: this.config.admission.scope, session: logicalId, epoch: this.hostEpoch, cwd: this.host.cwd, purpose: auxiliary ? uid('aux_') : 'agent' });
        if (this.reservations.has(key)) {
            const prior = this.bindings.get(key);
            if (prior?.streamFinished)
                await this.drains.get(key)?.promise;
            else
                throw new BridgeError('BUSY', 'Two concurrent generations targeted the same Pi conversation.');
        }
        throwIfAborted(options.signal);
        if (this.closed)
            throw cancelled();
        this.reservations.add(key);
        const drain = deferred();
        this.drains.set(key, drain);
        let binding = this.bindings.get(key);
        try {
            // Recover only from an actual result supplied by Pi. A dead process's HTTP callback is never restored.
            for (const row of this.journal.unresolved(key)) {
                if (binding && row.generation === binding.generation)
                    continue;
                if (this.journal.ownerLive(row.owner_instance, row.owner_pid) && row.owner_instance !== this.journal.instance)
                    throw new BridgeError('BUSY', 'Another live process owns this Pi conversation handoff.');
                const result = snap.messages.find(m => m.role === 'toolResult' && m.toolCallId === row.pi_call_id && m.toolName === row.tool_name);
                if (!result)
                    throw new BridgeError('UNCERTAIN', `Unresolved prior tool ${row.pi_call_id}; inspect Pi and run journal/reconcile before retrying.`);
                if (row.phase === 'RECEIVED')
                    this.journal.transition(row.id, 'CANCELLED');
                else {
                    this.journal.transition(row.id, 'RESULT_RECORDED', hash(result));
                    this.journal.transition(row.id, 'CANCELLED');
                }
            }
            if (binding?.hasPending)
                binding.acceptResult(snap);
            if (binding?.needsRebuild(snap, model, typeof options.reasoning === 'string' ? options.reasoning : undefined)) {
                await binding.close();
                this.bindings.delete(key);
                binding = undefined;
                this.metrics.rebuilds++;
            }
            if (!binding) {
                await this.sweep();
                throwIfAborted(options.signal);
                if (this.closed)
                    throw cancelled();
                if (this.bindings.size >= this.config.sessions.maxResident)
                    throw new BridgeError('LIMIT', 'Resident Kiro session limit reached. Close idle sessions or increase the explicit limit.');
                binding = new Binding(key, model, typeof options.reasoning === 'string' ? options.reasoning : undefined, snap, this.config, this.journal, this.admission, this.metrics);
                this.bindings.set(key, binding);
                await binding.start(options.signal);
            }
            await binding.run(snap, stream, options);
        }
        catch (e) {
            if (binding) {
                await binding.close();
                this.bindings.delete(key);
            }
            throw e;
        }
        finally {
            if (auxiliary && binding) {
                await binding.close();
                this.bindings.delete(key);
            }
            this.reservations.delete(key);
            this.drains.delete(key);
            drain.resolve();
        }
    }
    async discover(signal) {
        if (this.closed)
            throw cancelled();
        signal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
        const cwd = path.join(this.config.stateDir, 'discovery');
        privateDir(cwd);
        const session = new V3Session(this.config, cwd, new Catalog([]));
        this.discoveries.add(session);
        try {
            await session.start('You are a tool-less discovery session. Do not infer unless the client explicitly sends a prompt.', undefined, signal);
            const entries = session.catalogEntries();
            if (entries.length === 0)
                throw new BridgeError('MODEL_UNAVAILABLE', 'Kiro returned no live model catalog. Check CLI authentication.');
            if (entries.length > 128)
                throw new BridgeError('LIMIT', 'Kiro catalog exceeds the discovery limit.');
            for (const entry of entries) {
                throwIfAborted(signal);
                await session.select(entry.id, undefined, signal);
                entry.efforts = session.effortValues();
            }
            saveCatalog(this.config, entries, session.version);
            return { models: entries.map(entry => withContextWindow(entry, this.config)), version: session.version, toolAudit: session.toolAudit };
        }
        finally {
            await session.close();
            this.discoveries.delete(session);
        }
    }
    refreshAccountUsage(force = false) {
        if (this.closed)
            return Promise.reject(cancelled());
        if (this.accountLoad)
            return this.accountLoad;
        const cached = this.credits.accountUsage();
        if (process.env.PI_OFFLINE === '1' || process.argv.includes('--offline'))
            return Promise.resolve(cached ?? { checkedAt: Date.now(), status: 'unavailable', planName: 'Unavailable offline', bonuses: [], addOns: [], message: 'Account refresh is disabled in offline mode.' });
        if (!force && cached && Date.now() - Math.max(cached.checkedAt, cached.failedAt ?? 0) < this.config.reporting.accountCacheMs)
            return Promise.resolve(cached);
        this.accountLoad = this.loadAccountUsage(cached).finally(() => { this.accountLoad = undefined; });
        return this.accountLoad;
    }
    async loadAccountUsage(cached) {
        let owned;
        try {
            let session = [...this.bindings.values()].find(binding => !binding.dead && binding.kiro.sessionId)?.kiro;
            if (!session) {
                const cwd = path.join(this.config.stateDir, 'usage');
                privateDir(cwd);
                owned = new V3Session(this.config, cwd, new Catalog([]));
                session = owned;
                this.discoveries.add(session);
                await session.start('Account usage inspection only. Do not infer or run tools.', undefined, this.lifetime.signal);
            }
            const usage = await session.accountUsage(this.lifetime.signal);
            this.credits.saveAccountUsage(usage);
            this.metrics.onCredits?.();
            return usage;
        }
        catch (error) {
            if (this.closed)
                throw cancelled();
            const message = publicError(error).slice(0, 300);
            const usage = cached ? { ...cached, lastError: message, failedAt: Date.now() } : {
                checkedAt: Date.now(), status: 'unavailable', planName: 'Unavailable', bonuses: [], addOns: [], lastError: message,
            };
            this.credits.saveAccountUsage(usage);
            this.metrics.onCredits?.();
            return usage;
        }
        finally {
            if (owned) {
                await owned.close();
                this.discoveries.delete(owned);
            }
        }
    }
    async reset() {
        if ([...this.bindings.values()].some(b => b.hasPending))
            throw new BridgeError('UNCERTAIN', 'Reset refuses pending effects. Cancel, inspect the Pi transcript, then reconcile the journal.');
        await Promise.all([...this.bindings.values()].map(b => b.close()));
        this.bindings.clear();
        this.hostEpoch++;
    }
    async abortActive() {
        for (const [key, b] of [...this.bindings])
            if (b.hasPending || b.isBusy) {
                await b.close();
                this.bindings.delete(key);
            }
    }
    async invalidate() {
        // Preserve outstanding handoffs until their next authoritative result; fingerprinting
        // will force a rebuild. Branch identity is not blindly used to erase a live effect.
        for (const [key, b] of [...this.bindings])
            if (!b.hasPending && !b.isBusy) {
                await b.close();
                this.bindings.delete(key);
            }
    }
    async sweep() {
        if (this.closed)
            return;
        for (const [key, b] of [...this.bindings])
            if (!b.hasPending && !b.isBusy && (b.dead || Date.now() - b.lastUsed > this.config.sessions.idleTtlMs)) {
                await b.close();
                this.bindings.delete(key);
            }
    }
    status() { return { experimental: true, qualifiedVersions: this.config.compatibility.approvedVersions, sessions: [...this.bindings.values()].map(b => b.status()), admission: this.admission.status(), unresolved: this.journal.unresolved(), usage: this.metrics.snapshot() }; }
    closeTask;
    close() { return this.closeTask ??= this.doClose(); }
    async doClose() {
        if (this.closed)
            return;
        this.closed = true;
        this.lifetime.abort();
        clearInterval(this.idleTimer);
        await Promise.allSettled([...this.bindings.values()].map(b => b.close()));
        this.bindings.clear();
        await Promise.allSettled([...this.discoveries].map(s => s.close()));
        this.discoveries.clear();
        await this.accountLoad?.catch(() => { });
        // Keep the journal open until starters and suspended generation owners have drained.
        await Promise.allSettled([...this.inFlight]);
        this.journal.abandonOwned();
        this.credits.endTask();
        this.journal.close();
    }
}
//# sourceMappingURL=runtime.js.map