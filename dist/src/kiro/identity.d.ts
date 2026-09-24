import type { Config } from '../config.js';
export declare const PACKAGE_VERSION: string;
export declare const CREW_IDENTITY: {
    readonly release: "v0.7.0";
    readonly commit: "ba797801739c0a0a94663837feb3c1b761fc0855";
    readonly client: {
        readonly name: "kirocrew";
        readonly version: "0.1.2";
    };
    readonly agent: "kirocrew";
    readonly server: {
        readonly name: "kirocrew-core";
        readonly version: "1.0.0";
    };
};
export declare function clientInfo(name: Config['client']['name']): {
    name: "kirocrew" | "pi-fabric" | "pi";
    version: string;
};
export declare const BRIDGE_MODE: "kirocrew";
export declare const SERVER_NAME: "kirocrew-core";
export declare const SERVER_INFO: {
    readonly name: "kirocrew-core";
    readonly version: "1.0.0";
};
