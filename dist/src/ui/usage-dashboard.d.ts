import type { HostContext } from '../types.js';
import type { CreditLedger, UsageTotals } from '../storage/credits.js';
import type { AccountUsage } from '../kiro/account-usage.js';
export interface UsagePanel {
    render(width: number): string[];
    invalidate(): void;
    handleInput?(data: string): void;
    dispose?(): void;
    focused?: boolean;
}
export interface UsageTerminal {
    terminal: {
        rows: number;
    };
    requestRender(): void;
}
export interface UsageTheme {
    fg(color: string, text: string): string;
    bold(text: string): string;
}
interface UsageInput extends UsagePanel {
    onSubmit?: (value: string) => void;
    onEscape?: () => void;
    setValue?(value: string): void;
    handleInput(data: string): void;
}
export interface UsageUiPort {
    Input: new (options?: {
        prompt?: string;
        placeholder?: string;
    }) => UsageInput;
    matchesKey(data: string, key: string): boolean;
    truncateToWidth(text: string, width: number, ellipsis?: string): string;
    visibleWidth(text: string): number;
    stripTerminalSequences(text: string): string;
}
export type UsageDashboard = ReturnType<CreditLedger['dashboard']>;
export declare const creditNumber: (value: number) => string;
export declare function totalText(totals: UsageTotals): string;
export declare function dashboardText(data: UsageDashboard): string;
export declare function openUsageDashboard(args: string, ctx: HostContext, ledger: CreditLedger, refresh: (force?: boolean) => Promise<AccountUsage>, ui?: UsageUiPort, accountCacheMs?: number): Promise<void>;
export {};
