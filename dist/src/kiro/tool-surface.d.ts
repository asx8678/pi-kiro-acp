import { Catalog } from '../tools/catalog.js';
import { type Obj } from '../util.js';
export declare class ToolSurfaceAudit {
    private catalog;
    private active;
    private version;
    private snapshot?;
    private tags?;
    private mcpTools?;
    private confirmed;
    constructor(catalog: Catalog);
    activate(version: string): void;
    observe(method: string, params: Obj): void;
    private complete;
    ready(): boolean;
    confirm(): boolean;
    get status(): string;
}
