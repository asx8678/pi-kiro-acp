import type { ModelEntry } from '../types.js';
import { object, type Obj } from '../util.js';

export type ModelMetadata = Pick<ModelEntry, 'description' | 'contextWindow' | 'contextWindowSource'>;

export function tokenCount(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function descriptionContextWindow(description: string): number | undefined {
    // Kiro 2.24 advertises these limits in descriptions, e.g. "1M context window".
    // K/M are decimal token counts. Bytes, output limits and model IDs are not context sizes.
    const amount = '(\\d{1,3}(?:,\\d{3})+|\\d+(?:\\.\\d+)?)\\s*(k|m|thousand|million)?';
    const patterns = [
        new RegExp(`(?<![\\w.,+\\-])${amount}(?:[\\s-]*tokens?)?\\s+context(?:\\s+(?:window|length|size))?\\b`, 'gi'),
        new RegExp(`\\bcontext\\s+(?:window|length|size)\\s*(?:of\\s+|[:=]\\s*)?${amount}(?:[\\s-]*tokens?)?\\b(?![.,]\\d)`, 'gi'),
    ];
    const sizes = new Set<number>();
    for (const pattern of patterns)
        for (const match of description.matchAll(pattern)) {
            const unit = match[2]?.toLowerCase();
            const scale = unit === 'm' || unit === 'million' ? 1_000_000 : unit === 'k' || unit === 'thousand' ? 1_000 : 1;
            const size = tokenCount(Number(match[1]!.replaceAll(',', '')) * scale);
            if (size !== undefined)
                sizes.add(size);
        }
    // An ambiguous description is not evidence for picking the largest limit.
    return sizes.size === 1 ? sizes.values().next().value : undefined;
}

export function modelMetadata(raw: Obj): ModelMetadata {
    const description = typeof raw.description === 'string' ? raw.description : undefined;
    const result: ModelMetadata = description === undefined ? {} : { description };
    const meta = object(raw._meta) ? raw._meta : undefined;
    const kiro = meta && object(meta.kiro) ? meta.kiro : undefined;
    // Prefer a numeric limit if the server supplies one; descriptions are the fallback.
    for (const fields of [kiro, raw, meta]) {
        if (!fields)
            continue;
        for (const key of ['contextWindow', 'context_window', 'contextWindowTokens', 'context_window_tokens']) {
            const size = tokenCount(fields[key]);
            if (size !== undefined)
                return { ...result, contextWindow: size, contextWindowSource: 'metadata' };
        }
    }
    const size = description === undefined ? undefined : descriptionContextWindow(description);
    return size === undefined ? result : { ...result, contextWindow: size, contextWindowSource: 'description' };
}
