export type Phase = 'STOPPED' | 'STARTING' | 'READY' | 'GENERATING' | 'WAITING_FOR_PI_TOOL' | 'SYNCHRONIZING' | 'CANCELLING' | 'CLOSED' | 'RECOVERY_REQUIRED';
export declare class StateMachine {
    phase: Phase;
    move(next: Phase): void;
}
