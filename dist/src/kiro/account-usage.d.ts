export interface CreditAllowance {
    name: string;
    used: number;
    total: number | null;
    remaining: number | null;
    expires?: string;
}
export interface AccountUsage {
    checkedAt: number;
    status: 'available' | 'unavailable';
    planName: string;
    reset?: string;
    allowance?: CreditAllowance;
    bonuses: CreditAllowance[];
    addOns: CreditAllowance[];
    message?: string;
    lastError?: string;
    failedAt?: number;
}
/** Retains only the billing-display fields returned by the official CLI. */
export declare function parseAccountUsage(raw: unknown, now?: number): AccountUsage;
