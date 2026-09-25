export declare function localDay(at: number, timeZone: string): string;
export declare function localTime(at: number, timeZone: string): string;
export declare function validDay(day: string): boolean;
export declare function validMonth(month: string): boolean;
export declare function shiftMonth(month: string, count: number): string;
export declare function monthDays(month: string): string[];
export declare function dayStart(day: string, timeZone: string): number;
/** Indexed UTC bounds, including zero-width civil days skipped by timezone changes. */
export declare function monthDayRanges(month: string, timeZone: string): {
    day: string;
    start: number;
    end: number;
}[];
export declare function dayRange(day: string, timeZone: string): [number, number];
export declare function monthRange(month: string, timeZone: string): [number, number];
