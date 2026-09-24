import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Config } from '../config.js';
import { BridgeError, asError } from '../errors.js';
import { object, str, deferred, type Obj } from '../util.js';
import { Catalog, SERVER_NAME } from './catalog.js';
import { SERVER_INFO } from '../kiro/identity.js';
export interface McpResult {
    content: {
        type: 'text';
        text: string;
    }[];
    isError?: boolean;
}
export interface CallContext {
    id: string;
    signal: AbortSignal;
    progressToken?: string | number;
}
export class ToolServer {
    private server?: http.Server;
    private sockets = new Set<import('node:net').Socket>();
    private token = randomBytes(32).toString('hex');
    private endpoint = '';
    private controllers = new Set<AbortController>();
    readonly listed = deferred<void>();
    private listSeen = false;
    onDisconnect: (id: string) => void = () => { };
    constructor(readonly catalog: Catalog, private limits: Config['limits'], private call: (name: string, args: Obj, ctx: CallContext) => Promise<McpResult>) { }
    private starting?: Promise<void>;
    private closing?: Promise<void>;
    private stopped = false;
    start(): Promise<void> {
        if (this.stopped)
            return Promise.reject(new BridgeError('CANCELLED', 'Tool server is closed.'));
        return this.starting ??= this.doStart();
    }
    private async doStart(): Promise<void> {
        this.server = http.createServer((req, res) => { void this.handle(req, res).catch(e => { if (!res.headersSent)
            this.json(res, 500, { error: asError(e).message });
        else
            res.destroy(); }); });
        this.server.maxConnections = 32;
        this.server.requestTimeout = 30000;
        this.server.headersTimeout = 10000;
        // requestTimeout bounds receiving a request; a held tool response has its own deadline.
        this.server.on('connection', s => { this.sockets.add(s); s.on('close', () => this.sockets.delete(s)); });
        await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(0, '127.0.0.1', () => { this.server!.removeListener('error', reject); resolve(); }); });
        const port = (this.server.address() as AddressInfo).port;
        this.endpoint = `http://127.0.0.1:${port}/mcp`;
    }
    descriptor(): Obj { return { type: 'http', name: SERVER_NAME, url: this.endpoint, headers: [{ name: 'Authorization', value: `Bearer ${this.token}` }] }; }
    get url(): string { return this.endpoint; }
    private json(res: http.ServerResponse, status: number, body: unknown): void {
        if (res.destroyed || res.writableEnded)
            return;
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
    }
    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const url = new URL(this.endpoint);
        if (req.headers.host !== url.host || req.url !== '/mcp') {
            this.json(res, 403, { error: 'Invalid host or path' });
            return;
        }
        const origin = req.headers.origin;
        if (origin !== undefined && origin !== url.origin) {
            this.json(res, 403, { error: 'Invalid origin' });
            return;
        }
        const auth = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${this.token}`);
        if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
            this.json(res, 401, { error: 'Unauthorized' });
            return;
        }
        if (req.method === 'GET') {
            res.writeHead(405, { 'allow': 'POST, DELETE' });
            res.end();
            return;
        }
        if (req.method === 'DELETE') {
            res.writeHead(204);
            res.end();
            return;
        }
        if (req.method !== 'POST') {
            res.writeHead(405, { 'allow': 'POST, DELETE' });
            res.end();
            return;
        }
        if (!str(req.headers['content-type']).toLowerCase().includes('application/json')) {
            this.json(res, 415, { error: 'Expected application/json' });
            return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of req) {
            const b = Buffer.from(chunk as Buffer);
            bytes += b.length;
            if (bytes > this.limits.maxFrameBytes) {
                this.json(res, 413, { error: 'Request too large' });
                return;
            }
            chunks.push(b);
        }
        let frame: unknown;
        try {
            frame = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        }
        catch {
            this.json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
            return;
        }
        if (!object(frame) || frame.jsonrpc !== '2.0' || typeof frame.method !== 'string') {
            this.json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
            return;
        }
        const id = frame.id;
        if (id === undefined) {
            res.writeHead(202);
            res.end();
            return;
        }
        if (typeof id !== 'string' && typeof id !== 'number') {
            this.json(res, 400, { error: 'Invalid ID' });
            return;
        }
        const success = (result: unknown) => this.json(res, 200, { jsonrpc: '2.0', id, result });
        const error = (code: number, message: string) => this.json(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
        const params = object(frame.params) ? frame.params : {};
        switch (frame.method) {
            case 'initialize': {
                const requested = str(params.protocolVersion);
                const version = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(requested) ? requested : '2025-03-26';
                success({ protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
                return;
            }
            case 'ping':
                success({});
                return;
            case 'tools/list':
                if (params.cursor !== undefined) {
                    error(-32602, 'This catalog is not paginated.');
                    return;
                }
                this.listSeen = true;
                this.listed.resolve();
                success({ tools: this.catalog.tools });
                return;
            case 'tools/call': {
                if (!this.listSeen) {
                    error(-32600, 'List the current tool catalog before calling a tool.');
                    return;
                }
                if (typeof params.name !== 'string' || !object(params.arguments)) {
                    error(-32602, 'Tool name and object arguments are required.');
                    return;
                }
                try {
                    this.catalog.resolve(params.name);
                }
                catch {
                    error(-32602, 'Unknown tool');
                    return;
                }
                const ctl = new AbortController();
                this.controllers.add(ctl);
                const callId = JSON.stringify(id); // Numeric and string JSON-RPC IDs are distinct.
                const disconnect = () => { if (!res.writableEnded) {
                    ctl.abort();
                    this.onDisconnect(callId);
                } };
                res.on('close', disconnect);
                const timer = setTimeout(() => { ctl.abort(); this.onDisconnect(callId); error(-32000, 'Host tool wait exceeded the configured deadline.'); }, this.limits.maxHandoffMs);
                try {
                    const meta = object(params._meta) ? params._meta : {};
                    const progressToken = typeof meta.progressToken === 'string' || typeof meta.progressToken === 'number' ? meta.progressToken : undefined;
                    const result = await this.call(params.name, params.arguments, { id: callId, signal: ctl.signal, progressToken });
                    success(result);
                }
                catch (e) {
                    success({ content: [{ type: 'text', text: e instanceof BridgeError ? `${e.code}: ${e.message}` : 'Host handoff failed.' }], isError: true });
                }
                finally {
                    clearTimeout(timer);
                    res.removeListener('close', disconnect);
                    this.controllers.delete(ctl);
                }
                return;
            }
            default:
                error(-32601, 'Method not supported');
                return;
        }
    }
    close(): Promise<void> { return this.closing ??= this.doClose(); }
    private async doClose(): Promise<void> {
        this.stopped = true;
        if (this.starting)
            await this.starting.catch(() => { });
        for (const ctl of this.controllers)
            ctl.abort();
        this.controllers.clear();
        for (const socket of this.sockets)
            socket.destroy();
        this.sockets.clear();
        if (this.server)
            await new Promise<void>(resolve => this.server!.close(() => resolve()));
        this.token = '';
    }
}
