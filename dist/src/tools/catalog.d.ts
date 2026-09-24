import { type Obj } from '../util.js';
import type { Tool } from '../types.js';
export { SERVER_NAME } from '../kiro/identity.js';
export interface CatalogTool {
    name: string;
    description: string;
    inputSchema: Obj;
}
export declare class Catalog {
    readonly aliases: Map<string, Tool>;
    readonly nativeNames: Set<string>;
    readonly tools: CatalogTool[];
    constructor(input: Tool[]);
    resolve(name: string): Tool;
    isExpectedWireName(name: string): boolean;
}
