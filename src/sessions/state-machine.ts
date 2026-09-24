import { BridgeError } from '../errors.js';
export type Phase = 'STOPPED' | 'STARTING' | 'READY' | 'GENERATING' | 'WAITING_FOR_PI_TOOL' | 'SYNCHRONIZING' | 'CANCELLING' | 'CLOSED' | 'RECOVERY_REQUIRED';
const transitions: Record<Phase, Phase[]> = {
    STOPPED: ['STARTING', 'CLOSED'], STARTING: ['READY', 'CANCELLING', 'RECOVERY_REQUIRED'],
    READY: ['GENERATING', 'CANCELLING', 'RECOVERY_REQUIRED', 'CLOSED'],
    GENERATING: ['WAITING_FOR_PI_TOOL', 'READY', 'CANCELLING', 'RECOVERY_REQUIRED'],
    WAITING_FOR_PI_TOOL: ['SYNCHRONIZING', 'CANCELLING', 'RECOVERY_REQUIRED'],
    SYNCHRONIZING: ['GENERATING', 'CANCELLING', 'RECOVERY_REQUIRED'],
    CANCELLING: ['CLOSED', 'RECOVERY_REQUIRED'], RECOVERY_REQUIRED: ['CANCELLING', 'CLOSED'], CLOSED: [],
};
export class StateMachine {
    phase: Phase = 'STOPPED';
    move(next: Phase): void {
        if (this.phase === next)
            return;
        if (!transitions[this.phase].includes(next))
            throw new BridgeError('PROTOCOL', `Illegal session transition ${this.phase} -> ${next}.`);
        this.phase = next;
    }
}
