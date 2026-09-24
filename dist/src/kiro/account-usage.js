import { object } from '../util.js';
import { BridgeError } from '../errors.js';
const amount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const label = (value, fallback) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 160) : fallback;
function allowance(row, fallback, totalField = 'total') {
    const used = amount(row.used), total = amount(row[totalField]);
    if (used === undefined)
        return;
    const limit = row.hasLimit === false ? null : total ?? null;
    return { name: label(row.displayName ?? row.name, fallback), used, total: limit,
        remaining: limit === null ? null : Math.max(0, limit - used),
        ...(typeof row.expiresAt === 'string' ? { expires: label(row.expiresAt, '') } : {}),
    };
}
/** Retains only the billing-display fields returned by the official CLI. */
export function parseAccountUsage(raw, now = Date.now()) {
    if (!object(raw) || raw.success !== true)
        throw new BridgeError('PROTOCOL', object(raw) && typeof raw.message === 'string' ? raw.message : 'Kiro did not return account usage.');
    const data = raw.data;
    if (!object(data))
        return { checkedAt: now, status: 'unavailable', planName: 'Unavailable', bonuses: [], addOns: [], message: label(raw.message, 'Kiro did not expose an allowance for this account.') };
    const breakdowns = Array.isArray(data.usageBreakdowns) ? data.usageBreakdowns.filter(object) : [];
    const credits = breakdowns.filter(row => /^(?:credit|credits)$/i.test(String(row.resourceType)) || /\bcredits?\b/i.test(String(row.displayName)));
    const plan = credits.length === 1 ? allowance(credits[0], 'Credits', 'limit') : undefined;
    const packs = (rows, name) => Array.isArray(rows) ? rows.filter(object).filter(row => row.isActive !== false).flatMap(row => { const item = allowance(row, name); return item ? [item] : []; }).slice(0, 100) : [];
    return {
        checkedAt: now, status: plan ? 'available' : 'unavailable', planName: label(data.planName, 'Unknown plan'),
        ...(typeof data.billingCycleReset === 'string' ? { reset: label(data.billingCycleReset, '') } : {}),
        ...(plan ? { allowance: plan } : { message: 'Kiro did not expose an unambiguous credit allowance.' }),
        bonuses: packs(data.bonusCredits, 'Bonus'), addOns: packs(data.addOnCredits, 'Add-on credits'),
    };
}
//# sourceMappingURL=account-usage.js.map