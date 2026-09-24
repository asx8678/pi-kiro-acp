import { BridgeError } from '../errors.js';
const transitions = {
    STOPPED: ['STARTING', 'CLOSED'], STARTING: ['READY', 'CANCELLING', 'RECOVERY_REQUIRED'],
    READY: ['GENERATING', 'CANCELLING', 'RECOVERY_REQUIRED', 'CLOSED'],
    GENERATING: ['WAITING_FOR_PI_TOOL', 'READY', 'CANCELLING', 'RECOVERY_REQUIRED'],
    WAITING_FOR_PI_TOOL: ['SYNCHRONIZING', 'CANCELLING', 'RECOVERY_REQUIRED'],
    SYNCHRONIZING: ['GENERATING', 'CANCELLING', 'RECOVERY_REQUIRED'],
    CANCELLING: ['CLOSED', 'RECOVERY_REQUIRED'], RECOVERY_REQUIRED: ['CANCELLING', 'CLOSED'], CLOSED: [],
};
export class StateMachine {
    phase = 'STOPPED';
    move(next) {
        if (this.phase === next)
            return;
        if (!transitions[this.phase].includes(next))
            throw new BridgeError('PROTOCOL', `Illegal session transition ${this.phase} -> ${next}.`);
        this.phase = next;
    }
}
//# sourceMappingURL=state-machine.js.map