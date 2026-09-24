// Keep host imports in the entry point so Pi can apply its module aliases.
// A deferred native import inside the compiled factory bypasses those aliases.
import {
    createAssistantMessageEventStream,
    getCurrentSystemPrompt,
    getCurrentTools,
} from '@earendil-works/pi-ai';
import { installExtension } from './dist/src/index.js';
import { Input, matchesKey, truncateToWidth, visibleWidth, stripTerminalSequences } from '@earendil-works/pi-tui';

export default async function extension(pi) {
    await installExtension(pi, {
        createAssistantMessageEventStream,
        getCurrentSystemPrompt,
        getCurrentTools,
    }, { Input, matchesKey, truncateToWidth, visibleWidth, stripTerminalSequences });
}
