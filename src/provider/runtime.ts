import path from 'node:path';
import type { Config } from '../config.js';
import { privateDir } from '../config.js';
import type { Assistant, Model, PiStream, EffectiveContext, GenerationOptions, Extractors, HostContext, ModelEntry } from '../types.js';
import { BridgeError, cancelled, throwIfAborted, publicError, asError } from '../errors.js';
import { hash, object, uid, deferred, withAbort, type Obj } from '../util.js';
import { snapshot, fallbackExtractors } from '../context/snapshot.js';
import { Journal } from '../storage/journal.js';
import { CreditLedger } from '../storage/credits.js';
import { Admission } from '../admission/leases.js';
import { Binding } from '../sessions/coordinator.js';
import { Metrics } from '../diagnostics/metrics.js';
import { BoundedStream, LocalStream, StreamWriter } from './stream.js';
import { Catalog } from '../tools/catalog.js';
import { V3Session } from '../kiro/v3.js';
import { saveCatalog, withContextWindow } from './models.js';
import type { AccountUsage } from '../kiro/account-usage.js';
import { ensureInstallationId } from '../installation.js';
export class ProviderRuntime {
    readonly journal: Journal;
    readonly admission: Admission;
    readonly metrics: Metrics;
    readonly credits: CreditLedger;
    private bindings = new Map<string, Binding>();
    // The deferred is both the drain and the ownership token; waiters never own cleanup.
    private reservations = new Map<string, ReturnType<typeof deferred<void>>>();
    private host: HostContext = { cwd: process.cwd() };
    private resetting = false;
    private fallbackSession = uid('host_');
    private closed = false;
    private cleanupFailure?: unknown;
    private idleTimer: NodeJS.Timeout;
    private lifetime = new AbortController();
    private inFlight = new Set<Promise<void>>();
    private discoveries = new Set<V3Session>();
    private accountLoad?: Promise<AccountUsage>;
    readonly streamFactory: () => PiStream;
    constructor(readonly config: Config, readonly extractors: Extractors = fallbackExtractors, streamFactory?: () => PiStream) {
        // Local-path Pi installs and installs with scripts disabled reach setup here.
        ensureInstallationId(config);
        this.streamFactory = streamFactory ?? (() => new LocalStream(config.limits.maxQueuedEvents));
        this.journal = new Journal(config.stateDir);
        try {
            this.journal.reconcileDeadOwners();
            this.journal.prune();
            this.credits = new CreditLedger(this.journal, config.admission.scope, config.budget, config.reporting.timeZone, config.reporting.retainTaskExcerpts);
            this.metrics = new Metrics(this.credits, this.config.reporting.accountCacheMs);
            this.admission = new Admission(this.journal, config.admission, () => this.credits.assertAvailable());
            this.idleTimer = setInterval(() => { void this.sweep().catch(error => { this.cleanupFailure ??= error; }); }, Math.min(config.sessions.idleTtlMs, 60000));
            this.idleTimer.unref();
        } catch (error) {
            try { this.journal.close(); } catch { /* Preserve the startup failure. */ }
            throw error;
        }
    }
    setHost(ctx: HostContext): void { this.host = ctx; }
    generate(model: Model, context: EffectiveContext, options: GenerationOptions = {}): PiStream {
        const stream = new BoundedStream(this.streamFactory(), this.config.limits.maxQueuedEvents);
        const signal = options.signal ? AbortSignal.any([options.signal, this.lifetime.signal]) : this.lifetime.signal;
        const task = this.execute(model, context, { ...options, signal }, stream).catch(e => new StreamWriter(stream, model, this.config.limits.maxOutputBytes).fail(e));
        this.inFlight.add(task);
        void task.finally(() => this.inFlight.delete(task));
        return stream;
    }
    /** One declared tool is an output schema, never a host action. Return only after
     * the isolated session, held HTTP response and admission lease have closed. */
    async completeStructured(model: Model, context: EffectiveContext, options: GenerationOptions = {}): Promise<Assistant> {
        const timeoutMs = options.timeoutMs ?? this.config.cli.promptTimeoutMs;
        if (!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) <= 0 || Number(timeoutMs) > 2147483647)
            throw new BridgeError('CONFIG', 'Structured completion timeoutMs must be a positive bounded integer.');
        const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(Number(timeoutMs)), ...(options.signal ? [options.signal] : [])]);
        const stream = new LocalStream(this.config.limits.maxQueuedEvents);
        // A completion caller consumes only the final message; drain intermediate
        // events here so its backing queue stays bounded without dropping output.
        const result = (async () => { for await (const _ of stream) { } return stream.result(); })();
        const task = this.execute(model, context, { ...options, signal }, stream, true);
        this.inFlight.add(task);
        try {
            await task;
            throwIfAborted(signal);
            return await result;
        } catch (error) {
            new StreamWriter(stream, model, this.config.limits.maxOutputBytes).fail(error);
            await result;
            // A cleanup failure must override an internally completed tool message.
            throw error;
        } finally { this.inFlight.delete(task); }
    }
    private async execute(model: Model, context: EffectiveContext, options: GenerationOptions, stream: PiStream, structuredOutput = false): Promise<void> {
        if (this.closed)
            throw new BridgeError('TRANSPORT', 'Provider runtime is closed.');
        if (this.resetting)
            throw new BridgeError('BUSY', 'A provider reset is in progress. Retry after it finishes.');
        if (model.provider !== 'kiro-acp')
            throw new BridgeError('POLICY', 'This provider serves only Kiro-backed models.');
        if (options.temperature !== undefined)
            throw new BridgeError('UNSUPPORTED', 'Temperature cannot be enforced through this Kiro ACP profile.');
        if (options.toolChoice !== undefined && !['none', 'auto'].includes(options.toolChoice))
            throw new BridgeError('UNSUPPORTED', 'Unsupported tool selection policy.');
        if (options.env && Object.keys(options.env).length)
            throw new BridgeError('UNSUPPORTED', 'Per-request environment overrides are not supported; configure the trusted Kiro CLI environment before starting Pi.');
        throwIfAborted(options.signal);
        // Capture request ownership before asynchronous hooks or startup can let
        // another host task/session replace the mutable foreground context.
        const logicalId = options.sessionId || this.host.sessionManager?.getSessionId?.() || this.fallbackSession;
        const cwd = this.host.cwd;
        const taskId = this.credits.ensureTask({ sessionId: logicalId, sessionName: this.host.sessionManager?.getSessionName?.(), summary: 'Provider or auxiliary request' });
        let effective = context;
        if (options.onPayload) {
            const payload = { transport: 'kiro-acp-v3', modelId: model.id, context };
            const replacement = await withAbort(Promise.resolve(options.onPayload(payload, model)), options.signal);
            if (replacement !== undefined) {
                if (!object(replacement) || replacement.transport !== 'kiro-acp-v3' || replacement.modelId !== model.id || !object(replacement.context) || !Array.isArray(replacement.context.messages))
                    throw new BridgeError('POLICY', 'onPayload returned an invalid or re-routed ACP payload.');
                effective = replacement.context as unknown as EffectiveContext;
            }
        }
        throwIfAborted(options.signal);
        if (this.closed)
            throw cancelled();
        const snap = snapshot(effective, this.extractors, options.toolChoice === 'none', this.config.limits.maxPromptBytes);
        if (structuredOutput && snap.tools.length !== 1)
            throw new BridgeError('UNSUPPORTED', 'Structured completion requires exactly one output tool schema.');
        const auxiliary = structuredOutput || options.toolChoice === 'none' || snap.tools.length === 0;
        // Preserve the original epoch-zero encoding for on-disk compatibility. A fresh
        // Binding.generation, not a new recovery identity, distinguishes rebuilt sessions.
        const key = hash({ scope: this.config.admission.scope, session: logicalId, epoch: 0, cwd, purpose: auxiliary ? uid('aux_') : 'agent' });
        while (true) {
            throwIfAborted(options.signal);
            if (this.closed)
                throw cancelled();
            if (this.resetting)
                throw new BridgeError('BUSY', 'A provider reset is in progress.');
            const owner = this.reservations.get(key);
            if (!owner)
                break;
            if (!this.bindings.get(key)?.streamFinished)
                throw new BridgeError('BUSY', 'Two concurrent generations targeted the same Pi conversation.');
            await withAbort(owner.promise, options.signal);
        }
        const drain = deferred<void>();
        this.reservations.set(key, drain);
        let binding = this.bindings.get(key);
        let releaseBinding: (() => void) | undefined;
        try {
            releaseBinding = this.journal.reserveBinding(key);
            // Recover only from an actual result supplied by Pi. A dead process's HTTP callback is never restored.
            for (const row of this.journal.recoveryCandidates(key)) {
                if (binding && row.generation === binding.generation)
                    continue;
                if (this.journal.ownerLive(row.owner_instance, row.owner_pid) && row.owner_instance !== this.journal.instance)
                    throw new BridgeError('BUSY', 'Another live process owns this Pi conversation handoff.');
                const matches = snap.messages.filter(m => m.role === 'toolResult' && m.toolCallId === row.pi_call_id);
                const result = matches[0];
                if (matches.length !== 1 || result?.toolName !== row.tool_name || (row.result_hash && row.result_hash !== hash(result)))
                    throw new BridgeError('UNCERTAIN', `Unresolved or ambiguous prior tool ${row.pi_call_id}; inspect Pi and run journal/reconcile before retrying. Legacy records may belong to a pre-upgrade reset.`);
                if (row.phase === 'RECEIVED')
                    this.journal.transition(row.id, 'CANCELLED');
                else {
                    this.journal.transition(row.id, 'RESULT_RECORDED', hash(result));
                    this.journal.transition(row.id, 'CANCELLED');
                }
            }
            if (binding?.hasPending)
                binding.acceptResult(snap);
            // A budget veto prevents more inference, not recording an action Pi has
            // already completed. Admission checks again before releasing any result.
            this.credits.assertAvailable();
            if (binding?.needsRebuild(snap, model, typeof options.reasoning === 'string' ? options.reasoning : undefined)) {
                await this.evict(key, binding);
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
                binding = new Binding(key, model, typeof options.reasoning === 'string' ? options.reasoning : undefined, snap, this.config, this.journal, this.admission, this.metrics, structuredOutput ? snap.tools[0]!.name : undefined);
                this.bindings.set(key, binding);
                await binding.start(options.signal);
            }
            await binding.run(snap, stream, options, taskId);
        }
        catch (e) {
            if (binding) {
                await this.evict(key, binding);
            }
            throw e;
        }
        finally {
            try {
                if (auxiliary && binding)
                    await this.evict(key, binding);
            } finally {
                try { releaseBinding?.(); }
                finally {
                    if (this.reservations.get(key) === drain)
                        this.reservations.delete(key);
                    drain.resolve();
                }
            }
        }
    }
    async discover(signal?: AbortSignal): Promise<{
        models: ModelEntry[];
        version: string;
        toolAudit: string;
    }> {
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
    refreshAccountUsage(force = false): Promise<AccountUsage> {
        if (this.closed) return Promise.reject(cancelled());
        if (this.accountLoad) return this.accountLoad;
        const cached = this.credits.accountUsage();
        if (process.env.PI_OFFLINE === '1' || process.argv.includes('--offline'))
            return Promise.resolve(cached ?? { checkedAt: Date.now(), status: 'unavailable', planName: 'Unavailable offline', bonuses: [], addOns: [], message: 'Account refresh is disabled in offline mode.' });
        if (!force && cached && Date.now() - Math.max(cached.checkedAt, cached.failedAt ?? 0) < this.config.reporting.accountCacheMs)
            return Promise.resolve(cached);
        this.accountLoad = this.loadAccountUsage(cached).finally(() => { this.accountLoad = undefined; });
        return this.accountLoad;
    }
    private async loadAccountUsage(cached?: AccountUsage): Promise<AccountUsage> {
        let owned: V3Session | undefined;
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
            if (this.closed) throw cancelled();
            const message = publicError(error).slice(0, 300);
            const usage: AccountUsage = cached ? { ...cached, lastError: message, failedAt: Date.now() } : {
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
    async reset(): Promise<void> {
        if (this.closed)
            throw cancelled();
        if (this.journal.unresolved().length || [...this.bindings.values()].some(b => b.hasPending))
            throw new BridgeError('UNCERTAIN', 'Reset refuses pending effects. Cancel, inspect the Pi transcript, then reconcile the journal.');
        if (this.resetting || this.inFlight.size || this.reservations.size)
            throw new BridgeError('BUSY', 'Reset requires an idle provider. Cancel or wait for active requests first.');
        // Set synchronously before the first await: no starter may race with eviction.
        this.resetting = true;
        try {
            await Promise.all([...this.bindings].map(([key, binding]) => this.evict(key, binding)));
        }
        finally {
            this.resetting = false;
        }
    }
    private async evict(key: string, binding: Binding): Promise<void> {
        try { await binding.close(); }
        finally {
            if (this.bindings.get(key) === binding) this.bindings.delete(key);
        }
    }
    async abortActive(): Promise<void> {
        const results = await Promise.allSettled([...this.bindings]
            .filter(([, binding]) => binding.hasPending || binding.isBusy)
            .map(([key, binding]) => this.evict(key, binding)));
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (errors.length) throw new AggregateError(errors, errors.map(publicError).join('; '));
    }
    async invalidate(): Promise<void> {
        // Preserve outstanding handoffs until their next authoritative result; fingerprinting
        // will force a rebuild. Branch identity is not blindly used to erase a live effect.
        for (const [key, b] of [...this.bindings])
            if (!b.hasPending && !b.isBusy) {
                await this.evict(key, b);
            }
    }
    private async sweep(): Promise<void> {
        if (this.closed)
            return;
        for (const [key, b] of [...this.bindings])
            if (!b.hasPending && !b.isBusy && (b.dead || Date.now() - b.lastUsed > this.config.sessions.idleTtlMs)) {
                await this.evict(key, b);
            }
    }
    status(): Obj { return { cleanupError: this.cleanupFailure ? publicError(this.cleanupFailure) : undefined, experimental: true, qualifiedVersions: this.config.compatibility.approvedVersions, sessions: [...this.bindings.values()].map(b => b.status()), admission: this.admission.status(), unresolved: this.journal.unresolved(), usage: this.metrics.snapshot() }; }
    private closeTask?: Promise<void>;
    close(): Promise<void> { return this.closeTask ??= this.doClose(); }
    private async doClose(): Promise<void> {
        if (this.closed)
            return;
        this.closed = true;
        this.lifetime.abort();
        clearInterval(this.idleTimer);
        const errors: unknown[] = this.cleanupFailure ? [this.cleanupFailure] : [];
        const collect = (results: PromiseSettledResult<unknown>[]) => {
            for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
        };
        collect(await Promise.allSettled([...this.bindings.values()].map(b => b.close())));
        this.bindings.clear();
        collect(await Promise.allSettled([...this.discoveries].map(s => s.close())));
        this.discoveries.clear();
        await this.accountLoad?.catch(() => {});
        // Keep the journal open until starters and suspended generation owners have drained.
        collect(await Promise.allSettled([...this.inFlight]));
        for (const finish of [() => this.journal.abandonOwned(), () => this.credits.close(), () => this.journal.close()])
            try { finish(); } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, errors.map(error => asError(error).message).join('; '));
    }
}
