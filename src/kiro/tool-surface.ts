import { BridgeError } from '../errors.js';
import { Catalog, SERVER_NAME } from '../tools/catalog.js';
import { object, str, type Obj } from '../util.js';

// This wire shape was observed with the official v3 relay. Do not infer support
// for other versions from MCP readiness or from a tag with an unknown source.
const TAG_CATALOG_VERSIONS = new Set(['kiro-cli 2.24.0']);

export class ToolSurfaceAudit {
    private active = false;
    private version = '';
    private snapshot?: string[];
    private tags?: string[];
    private mcpTools?: string[];
    private confirmed = false;

    constructor(private catalog: Catalog) { }

    activate(version: string): void {
        this.version = version;
        this.active = true;
        this.snapshot = undefined;
        this.tags = undefined;
        this.confirmed = false;
    }

    observe(method: string, params: Obj): void {
        if (method === '_kiro/tools/didChange' && this.active) {
            // Each report replaces the previous surface, even if its wire format changes.
            this.snapshot = undefined;
            this.tags = undefined;
            if ('tools' in params) {
                if (!Array.isArray(params.tools))
                    throw new BridgeError('PROTOCOL', 'Malformed effective tool snapshot.');
                const names = params.tools.map(t => typeof t === 'string' ? t : object(t) ? str(t.name, str(t.id)) : '');
                if (names.some(name => !name) || new Set(names).size !== names.length)
                    throw new BridgeError('PROTOCOL', 'Unrecognized effective tool snapshot.');
                for (const name of names)
                    if (!this.catalog.isExpectedWireName(name))
                        throw new BridgeError('POLICY', `Unexpected tool in Kiro effective surface: ${name}.`);
                this.snapshot = names;
            }
            else if (TAG_CATALOG_VERSIONS.has(this.version)) {
                if (!Array.isArray(params.tags))
                    throw new BridgeError('PROTOCOL', 'Missing Kiro tool tag snapshot.');
                const names: string[] = [];
                for (const tag of params.tags) {
                    if (!object(tag) || typeof tag.tag !== 'string' || typeof tag.source !== 'string')
                        throw new BridgeError('PROTOCOL', 'Malformed Kiro tool tag.');
                    if (tag.source !== 'mcp' || !tag.tag.startsWith(`@${SERVER_NAME}/`))
                        throw new BridgeError('POLICY', `Unexpected tool group in Kiro effective surface: ${tag.tag}.`);
                    const name = tag.tag.slice(SERVER_NAME.length + 2);
                    if (!this.catalog.aliases.has(name))
                        throw new BridgeError('POLICY', `Unexpected tool in Kiro effective surface: ${tag.tag}.`);
                    names.push(name);
                }
                if (new Set(names).size !== names.length)
                    throw new BridgeError('PROTOCOL', 'Duplicate Kiro tool tags.');
                this.tags = names;
            }
        }
        if (method === '_kiro/mcp/status') {
            if (!Array.isArray(params.servers))
                throw new BridgeError('PROTOCOL', 'Malformed MCP server inventory.');
            const servers = params.servers.filter(s => object(s) && s.name === SERVER_NAME);
            if (servers.length > 1)
                throw new BridgeError('PROTOCOL', 'Ambiguous Pi MCP server inventory.');
            this.mcpTools = undefined; // Every notification is a full snapshot.
            const server = servers[0];
            if (object(server)) {
                if (['failed', 'error'].includes(str(server.status)))
                    throw new BridgeError('COMPATIBILITY', 'Kiro could not initialize the internal Pi MCP endpoint.');
                if (server.failedAuthorization === true)
                    throw new BridgeError('POLICY', 'Kiro did not authorize the internal Pi MCP endpoint.');
                const kiro = object(server._meta) && object(server._meta.kiro) ? server._meta.kiro : {};
                const origin = object(kiro.resource) && object(kiro.resource.source) ? kiro.resource.source.origin : undefined;
                if (server.status === 'connected' && origin === 'client' && Array.isArray(server.tools)) {
                    const names: string[] = [];
                    const seen = new Set<string>();
                    for (const tool of server.tools) {
                        if (!object(tool) || typeof tool.name !== 'string' || typeof tool.disabled !== 'boolean')
                            throw new BridgeError('PROTOCOL', 'Malformed Pi MCP tool catalog.');
                        if (!this.catalog.aliases.has(tool.name))
                            throw new BridgeError('POLICY', `Unexpected Pi MCP tool: ${tool.name}.`);
                        if (seen.has(tool.name))
                            throw new BridgeError('PROTOCOL', 'Duplicate Pi MCP tool catalog entries.');
                        seen.add(tool.name);
                        if (!tool.disabled)
                            names.push(tool.name);
                    }
                    this.mcpTools = names;
                }
            }
            if (this.mcpTools === undefined)
                this.tags = undefined;
        }
        if (this.confirmed && !this.ready())
            throw new BridgeError('COMPATIBILITY', 'Kiro tool inventory changed after verification; restart the bridge session.');
    }

    private complete(names: string[]): boolean {
        return names.length === this.catalog.aliases.size && [...this.catalog.aliases.keys()].every(name => names.includes(name));
    }

    ready(): boolean {
        if (!this.active)
            return false;
        if (this.snapshot !== undefined) {
            for (const alias of this.catalog.aliases.keys())
                if (!this.snapshot.some(name => [alias, `${SERVER_NAME}/${alias}`, `@${SERVER_NAME}/${alias}`, `mcp__${SERVER_NAME}__${alias}`].includes(name)))
                    return false;
            return true;
        }
        if (!TAG_CATALOG_VERSIONS.has(this.version) || this.tags === undefined)
            return false;
        if (this.catalog.aliases.size === 0)
            return this.tags.length === 0;
        return this.complete(this.tags) && this.mcpTools !== undefined && this.complete(this.mcpTools);
    }

    confirm(): boolean {
        if (!this.ready()) {
            if (this.snapshot !== undefined)
                throw new BridgeError('COMPATIBILITY', 'Effective Kiro tool inventory is missing an active Pi tool.');
            return false;
        }
        this.confirmed = true;
        return true;
    }

    get status(): string {
        if (!this.ready())
            return 'unreported';
        return this.snapshot === undefined ? 'reported-tags-and-catalog' : 'reported-exact';
    }
}
