import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { TextDecoder } from 'node:util';
import { BridgeError, cancelled, throwIfAborted, asError } from '../errors.js';
import { deferred, object } from '../util.js';
import type { Config } from '../config.js';
export interface RpcFrame {
    jsonrpc: '2.0';
    id?: string | number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}
export class RpcRemoteError extends BridgeError {
    constructor(readonly rpcCode: number, message: string) { super('PROTOCOL', `Kiro RPC ${rpcCode}: ${message}`); }
}
/** Incremental, strict UTF-8 and NDJSON parser. It never treats non-JSON stdout as model text. */
export class Ndjson {
    private decoder = new TextDecoder('utf-8', { fatal: true });
    private buffer = '';
    constructor(private maxBytes: number, private onFrame: (frame: RpcFrame) => void) { }
    push(chunk: Uint8Array): void {
        this.buffer += this.decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, end).replace(/\r$/, '');
            this.buffer = this.buffer.slice(end + 1);
            if (!line.trim())
                continue;
            if (Buffer.byteLength(line) > this.maxBytes)
                throw new BridgeError('LIMIT', 'ACP frame exceeds limit.');
            let data: unknown;
            try {
                data = JSON.parse(line);
            }
            catch {
                throw new BridgeError('PROTOCOL', 'Malformed ACP JSON frame.');
            }
            if (!object(data) || data.jsonrpc !== '2.0')
                throw new BridgeError('PROTOCOL', 'Invalid JSON-RPC envelope.');
            if ('id' in data && typeof data.id !== 'string' && typeof data.id !== 'number')
                throw new BridgeError('PROTOCOL', 'Invalid JSON-RPC request ID.');
            this.onFrame(data as unknown as RpcFrame);
        }
        if (Buffer.byteLength(this.buffer) > this.maxBytes)
            throw new BridgeError('LIMIT', 'Unterminated ACP frame exceeds limit.');
    }
    end(): void { this.buffer += this.decoder.decode(); if (this.buffer.trim())
        throw new BridgeError('PROTOCOL', 'Truncated ACP frame at EOF.'); }
}
interface Pending {
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
    cleanup: () => void;
}
export class RpcProcess {
    private child?: ChildProcessWithoutNullStreams;
    private pending = new Map<string, Pending>();
    private sequence = 0;
    private closed = false;
    private closeResult = deferred<void>();
    private writeTail = Promise.resolve();
    onNotification: (method: string, params: unknown) => void = () => { };
    onRequest: (method: string, params: unknown) => Promise<unknown> = async () => { throw new RpcRemoteError(-32601, 'Client method is not supported.'); };
    onFailure: (e: Error) => void = () => { };
    constructor(private config: Config, readonly cwd: string, private environment: NodeJS.ProcessEnv = process.env) { }
    start(): void {
        if (this.closed)
            throw new BridgeError('TRANSPORT', 'ACP transport has already closed.');
        if (this.child)
            throw new BridgeError('PROTOCOL', 'ACP process already started.');
        const env = { ...this.environment };
        // The official CLI retains its own auth. Remove unrelated inference keys, not Kiro/AWS credentials.
        for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'GEMINI_API_KEY', 'PI_KIRO_CREDIT_TASK_ID', 'PI_KIRO_CREDIT_OWNER_PID'])
            delete env[key];
        this.child = spawn(this.config.cli.binary, [...this.config.cli.prefixArgs, 'acp', '--agent-engine', 'v3', '--auth-method', 'cli'], {
            cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32',
        });
        const parser = new Ndjson(this.config.limits.maxFrameBytes, f => this.receive(f));
        this.child.stdout.on('data', (c: Buffer) => { try {
            parser.push(c);
        }
        catch (e) {
            this.fail(asError(e));
        } });
        this.child.stdout.on('end', () => { if (!this.closed)
            try {
                parser.end();
            }
            catch (e) {
                this.fail(asError(e));
            } });
        // Drain without retaining: stderr may contain user text, credentials, or complete provider payloads.
        this.child.stderr.on('data', () => { });
        this.child.stdin.on('error', e => { if (!this.closed)
            this.fail(e); });
        this.child.on('error', e => this.fail(new BridgeError('TRANSPORT', `Cannot start Kiro CLI: ${e.message}`)));
        this.child.on('close', (code, signal) => {
            if (!this.closed)
                this.fail(new BridgeError('TRANSPORT', `Kiro CLI exited (${code ?? signal ?? 'unknown'}).`));
            this.closeResult.resolve();
        });
    }
    request(method: string, params: unknown, options: {
        signal?: AbortSignal;
        timeoutMs?: number;
    } = {}): Promise<unknown> {
        throwIfAborted(options.signal);
        if (this.closed || !this.child)
            throw new BridgeError('TRANSPORT', 'ACP transport is closed.');
        const id = `pi-${++this.sequence}`, d = deferred<unknown>();
        const ms = options.timeoutMs ?? this.config.cli.rpcTimeoutMs;
        const timer = ms > 0 ? setTimeout(() => finish(new BridgeError('TIMEOUT', `Kiro RPC timed out: ${method}.`)), ms) : undefined;
        const abort = () => finish(cancelled());
        const cleanup = () => { if (timer)
            clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
        const finish = (e: unknown) => { const p = this.pending.get(id); if (p) {
            this.pending.delete(id);
            p.cleanup();
            p.reject(e);
        } };
        this.pending.set(id, { resolve: d.resolve, reject: d.reject, cleanup });
        options.signal?.addEventListener('abort', abort, { once: true });
        void this.send({ jsonrpc: '2.0', id, method, params }).catch(finish);
        return d.promise;
    }
    notify(method: string, params: unknown): Promise<void> { return this.send({ jsonrpc: '2.0', method, params }); }
    private receive(frame: RpcFrame): void {
        if (this.closed)
            return;
        if (frame.method) {
            if (frame.id === undefined) {
                this.onNotification(frame.method, frame.params);
                return;
            }
            const id = frame.id;
            void this.onRequest(frame.method, frame.params).then(result => this.send({ jsonrpc: '2.0', id, result }), e => this.send({ jsonrpc: '2.0', id, error: { code: e instanceof RpcRemoteError ? e.rpcCode : -32603, message: e instanceof RpcRemoteError ? e.message : 'Client refused the request.' } })).catch(e => this.fail(asError(e)));
            return;
        }
        if (frame.id === undefined)
            throw new BridgeError('PROTOCOL', 'Response without an ID.');
        const id = String(frame.id), p = this.pending.get(id);
        if (!p)
            return; // Late reply to a cancelled request.
        this.pending.delete(id);
        p.cleanup();
        if (frame.error)
            p.reject(new RpcRemoteError(frame.error.code, frame.error.message));
        else if (Object.prototype.hasOwnProperty.call(frame, 'result'))
            p.resolve(frame.result);
        else
            p.reject(new BridgeError('PROTOCOL', 'Response contains neither result nor error.'));
    }
    private send(frame: RpcFrame): Promise<void> {
        const line = JSON.stringify(frame) + '\n';
        if (Buffer.byteLength(line) > this.config.limits.maxFrameBytes)
            return Promise.reject(new BridgeError('LIMIT', 'Outgoing ACP frame exceeds limit.'));
        const task = this.writeTail.then(() => new Promise<void>((resolve, reject) => {
            if (this.closed || !this.child?.stdin.writable) {
                reject(new BridgeError('TRANSPORT', 'ACP stdin is closed.'));
                return;
            }
            this.child.stdin.write(line, e => e ? reject(e) : resolve());
        }));
        this.writeTail = task.catch(() => { });
        return task;
    }
    private fail(e: Error): void {
        if (this.closed)
            return;
        this.closed = true;
        for (const p of this.pending.values()) {
            p.cleanup();
            p.reject(e);
        }
        this.pending.clear();
        this.terminate('SIGTERM');
        this.onFailure(e);
    }
    private terminate(signal: NodeJS.Signals): void {
        const pid = this.child?.pid;
        if (!pid)
            return;
        try {
            if (process.platform !== 'win32')
                process.kill(-pid, signal);
            else
                this.child?.kill(signal);
        }
        catch { /* already gone */ }
    }
    private closeTask?: Promise<void>;
    close(): Promise<void> { return this.closeTask ??= this.doClose(); }
    private async doClose(): Promise<void> {
        if (!this.child) {
            this.closed = true;
            return;
        }
        if (!this.closed) {
            this.closed = true;
            for (const p of this.pending.values()) {
                p.cleanup();
                p.reject(cancelled());
            }
            this.pending.clear();
        }
        this.terminate('SIGTERM');
        const timeout = setTimeout(() => this.terminate('SIGKILL'), this.config.cli.cancelGraceMs);
        try {
            await this.closeResult.promise;
        }
        finally {
            clearTimeout(timeout);
        }
    }
    get pid(): number | undefined { return this.child?.pid; }
}
export async function inspectCli(config: Config, signal?: AbortSignal): Promise<{
    version: string;
    help: string;
}> {
    async function run(args: string[]): Promise<string> {
        throwIfAborted(signal);
        return new Promise((resolve, reject) => {
            const child = spawn(config.cli.binary, [...config.cli.prefixArgs, ...args], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
            let out = '', size = 0, failed = false;
            const fail = (e: Error) => { if (failed)
                return; failed = true; child.kill('SIGKILL'); reject(e); };
            const abort = () => fail(cancelled());
            signal?.addEventListener('abort', abort, { once: true });
            const timer = setTimeout(() => fail(new BridgeError('TIMEOUT', 'Kiro CLI inspection timed out.')), config.cli.rpcTimeoutMs);
            child.stdout.on('data', (c: Buffer) => { size += c.length; if (size > 131072)
                fail(new BridgeError('LIMIT', 'CLI inspection output too large.'));
            else
                out += c.toString('utf8'); });
            child.stderr.on('data', () => { });
            child.on('error', e => { clearTimeout(timer); fail(new BridgeError('TRANSPORT', `Kiro CLI is unavailable: ${e.message}`)); });
            child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (failed)
                return; if (code !== 0)
                reject(new BridgeError('COMPATIBILITY', `Kiro ${args.join(' ')} failed (${code}).`));
            else
                resolve(out.trim()); });
        });
    }
    const version = await run(['--version']), help = await run(['acp', '--help']);
    if (!help.includes('--agent-engine') || !help.includes('--auth-method'))
        throw new BridgeError('COMPATIBILITY', 'This CLI does not advertise the required v3 engine and CLI-auth flags.');
    if (!config.compatibility.allowUnverified && !config.compatibility.approvedVersions.includes(version))
        throw new BridgeError('COMPATIBILITY', `Unqualified CLI version: ${version}. Run init --experimental for explicit development opt-in; no live versions ship as qualified.`);
    return { version, help };
}
