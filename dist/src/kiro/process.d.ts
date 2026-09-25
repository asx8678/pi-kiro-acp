import type { ChildProcess } from 'node:child_process';
/** Call only for children spawned with detached:true on POSIX. Never signal Pi's group. */
export declare function signalOwnedProcess(child: ChildProcess, signal: NodeJS.Signals): void;
/** A leader closing its pipes does not prove its descendants exited. */
export declare function closeOwnedProcess(child: ChildProcess, closed: Promise<unknown>, graceMs: number): Promise<void>;
