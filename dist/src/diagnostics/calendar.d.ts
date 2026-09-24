export declare function localDay(at: number, timeZone: string): string;
export declare function localTime(at: number, timeZone: string): string;
export declare function validDay(day: string): boolean;
export declare function validMonth(month: string): boolean;
export declare function shiftMonth(month: string, count: number): string;
export declare function monthDays(month: string): string[];
/** Locate the beginning of a civil day; DST days need not be 24 hours long. */
export declare function dayStart(day: string, timeZone: string): number;
export declare function dayRange(day: string, timeZone: string): [number, number];
export declare function monthRange(month: string, timeZone: string): [number, number];
