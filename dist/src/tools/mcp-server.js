import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { BridgeError, asError } from '../errors.js';
import { object, str, deferred } from '../util.js';
import { SERVER_NAME } from './catalog.js';
import { SERVER_INFO } from '../kiro/identity.js';
export class ToolServer {
    catalog;
    limits;
    call;
    server;
    sockets = new Set();
    token = randomBytes(32).toString('hex');
    endpoint = '';
    controllers = new Set();
    listed = deferred();
    listSeen = false;
    onDisconnect = () => { };
    constructor(catalog, limits, call) {
        this.catalog = catalog;
        this.limits = limits;
        this.call = call;
    }
    starting;
    closing;
    stopped = false;
    start() {
        if (this.stopped)
            return Promise.reject(new BridgeError('CANCELLED', 'Tool server is closed.'));
        return this.starting ??= this.doStart();
    }
    async doStart() {
        this.server = http.createServer((req, res) => {
            void this.handle(req, res).catch(e => {
                if (!res.headersSent)
                    this.json(res, 500, { error: asError(e).message });
                else
                    res.destroy();
            });
        });
        this.server.maxConnections = 32;
        this.server.requestTimeout = 30000;
        this.server.headersTimeout = 10000;
        // requestTimeout bounds receiving a request; a held tool response has its own deadline.
        this.server.on('connection', s => { this.sockets.add(s); s.on('close', () => this.sockets.delete(s)); });
        await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', () => { this.server.removeListener('error', reject); resolve(); }); });
        const port = this.server.address().port;
        this.endpoint = `http://127.0.0.1:${port}/mcp`;
    }
    descriptor() { return { type: 'http', name: SERVER_NAME, url: this.endpoint, headers: [{ name: 'Authorization', value: `Bearer ${this.token}` }] }; }
    get url() { return this.endpoint; }
    json(res, status, body) {
        if (res.destroyed || res.writableEnded)
            return;
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
    }
    async handle(req, res) {
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
        const chunks = [];
        let bytes = 0;
        for await (const chunk of req) {
            const b = Buffer.from(chunk);
            bytes += b.length;
            if (bytes > this.limits.maxFrameBytes) {
                this.json(res, 413, { error: 'Request too large' });
                return;
            }
            chunks.push(b);
        }
        let frame;
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
        const success = (result) => this.json(res, 200, { jsonrpc: '2.0', id, result });
        const error = (code, message) => this.json(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
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
                const disconnect = () => {
                    if (!res.writableEnded) {
                        ctl.abort();
                        this.onDisconnect(callId);
                    }
                };
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
    close() { return this.closing ??= this.doClose(); }
    async doClose() {
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
            await new Promise(resolve => this.server.close(() => resolve()));
        this.token = '';
    }
}
//# sourceMappingURL=mcp-server.js.map