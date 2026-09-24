import { hash, type Obj } from '../util.js';
import type { Tool } from '../types.js';
import { BridgeError } from '../errors.js';
export { SERVER_NAME } from '../kiro/identity.js';
import { SERVER_NAME } from '../kiro/identity.js';
export interface CatalogTool {
    name: string;
    description: string;
    inputSchema: Obj;
}
export class Catalog {
    readonly aliases = new Map<string, Tool>();
    readonly nativeNames = new Set<string>();
    readonly tools: CatalogTool[];
    constructor(input: Tool[]) {
        this.tools = input.map(tool => {
            let name = /^[A-Za-z0-9_-]{1,56}$/.test(tool.name) ? tool.name : `p_${hash(tool.name).slice(0, 32)}`;
            if (this.aliases.has(name))
                name = `p_${hash([tool.name, tool.parameters]).slice(0, 48)}`;
            if (this.aliases.has(name))
                throw new BridgeError('PROTOCOL', 'Tool alias collision.');
            this.aliases.set(name, tool);
            this.nativeNames.add(tool.name);
            return { name, description: tool.description, inputSchema: tool.parameters };
        });
    }
    resolve(name: string): Tool {
        const tool = this.aliases.get(name);
        if (!tool)
            throw new BridgeError('POLICY', 'Kiro requested a tool not present in the active Pi catalog.');
        return tool;
    }
    isExpectedWireName(name: string): boolean {
        if (this.aliases.has(name))
            return true;
        for (const alias of this.aliases.keys())
            if ([`${SERVER_NAME}/${alias}`, `@${SERVER_NAME}/${alias}`, `mcp__${SERVER_NAME}__${alias}`].includes(name))
                return true;
        return false;
    }
}
