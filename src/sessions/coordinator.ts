import type { Config } from '../config.js';
import type { Model, GenerationOptions, PiStream } from '../types.js';
import type { Snapshot } from '../context/snapshot.js';
import { appendInput, replay, projectMessage, hashPrefixLength } from '../context/snapshot.js';
import { V3Session } from '../kiro/v3.js';
import { Catalog } from '../tools/catalog.js';
import { ToolServer, type McpResult, type CallContext } from '../tools/mcp-server.js';
import { Journal, type HandoffRow } from '../storage/journal.js';
import { Admission, type Lease } from '../admission/leases.js';
import { Metrics } from '../diagnostics/metrics.js';
import { StreamWriter } from '../provider/stream.js';
import { StateMachine } from './state-machine.js';
import { BridgeError, asError, cancelled, throwIfAborted } from '../errors.js';
import { deferred, hash, uid, withAbort, type Obj, object, list } from '../util.js';
import { privateDir } from '../config.js';
import path from 'node:path';
interface PendingTool {
    row: HandoffRow;
    requestId: string;
    response: ReturnType<typeof deferred<McpResult>>;
    result?: McpResult;
    resultMessage?: Obj;
}
export class Binding {
    readonly generation = uid('gen_');
    readonly machine = new StateMachine();
    readonly catalog: Catalog;
    readonly bridge: ToolServer;
    readonly kiro: V3Session;
    private pending?: PendingTool;
    private writer?: StreamWriter;
    private current?: Snapshot;
    private expected: Obj[] = [];
    private expectedHashes: string[] = [];
    private complete = deferred<void>();
    private lease?: Lease;
    private abortCleanup?: () => void;
    private rootAbort = new AbortController();
    private closing = false;
    private fatal?: Error;
    private recentResults = new Map<string, McpResult>();
    private busy = false;
    private compactionDirty = false;
    private observer?: GenerationOptions['onProviderStreamEvent'];
    private promptTask?: string;
    lastUsed = Date.now();
    constructor(readonly key: string, readonly model: Model, readonly effort: string | undefined, readonly first: Snapshot, private config: Config, private journal: Journal, private admission: Admission, private metrics: Metrics) {
        this.catalog = new Catalog(first.tools);
        this.bridge = new ToolServer(this.catalog, config.limits, (name, args, ctx) => this.receiveTool(name, args, ctx));
        const cwd = path.join(config.stateDir, 'workspaces', key.slice(0, 24));
        privateDir(cwd);
        this.kiro = new V3Session(config, cwd, this.catalog, async (event) => { await this.observer?.(event, model); });
        this.kiro.onEvent = async (event) => {
            // Cancellation can deliver final accounting while the binding is closing.
            if (event.kind === 'prompt_start') {
                if (!this.promptTask)
                    throw new BridgeError('STORAGE', 'Prompt is missing immutable task attribution.');
                metrics.startPrompt(event.promptId, model.id, event.startedAt, this.promptTask);
                return;
            }
            if (event.kind === 'prompt_end') {
                metrics.finishPrompt(event.promptId);
                return;
            }
            if (event.kind === 'credits') {
                metrics.observeCredits(event.report);
                return;
            }
            if (event.kind === 'tokens') {
                metrics.observeTokens(event.report);
                return;
            }
            if (this.closing)
                return;
            if (event.kind === 'usage') {
                metrics.observe(event.data);
                return;
            }
            if (event.kind === 'context_usage') {
                // Tool-less summaries have their own context, not the user's conversation.
                if (this.catalog.tools.length)
                    metrics.observeContext(this.generation, model.id, event.percent);
                return;
            }
            if (event.kind === 'compaction') {
                this.compactionDirty = true;
                if (this.machine.phase === 'GENERATING')
                    this.fail(new BridgeError('CONTEXT', 'Kiro compacted during a Pi generation; explicit resynchronization is required.'));
                return;
            }
            if (!this.writer || this.writer.done) {
                this.fail(new BridgeError('PROTOCOL', 'Kiro emitted model output while Pi owned the continuation boundary.'));
                return;
            }
            this.writer.chunk(event.kind, event.text);
        };
        this.kiro.onFailure = e => this.fail(e);
        this.bridge.onDisconnect = id => {
            if (!this.closing && this.pending?.requestId === id)
                this.fail(new BridgeError('UNCERTAIN', 'Kiro disconnected from a held Pi tool call. The effect may have occurred; inspect the journal and Pi transcript.'));
        };
    }
    async start(signal?: AbortSignal): Promise<void> {
        signal = signal ? AbortSignal.any([signal, this.rootAbort.signal]) : this.rootAbort.signal;
        if (this.closing)
            throw cancelled();
        this.machine.move('STARTING');
        try {
            throwIfAborted(signal);
            await this.bridge.start();
            throwIfAborted(signal);
            await this.kiro.start(this.first.system, this.catalog.tools.length ? this.bridge.descriptor() : undefined, signal);
            await this.kiro.select(this.model.id, this.effort, signal);
            if (this.catalog.tools.length) {
                const timer = AbortSignal.timeout(this.config.cli.rpcTimeoutMs);
                await withAbort(this.bridge.listed.promise, signal ? AbortSignal.any([signal, timer]) : timer);
            }
            await this.kiro.verifyTools(signal);
            this.machine.move('READY');
        }
        catch (e) {
            // Teardown can mark the session disposed before a readiness waiter wakes.
            // Preserve an intentional abort, without disguising actual startup failures.
            const failure = this.fatal ?? (signal.aborted ? cancelled() : e);
            await this.close();
            throw failure;
        }
    }
    private remember(snap: Snapshot, tail?: Obj): void {
        this.expected = tail ? [...snap.messages, tail] : snap.messages;
        this.expectedHashes = tail ? [...snap.hashes, hash(tail)] : snap.hashes;
    }
    needsRebuild(snap: Snapshot, model: Model, effort: string | undefined): boolean {
        if (this.fatal || this.compactionDirty || this.closing || this.config.sessions.forceRebuild)
            return true;
        if (this.first.systemHash !== snap.systemHash || this.first.toolsHash !== snap.toolsHash || this.model.id !== model.id || this.effort !== effort)
            return true;
        if (hashPrefixLength(this.expectedHashes, snap.hashes) !== this.expected.length)
            return true;
        if (this.pending) {
            const extra = snap.messages.slice(this.expected.length).filter(m => !(m.role === 'toolResult' && m.toolCallId === this.pending!.row.pi_call_id));
            if (extra.length && !this.config.compatibility.orderedSteeringVersions.includes(this.kiro.version))
                return true;
        }
        return false;
    }
    /** Authoritative result is accepted only from the next effective Pi transcript. */
    acceptResult(snap: Snapshot): void {
        if (!this.pending)
            return;
        const row = this.journal.get(this.pending.row.id)!;
        const matches = snap.messages.filter(m => m.role === 'toolResult' && m.toolCallId === row.pi_call_id);
        if (matches.length !== 1 || matches[0]!.toolName !== row.tool_name)
            throw new BridgeError('UNCERTAIN', `Missing or ambiguous authoritative Pi result for ${row.pi_call_id}. Reconcile before continuing.`);
        const resultMessage = matches[0]!, content = list(resultMessage.content).map(b => {
            if (!object(b) || b.type !== 'text' || typeof b.text !== 'string')
                throw new BridgeError('UNSUPPORTED', 'Only text tool results are supported.');
            return { type: 'text' as const, text: b.text };
        });
        const result: McpResult = { content, isError: resultMessage.isError === true };
        if (Buffer.byteLength(JSON.stringify(result)) > this.config.limits.maxToolResultBytes)
            throw new BridgeError('LIMIT', 'Pi tool result exceeds bridge byte ceiling. The action is not repeated.');
        const digest = hash(resultMessage);
        if (row.result_hash && row.result_hash !== digest)
            throw new BridgeError('UNCERTAIN', 'A previously recorded Pi tool result was rewritten.');
        if (row.phase === 'EXPOSED_TO_PI' || row.phase === 'UNCERTAIN')
            this.journal.transition(row.id, 'RESULT_RECORDED', digest);
        if (this.closing && this.journal.get(row.id)?.phase === 'RESULT_RECORDED')
            this.journal.transition(row.id, 'CANCELLED'); // The old transport has already been retired.
        this.pending.result = result;
        this.pending.resultMessage = resultMessage;
    }
    async run(snap: Snapshot, stream: PiStream, options: GenerationOptions, taskId: string): Promise<void> {
        if (this.busy)
            throw new BridgeError('BUSY', 'Concurrent Pi requests attempted to share one Kiro session.');
        if (this.fatal)
            throw this.fatal;
        if (this.closing)
            throw new BridgeError('TRANSPORT', 'Session is closing.');
        throwIfAborted(options.signal);
        this.busy = true;
        this.lastUsed = Date.now();
        this.current = snap;
        this.writer = new StreamWriter(stream, this.model, this.config.limits.maxOutputBytes);
        this.writer.message.providerThinkingLevel = this.effort;
        this.complete = deferred<void>();
        this.observer = options.onProviderStreamEvent;
        this.abortCleanup?.();
        const abort = () => { this.metrics.cancellations++; this.fail(cancelled()); };
        options.signal?.addEventListener('abort', abort, { once: true });
        this.abortCleanup = () => options.signal?.removeEventListener('abort', abort);
        this.metrics.generations++;
        try {
            this.lease = await this.admission.acquire(this.rootAbort.signal);
            throwIfAborted(options.signal);
            if (this.pending) {
                this.machine.move('SYNCHRONIZING');
                if (!this.pending.result)
                    throw new BridgeError('PROTOCOL', 'Result synchronization must precede continuation.');
                const pending = this.pending;
                const extra = snap.messages.slice(this.expected.length).filter(m => !(m.role === 'toolResult' && m.toolCallId === pending.row.pi_call_id));
                if (extra.length)
                    await this.kiro.steer(appendInput(extra));
                this.remember(snap);
                this.machine.move('GENERATING');
                this.journal.transition(pending.row.id, 'RETURNED_TO_KIRO');
                this.recentResults.set(pending.row.id, pending.result!);
                if (this.recentResults.size > 4)
                    this.recentResults.delete(this.recentResults.keys().next().value!);
                this.pending = undefined;
                pending.response.resolve(pending.result!);
            }
            else {
                const input = this.expected.length === 0 ? replay(snap.messages) : appendInput(snap.messages.slice(this.expected.length));
                if (this.expected.length > 0 && snap.messages.length === this.expected.length)
                    throw new BridgeError('CONTEXT', 'No new Pi context to generate from; refusing an implicit duplicate prompt.');
                this.machine.move('GENERATING');
                this.remember(snap);
                this.promptTask = taskId;
                // Completion can throw while emitting the final text/thinking end event.
                void this.kiro.prompt(input)
                    .then(reason => this.endPrompt(reason))
                    .catch(e => this.fail(asError(e)));
            }
            await this.complete.promise;
        }
        catch (e) {
            this.fail(asError(e));
            await this.close().catch(() => {}); // The terminal stream preserves the primary and cleanup errors.
        }
        finally {
            this.busy = false;
            this.lastUsed = Date.now();
            // Do not cancel the Kiro prompt when this Pi stream ends at toolUse.
            if (!this.pending) {
                this.abortCleanup?.();
                this.abortCleanup = undefined;
            }
            this.writer = undefined;
            this.observer = undefined;
        }
    }
    private endPrompt(reason: string): void {
        if (this.closing || this.fatal)
            return;
        if (this.pending) {
            this.fail(new BridgeError('UNCERTAIN', 'Kiro ended its prompt with a Pi tool call still outstanding.'));
            return;
        }
        if (!this.writer) {
            this.fail(new BridgeError('PROTOCOL', 'ACP prompt ended without an owning Pi stream.'));
            return;
        }
        if (reason === 'cancelled') {
            this.fail(cancelled());
            return;
        }
        if (!['end_turn', 'max_tokens', 'max_turn_requests'].includes(reason)) {
            this.fail(new BridgeError('PROTOCOL', `Unsupported Kiro stop reason: ${reason}.`));
            return;
        }
        this.writer.finish(reason === 'end_turn' ? 'stop' : 'length', reason);
        this.remember(this.current!, projectMessage(this.writer.message));
        this.machine.move('READY');
        this.release();
        this.complete.resolve();
    }
    private async receiveTool(alias: string, args: Obj, ctx: CallContext): Promise<McpResult> {
        if (this.closing || this.fatal)
            throw this.fatal ?? cancelled();
        const tool = this.catalog.resolve(alias);
        if (this.pending && this.pending.requestId !== ctx.id)
            throw new BridgeError('BUSY', 'Only one Pi handoff may be outstanding; request other actions after its result.');
        const received = this.journal.receive({ binding: this.key, generation: this.generation, requestId: ctx.id, toolName: tool.name, argsHash: hash(args) });
        if (received.duplicate) {
            if (this.pending?.row.id === received.row.id)
                return this.pending.response.promise;
            const prior = this.recentResults.get(received.row.id);
            if (prior)
                return prior;
            throw new BridgeError('UNCERTAIN', 'Old handoff ID cannot be replayed.');
        }
        if (this.machine.phase !== 'GENERATING' || !this.writer || this.writer.done) {
            this.journal.transition(received.row.id, 'CANCELLED');
            throw new BridgeError('POLICY', 'No Pi generation authorizes a tool request.');
        }
        // Reserve before yielding: retransmitted IDs share one handoff and concurrent new IDs cannot both dispatch.
        const pending: PendingTool = { row: received.row, requestId: ctx.id, response: deferred<McpResult>() };
        this.pending = pending;
        try {
            await this.kiro.flushEvents();
            throwIfAborted(ctx.signal);
            if (this.closing || this.fatal)
                throw this.fatal ?? cancelled();
            this.journal.transition(received.row.id, 'EXPOSED_TO_PI');
            this.machine.move('WAITING_FOR_PI_TOOL');
            this.release();
            this.metrics.toolCalls++;
            this.writer.tool({ type: 'toolCall', id: received.row.pi_call_id, name: tool.name, arguments: JSON.parse(JSON.stringify(args)) as Obj });
            this.remember(this.current!, projectMessage(this.writer.message));
            this.complete.resolve();
        }
        catch (e) {
            this.fail(asError(e));
            throw e;
        }
        return pending.response.promise;
    }
    private release(): void { this.lease?.release(); this.lease = undefined; }
    private fail(e: Error): void {
        if (this.fatal || this.closing) return;
        this.fatal = e;
        this.metrics.failures++;
        // No SQLite work here: failure callbacks must never throw before teardown.
        // close() reports cleanup failures on the stream and to explicit callers.
        void this.close().catch(() => {});
    }
    private closeTask?: Promise<void>;
    close(): Promise<void> { return this.closeTask ??= this.doClose(); }
    private async doClose(): Promise<void> {
        if (this.closing) return;
        this.closing = true;
        const errors: Error[] = [];
        const attempt = (fn: () => void) => { try { fn(); } catch (error) { errors.push(asError(error)); } };
        this.rootAbort.abort();
        attempt(() => this.abortCleanup?.());
        attempt(() => {
            if (this.machine.phase !== 'CLOSED' && this.machine.phase !== 'STOPPED') this.machine.move('CANCELLING');
        });
        // Process termination must precede fallible/possibly blocking bookkeeping.
        try { await this.kiro.close(); } catch (error) { errors.push(asError(error)); }
        attempt(() => this.release());
        attempt(() => {
            if (this.pending) {
                const row = this.journal.get(this.pending.row.id);
                if (row?.phase === 'EXPOSED_TO_PI') this.journal.transition(row.id, 'UNCERTAIN');
                else if (row?.phase === 'RECEIVED' || row?.phase === 'RESULT_RECORDED') this.journal.transition(row.id, 'CANCELLED');
            }
        });
        this.pending?.response.reject(this.fatal ?? cancelled());
        try { await this.bridge.close(); } catch (error) { errors.push(asError(error)); }
        attempt(() => this.machine.move('CLOSED'));
        attempt(() => this.metrics.clearContext(this.generation));
        let terminal: Error = this.fatal ?? cancelled();
        if (errors.length) {
            const message = `${terminal.message}; cleanup failed: ${errors.map(error => error.message).join('; ')}`;
            terminal = terminal instanceof BridgeError ? new BridgeError(terminal.code, message, { cause: terminal }) : new Error(message, { cause: terminal });
        }
        try { attempt(() => this.writer?.fail(terminal)); }
        finally { this.complete.resolve(); }
        if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('; '));
    }
    get hasPending(): boolean { return this.pending !== undefined; }
    // Startup owns live transports and must be cancelled, never swept as idle.
    get isBusy(): boolean { return this.busy || this.machine.phase === 'STARTING'; }
    get streamFinished(): boolean { return this.writer?.done === true; }
    get dead(): boolean { return this.closing || !!this.fatal; }
    status(): Obj { return { binding: this.key, generation: this.generation, phase: this.machine.phase, model: this.model.id, kiroSession: this.kiro.sessionId, selected: this.kiro.selected(), toolAudit: this.kiro.toolAudit, pending: this.pending ? { id: this.pending.row.id, piToolCallId: this.pending.row.pi_call_id, phase: this.journal.get(this.pending.row.id)?.phase } : null, lastUsed: this.lastUsed }; }
}
