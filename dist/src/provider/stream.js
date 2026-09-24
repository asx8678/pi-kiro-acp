import { BridgeError, publicError } from '../errors.js';
import { deferred } from '../util.js';
/** Used by tests/CLI. Inside Pi, its own exported stream factory is used instead. */
export class LocalStream {
    limit;
    events = [];
    waiters = [];
    ended = false;
    final = deferred();
    constructor(limit = 8192) {
        this.limit = limit;
    }
    push(event) {
        if (this.ended)
            return;
        if (event.type === 'done' || event.type === 'error') {
            this.ended = true;
            this.final.resolve(event.type === 'done' ? event.message : event.error);
        }
        const w = this.waiters.shift();
        if (w)
            w({ done: false, value: event });
        else {
            if (this.events.length >= this.limit && event.type !== 'done' && event.type !== 'error')
                throw new BridgeError('LIMIT', 'Pi event queue exceeded its configured bound.');
            this.events.push(event);
        }
        if (this.ended)
            this.finishWaiters();
    }
    end(result) {
        this.ended = true;
        if (result)
            this.final.resolve(result);
        this.finishWaiters();
    }
    finishWaiters() {
        for (const w of this.waiters.splice(0))
            w({ done: true, value: undefined });
    }
    async *[Symbol.asyncIterator]() {
        while (true) {
            const e = this.events.shift();
            if (e) {
                yield e;
                continue;
            }
            if (this.ended)
                return;
            const next = await new Promise(resolve => this.waiters.push(resolve));
            if (next.done)
                return;
            yield next.value;
        }
    }
    result() { return this.final.promise; }
}
export class StreamWriter {
    stream;
    maxBytes;
    message;
    done = false;
    started = false;
    current;
    bytes = 0;
    constructor(stream, model, maxBytes) {
        this.stream = stream;
        this.maxBytes = maxBytes;
        this.message = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop',
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    }
    start() {
        if (!this.started) {
            this.started = true;
            this.stream.push({ type: 'start', partial: this.message });
        }
    }
    chunk(type, delta) {
        if (this.done)
            throw new BridgeError('PROTOCOL', 'Model output arrived outside an active Pi generation.');
        this.bytes += Buffer.byteLength(delta);
        if (this.bytes > this.maxBytes)
            throw new BridgeError('LIMIT', 'Visible model output exceeds the bridge byte limit.');
        this.start();
        if (this.current?.type !== type) {
            this.endBlock();
            const index = this.message.content.length;
            this.message.content.push(type === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' });
            this.current = { type, index };
            this.stream.push({ type: type === 'text' ? 'text_start' : 'thinking_start', contentIndex: index, partial: this.message });
        }
        const current = this.current, block = this.message.content[current.index];
        if (block.type === 'text')
            block.text += delta;
        else if (block.type === 'thinking')
            block.thinking += delta;
        this.stream.push({ type: type === 'text' ? 'text_delta' : 'thinking_delta', contentIndex: current.index, delta, partial: this.message });
    }
    endBlock() {
        if (!this.current)
            return;
        const { type, index } = this.current, block = this.message.content[index];
        const content = block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : '';
        this.stream.push({ type: type === 'text' ? 'text_end' : 'thinking_end', contentIndex: index, content, partial: this.message });
        this.current = undefined;
    }
    tool(call) {
        this.start();
        this.endBlock();
        const index = this.message.content.length;
        // Emit an empty initial argument map, then a single valid JSON argument delta.
        const initial = { ...call, arguments: {} };
        this.message.content.push(initial);
        this.stream.push({ type: 'toolcall_start', contentIndex: index, partial: this.message });
        initial.arguments = call.arguments;
        this.stream.push({ type: 'toolcall_delta', contentIndex: index, delta: JSON.stringify(call.arguments), partial: this.message });
        this.stream.push({ type: 'toolcall_end', contentIndex: index, toolCall: initial, partial: this.message });
        this.finish('toolUse');
    }
    finish(reason = 'stop', raw) {
        if (this.done)
            return;
        this.start();
        this.endBlock();
        this.message.stopReason = reason;
        this.message.rawStopReason = raw;
        this.done = true;
        this.stream.push({ type: 'done', reason, message: this.message });
        this.stream.end(this.message);
    }
    fail(error) {
        if (this.done)
            return;
        try {
            this.endBlock();
        }
        catch { /* A full queue must still receive a terminal failure. */ }
        const aborted = error instanceof BridgeError && error.code === 'CANCELLED';
        this.message.stopReason = aborted ? 'aborted' : 'error';
        this.message.errorMessage = publicError(error);
        this.done = true;
        this.stream.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: this.message });
        this.stream.end(this.message);
    }
}
//# sourceMappingURL=stream.js.map