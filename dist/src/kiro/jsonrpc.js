import { spawn } from 'node:child_process';
import { TextDecoder } from 'node:util';
import { BridgeError, cancelled, throwIfAborted, asError } from '../errors.js';
import { deferred, object } from '../util.js';
import { closeOwnedProcess, signalOwnedProcess } from './process.js';
export class RpcRemoteError extends BridgeError {
    rpcCode;
    constructor(rpcCode, message) {
        super('PROTOCOL', `Kiro RPC ${rpcCode}: ${message}`);
        this.rpcCode = rpcCode;
    }
}
/** Incremental, strict UTF-8 and NDJSON parser. It never treats non-JSON stdout as model text. */
export class Ndjson {
    maxBytes;
    onFrame;
    decoder = new TextDecoder('utf-8', { fatal: true });
    buffer = Buffer.alloc(0);
    length = 0;
    firstLine = true;
    constructor(maxBytes, onFrame) {
        this.maxBytes = maxBytes;
        this.onFrame = onFrame;
    }
    append(chunk) {
        const length = this.length + chunk.length;
        // One extra CR is permitted as part of a possibly split CRLF delimiter.
        const last = chunk.length ? chunk[chunk.length - 1] : this.buffer[this.length - 1];
        if (length > this.maxBytes + (last === 13 ? 1 : 0))
            throw new BridgeError('LIMIT', 'ACP frame exceeds limit.');
        if (length > this.buffer.length) {
            // Geometric growth bounds copies to O(frame bytes), even for byte-sized chunks.
            const next = Buffer.allocUnsafe(Math.min(this.maxBytes + 1, Math.max(4096, length, this.buffer.length * 2)));
            this.buffer.copy(next, 0, 0, this.length);
            this.buffer = next;
        }
        this.buffer.set(chunk, this.length);
        this.length = length;
    }
    push(chunk) {
        // Validate each byte exactly once, preserving immediate strict UTF-8 failures.
        this.decoder.decode(chunk, { stream: true });
        let start = 0;
        while (start < chunk.length) {
            const end = chunk.indexOf(10, start);
            this.append(chunk.subarray(start, end < 0 ? chunk.length : end));
            if (end < 0)
                break;
            let line = this.buffer.toString('utf8', 0, this.length);
            const bytes = this.length - (line.endsWith('\r') ? 1 : 0);
            this.length = 0;
            // An unusually large frame must not pin a large buffer in an idle session.
            if (this.buffer.length > 65536)
                this.buffer = Buffer.alloc(0);
            if (this.firstLine) {
                this.firstLine = false;
                if (line.charCodeAt(0) === 0xfeff)
                    line = line.slice(1);
            }
            if (line.endsWith('\r'))
                line = line.slice(0, -1);
            start = end + 1;
            if (!line.trim())
                continue;
            let data;
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
            this.onFrame(data, bytes);
        }
    }
    end() {
        this.decoder.decode();
        if (this.buffer.toString('utf8', 0, this.length).trim())
            throw new BridgeError('PROTOCOL', 'Truncated ACP frame at EOF.');
    }
}
export class RpcProcess {
    config;
    cwd;
    environment;
    child;
    pending = new Map();
    sequence = 0;
    closed = false;
    closeResult = deferred();
    writeTail = Promise.resolve();
    onNotification = () => { };
    onRequest = async () => { throw new RpcRemoteError(-32601, 'Client method is not supported.'); };
    onFailure = () => { };
    constructor(config, cwd, environment = process.env) {
        this.config = config;
        this.cwd = cwd;
        this.environment = environment;
    }
    start() {
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
        const parser = new Ndjson(this.config.limits.maxFrameBytes, (f, bytes) => this.receive(f, bytes));
        this.child.stdout.on('data', (c) => {
            try {
                parser.push(c);
            }
            catch (e) {
                this.fail(asError(e));
            }
        });
        this.child.stdout.on('end', () => {
            if (!this.closed)
                try {
                    parser.end();
                }
                catch (e) {
                    this.fail(asError(e));
                }
        });
        // Drain without retaining: stderr may contain user text, credentials, or complete provider payloads.
        this.child.stderr.on('data', () => { });
        this.child.stdin.on('error', e => {
            if (!this.closed)
                this.fail(e);
        });
        this.child.on('error', e => this.fail(new BridgeError('TRANSPORT', `Cannot start Kiro CLI: ${e.message}`)));
        this.child.on('close', (code, signal) => {
            if (!this.closed)
                this.fail(new BridgeError('TRANSPORT', `Kiro CLI exited (${code ?? signal ?? 'unknown'}).`));
            this.closeResult.resolve();
        });
    }
    request(method, params, options = {}) {
        throwIfAborted(options.signal);
        if (this.closed || !this.child)
            throw new BridgeError('TRANSPORT', 'ACP transport is closed.');
        const id = `pi-${++this.sequence}`, d = deferred();
        const ms = options.timeoutMs ?? this.config.cli.rpcTimeoutMs;
        const timer = ms > 0 ? setTimeout(() => finish(new BridgeError('TIMEOUT', `Kiro RPC timed out: ${method}.`)), ms) : undefined;
        const abort = () => finish(cancelled());
        const cleanup = () => {
            if (timer)
                clearTimeout(timer);
            options.signal?.removeEventListener('abort', abort);
        };
        const finish = (e) => {
            const p = this.pending.get(id);
            if (p) {
                this.pending.delete(id);
                p.cleanup();
                p.reject(e);
            }
        };
        this.pending.set(id, { resolve: d.resolve, reject: d.reject, cleanup });
        options.signal?.addEventListener('abort', abort, { once: true });
        void this.send({ jsonrpc: '2.0', id, method, params }).catch(finish);
        return d.promise;
    }
    notify(method, params) { return this.send({ jsonrpc: '2.0', method, params }); }
    receive(frame, bytes) {
        if (this.closed)
            return;
        if (frame.method) {
            if (frame.id === undefined) {
                this.onNotification(frame.method, frame.params, bytes);
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
    send(frame) {
        const line = JSON.stringify(frame) + '\n';
        if (Buffer.byteLength(line) > this.config.limits.maxFrameBytes)
            return Promise.reject(new BridgeError('LIMIT', 'Outgoing ACP frame exceeds limit.'));
        const task = this.writeTail.then(() => new Promise((resolve, reject) => {
            if (this.closed || !this.child?.stdin.writable) {
                reject(new BridgeError('TRANSPORT', 'ACP stdin is closed.'));
                return;
            }
            this.child.stdin.write(line, e => e ? reject(e) : resolve());
        }));
        this.writeTail = task.catch(() => { });
        return task;
    }
    fail(e) {
        if (this.closed)
            return;
        this.closed = true;
        for (const p of this.pending.values()) {
            p.cleanup();
            p.reject(e);
        }
        this.pending.clear();
        if (this.child)
            signalOwnedProcess(this.child, 'SIGTERM');
        this.onFailure(e);
    }
    closeTask;
    close(graceMs = this.config.cli.cancelGraceMs) { return this.closeTask ??= this.doClose(graceMs); }
    async doClose(graceMs) {
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
        await closeOwnedProcess(this.child, this.closeResult.promise, graceMs);
    }
    get pid() { return this.child?.pid; }
}
export async function inspectCli(config, signal) {
    async function run(args) {
        throwIfAborted(signal);
        const child = spawn(config.cli.binary, [...config.cli.prefixArgs, ...args], {
            stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32',
        });
        const done = deferred(), closed = deferred();
        let out = '', size = 0;
        const abort = () => done.reject(cancelled());
        signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => done.reject(new BridgeError('TIMEOUT', 'Kiro CLI inspection timed out.')), config.cli.rpcTimeoutMs);
        child.stdout.on('data', (chunk) => {
            size += chunk.length;
            if (size > 131072)
                done.reject(new BridgeError('LIMIT', 'CLI inspection output too large.'));
            else
                out += chunk.toString('utf8');
        });
        child.stderr.on('data', () => { });
        child.on('error', error => done.reject(new BridgeError('TRANSPORT', `Kiro CLI is unavailable: ${error.message}`)));
        child.on('close', code => {
            closed.resolve();
            if (code !== 0)
                done.reject(new BridgeError('COMPATIBILITY', `Kiro ${args.join(' ')} failed (${code}).`));
            else
                done.resolve(out.trim());
        });
        try {
            return await done.promise;
        }
        finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            // Also clean surviving descendants after a successful parent exit.
            await closeOwnedProcess(child, closed.promise, config.cli.cancelGraceMs);
        }
    }
    const version = await run(['--version']), help = await run(['acp', '--help']);
    if (!help.includes('--agent-engine') || !help.includes('--auth-method'))
        throw new BridgeError('COMPATIBILITY', 'This CLI does not advertise the required v3 engine and CLI-auth flags.');
    if (!config.compatibility.allowUnverified && !config.compatibility.approvedVersions.includes(version))
        throw new BridgeError('COMPATIBILITY', `Unqualified CLI version: ${version}. Run init --experimental for explicit development opt-in; no live versions ship as qualified.`);
    return { version, help };
}
//# sourceMappingURL=jsonrpc.js.map