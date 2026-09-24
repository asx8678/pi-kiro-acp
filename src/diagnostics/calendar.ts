import { BridgeError } from '../errors.js';

const formats = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
    let format = formats.get(timeZone);
    if (!format) {
        format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
        formats.set(timeZone, format);
    }
    return format;
}
function parts(at: number, timeZone: string): Record<string, string> {
    return Object.fromEntries(formatter(timeZone).formatToParts(at).map(part => [part.type, part.value]));
}
export function localDay(at: number, timeZone: string): string {
    const p = parts(at, timeZone);
    return `${p.year}-${p.month}-${p.day}`;
}
export function localTime(at: number, timeZone: string): string {
    const p = parts(at, timeZone);
    return `${p.hour}:${p.minute}`;
}
export function validDay(day: string): boolean {
    if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(day)) return false;
    const date = new Date(`${day}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}
export function validMonth(month: string): boolean { return /^\d{4}-\d{2}$/.test(month) && validDay(`${month}-01`); }
export function shiftMonth(month: string, count: number): string {
    if (!validMonth(month)) throw new BridgeError('CONFIG', 'Use a valid month: YYYY-MM.');
    const date = new Date(`${month}-01T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + count);
    const result = date.toISOString().slice(0, 7);
    if (!validMonth(result)) throw new BridgeError('CONFIG', 'Month is outside the supported calendar.');
    return result;
}
export function monthDays(month: string): string[] {
    if (!validMonth(month)) throw new BridgeError('CONFIG', 'Use a valid month: YYYY-MM.');
    const date = new Date(`${month}-01T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + 1, 0);
    return Array.from({ length: date.getUTCDate() }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`);
}
/** Locate the beginning of a civil day; DST days need not be 24 hours long. */
export function dayStart(day: string, timeZone: string): number {
    if (!validDay(day)) throw new BridgeError('CONFIG', 'Use a valid date: YYYY-MM-DD.');
    const noon = Date.parse(`${day}T12:00:00Z`);
    let low = noon - 48 * 3600000, high = noon + 48 * 3600000;
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (localDay(mid, timeZone) < day) low = mid + 1;
        else high = mid;
    }
    if (localDay(low, timeZone) !== day) throw new BridgeError('CONFIG', `Date ${day} does not exist in ${timeZone}.`);
    return low;
}
const ranges = new Map<string, [number, number]>();
export function dayRange(day: string, timeZone: string): [number, number] {
    const key = `${timeZone}:${day}`;
    const cached = ranges.get(key);
    if (cached) return cached;
    const date = new Date(`${day}T00:00:00Z`);
    if (!validDay(day)) throw new BridgeError('CONFIG', 'Use a valid date: YYYY-MM-DD.');
    date.setUTCDate(date.getUTCDate() + 1);
    const value: [number, number] = [dayStart(day, timeZone), dayStart(date.toISOString().slice(0, 10), timeZone)];
    if (ranges.size >= 100) ranges.clear();
    ranges.set(key, value);
    return value;
}
export function monthRange(month: string, timeZone: string): [number, number] {
    if (!validMonth(month)) throw new BridgeError('CONFIG', 'Use a valid month: YYYY-MM.');
    return [dayRange(`${month}-01`, timeZone)[0], dayRange(`${shiftMonth(month, 1)}-01`, timeZone)[0]];
}
