import { loadConfig } from './config.js';
import { ProviderRuntime } from './provider/runtime.js';
import { readCatalog, toModel } from './provider/models.js';
import { object, withAbort } from './util.js';
import { BridgeError, publicError } from './errors.js';
import { fabricGuardStatus } from './policy/fabric.js';
import { openUsageDashboard } from './ui/usage-dashboard.js';
import { tokenText } from './ui/token-usage.js';
const efficiencyGuidance = `Execution efficiency: use fabric_exec code mode for tools. For unfamiliar large codebases, use extensions.fovea_sketch/fovea_focus when available, then read the relevant symbols or line ranges. Batch independent calls and return compact computed findings, not entire files or raw result arrays. Avoid redundant reads and automatic extra planning turns. Delegate only when the task benefits enough to justify another model context; workers default to Kiro Auto. Never claim a tool result was seen if it was truncated.`;
/** Dependency injection is for contract tests, not an alternate model service. */
export async function installExtension(pi, ai, tui) {
    if (typeof pi.registerProvider !== 'function' || typeof ai.createAssistantMessageEventStream !== 'function' || typeof ai.getCurrentSystemPrompt !== 'function' || typeof ai.getCurrentTools !== 'function')
        throw new BridgeError('COMPATIBILITY', 'This extension requires current Pi native-provider and normalized-transcript helpers.');
    const config = loadConfig();
    const extractors = { system: ai.getCurrentSystemPrompt, tools: ai.getCurrentTools };
    const runtime = new ProviderRuntime(config, extractors, () => ai.createAssistantMessageEventStream());
    let models = readCatalog(config).map(m => toModel(m, config));
    let warned = false;
    let catalogLoad;
    let catalogLoading = false;
    const loadCatalog = (force = false) => {
        if (!catalogLoad || (force && !catalogLoading)) {
            catalogLoading = true;
            // One load per extension lifetime, shared by startup and picker requests.
            // The runtime owns cancellation; closing a picker must not restart discovery.
            // Retain failures too, until an explicit /kiro models or doctor retry.
            catalogLoad = runtime.discover().finally(() => { catalogLoading = false; });
        }
        return catalogLoad;
    };
    const refresh = async () => { const result = await loadCatalog(true); models = result.models.map(m => toModel(m, config)); return result; };
    const checkFabric = () => {
        if (!config.policy.kiroOnly)
            return;
        const status = fabricGuardStatus();
        if (!status.ready)
            throw new BridgeError('COMPATIBILITY', status.reason);
    };
    const stream = (model, context, options) => { checkFabric(); return runtime.generate(model, context, options); };
    const provider = { id: 'kiro-acp', name: 'Kiro CLI v3 (experimental)', baseUrl: 'kiro-cli://local',
        auth: { apiKey: { name: 'Official Kiro CLI authentication',
                login: async () => { throw new BridgeError('AUTH', 'Sign in with kiro-cli login outside Pi. The bridge never imports tokens.'); },
                // A marker delegates auth to the CLI; it is not an assertion that the account is signed in.
                check: async () => ({ type: 'api_key', source: 'Kiro CLI-owned authentication (checked on use)' }),
                resolve: async () => ({ auth: { apiKey: 'cli-owned-not-a-service-token' }, source: 'Kiro CLI' }),
            } },
        getModels: () => models,
        refreshModels: async (ctx) => {
            if (!ctx.allowNetwork || ctx.signal.aborted)
                return;
            const result = await withAbort(loadCatalog(), ctx.signal);
            const next = result.models.map(m => toModel(m, config));
            await ctx.publish({ update: () => { models = next; } });
        }, stream, streamSimple: stream, };
    pi.registerProvider(provider);
    let creditsUI;
    let usageSessionId = runtime.journal.instance;
    let shownWidget;
    const creditWarnings = new Set();
    const showCredits = () => {
        if (!creditsUI || runtime.journal.closed)
            return;
        const status = runtime.metrics.creditStatus();
        const tokens = runtime.credits.tokenUsage(usageSessionId);
        if (creditsUI.setWidget && tokens.lastPrompt) {
            const lines = [status, `Last prompt tokens: ${tokenText(tokens.lastPrompt)}`, `Session tokens: ${tokenText(tokens.session)}`];
            const key = lines.join('\n');
            creditsUI.setStatus?.('kiro-credits', undefined);
            if (shownWidget !== key) {
                creditsUI.setWidget('kiro-usage', lines, { placement: 'belowEditor' });
                shownWidget = key;
            }
        }
        else {
            if (shownWidget !== undefined)
                creditsUI.setWidget?.('kiro-usage', undefined);
            shownWidget = undefined;
            creditsUI.setStatus?.('kiro-credits', status);
        }
        const usage = runtime.credits.snapshot();
        const key = `${usage.day}:${usage.warningCredits}`;
        if (usage.warning && !creditWarnings.has(key)) {
            creditWarnings.add(key);
            creditsUI.notify(`Kiro has reported ${usage.reportedCredits?.toFixed(4)} credits today, above the ${usage.warningCredits}-credit warning threshold. ${usage.dailyLimit === null ? 'No spending cutoff is enabled.' : 'An explicit daily cutoff is configured.'} Task reports: ${usage.logFile}`, 'warning');
        }
    };
    // Reads the shared ledger only; no catalog refresh or inference for worker totals.
    const creditTimer = setInterval(showCredits, 5000);
    creditTimer.unref();
    runtime.metrics.onCredits = showCredits;
    function bind(ctx) {
        runtime.setHost(ctx);
        creditsUI = ctx.ui;
        usageSessionId = ctx.sessionManager?.getSessionId?.() || runtime.journal.instance;
        showCredits();
    }
    function guard(ctx) {
        bind(ctx);
        try {
            checkFabric();
        }
        catch (e) {
            void ctx.abort?.();
            throw e;
        }
        if (config.policy.kiroOnly && ctx.model && ctx.model.provider !== 'kiro-acp') {
            void ctx.abort?.();
            throw new BridgeError('POLICY', 'Kiro-only profile: select a kiro-acp model. Other trusted plugins still require environment-level egress policy.');
        }
    }
    pi.on('session_start', (_e, ctx) => {
        bind(ctx);
        if (ctx.mode === 'tui' && !process.env.PI_FABRIC_DEPTH)
            void runtime.refreshAccountUsage().catch(() => { });
        if (!warned) {
            warned = true;
            ctx.ui?.notify('pi-kiro-acp is experimental. Kiro usage/cost may be unknown; Pi numeric zero fields are not free inference. Run /kiro doctor before use.', 'warning');
        }
    });
    pi.on('before_agent_start', (event, ctx) => {
        guard(ctx);
        runtime.credits.beginTask({
            sessionId: ctx.sessionManager?.getSessionId?.() || runtime.journal.instance,
            sessionName: ctx.sessionManager?.getSessionName?.(),
            summary: typeof event.prompt === 'string' ? event.prompt : 'Agent task',
        });
        if (config.efficiency.enabled && fabricGuardStatus().installed && typeof event.systemPrompt === 'string')
            return { systemPrompt: `${event.systemPrompt}\n\n${efficiencyGuidance}` };
        return;
    });
    pi.on('tool_call', (event) => {
        if (event.toolName !== 'fabric_exec')
            return;
        try {
            checkFabric();
        }
        catch (e) {
            return { block: true, reason: publicError(e) };
        }
        return;
    });
    pi.on('context_with_system', (_e, ctx) => guard(ctx));
    pi.on('before_provider_request', (_e, ctx) => guard(ctx));
    pi.on('model_select', (event, ctx) => {
        bind(ctx);
        if (config.policy.kiroOnly && object(event.model) && event.model.provider !== 'kiro-acp') {
            void ctx.abort?.();
            ctx.ui?.notify('Kiro-only profile: this model is not approved for inference. Select kiro-acp.', 'error');
        }
    });
    pi.on('agent_end', (event) => {
        if (!Array.isArray(event.messages))
            return;
        const last = event.messages.findLast(message => object(message) && message.role === 'assistant');
        if (object(last) && Array.isArray(last.content)) {
            const text = last.content.filter(block => object(block) && block.type === 'text' && typeof block.text === 'string').map(block => block.text).join(' ');
            runtime.credits.noteResult(text);
        }
    });
    pi.on('agent_before_settle', (event) => {
        if (typeof event.outcome === 'string')
            runtime.credits.noteResult('', event.outcome);
    });
    // agent_settled is stronger than agent_end: retries/queued continuations are finished.
    pi.on('agent_settled', async () => {
        await runtime.abortActive();
        runtime.credits.endTask();
        showCredits();
        if (!process.env.PI_FABRIC_DEPTH)
            void runtime.refreshAccountUsage().catch(() => { });
    });
    pi.on('session_compact', async () => { await runtime.invalidate(); });
    pi.on('session_tree', async () => { await runtime.invalidate(); });
    pi.on('session_shutdown', async () => {
        clearInterval(creditTimer);
        runtime.metrics.onCredits = undefined;
        creditsUI?.setStatus?.('kiro-credits', undefined);
        creditsUI?.setWidget?.('kiro-usage', undefined);
        await runtime.close();
    });
    pi.registerCommand('kiro', { description: 'Kiro bridge doctor, models, status, usage, reset and cancel', handler: async (args, ctx) => {
            bind(ctx);
            const action = args.trim() || 'status';
            try {
                let result;
                switch (action) {
                    case 'doctor':
                        result = { ...(await refresh()), experimental: config.compatibility.allowUnverified, usage: 'unknown unless Kiro reports it', paidPromptSent: false };
                        pi.registerProvider(provider);
                        break;
                    case 'models':
                        result = (await refresh()).models;
                        pi.registerProvider(provider);
                        break;
                    case 'usage':
                        result = { ...runtime.metrics.snapshot(), tokens: runtime.credits.tokenUsage(usageSessionId) };
                        break;
                    case 'status':
                        result = runtime.status();
                        break;
                    case 'reset':
                        await runtime.reset();
                        result = { reset: true };
                        break;
                    case 'cancel':
                        await ctx.abort?.();
                        await runtime.abortActive();
                        result = { cancelled: true, notice: 'Inspect unresolved handoffs before retrying.' };
                        break;
                    default: throw new BridgeError('CONFIG', 'Usage: /kiro doctor|models|status|usage|reset|cancel');
                }
                ctx.ui?.notify(JSON.stringify(result, null, 2), 'info');
            }
            catch (e) {
                ctx.ui?.notify(publicError(e), 'error');
            }
        } });
    pi.registerCommand('usage', { description: 'Kiro credit dashboard: /usage [YYYY-MM | YYYY-MM-DD | refresh]', handler: async (args, ctx) => {
            bind(ctx);
            try {
                await openUsageDashboard(args, ctx, runtime.credits, force => runtime.refreshAccountUsage(force), tui);
            }
            catch (error) {
                ctx.ui?.notify(publicError(error), 'error');
            }
        } });
    return runtime;
}
export default async function extension(pi) {
    // Dynamic import resolves through Pi's host package mapping; never bundle another Pi runtime.
    const moduleName = '@earendil-works/pi-ai';
    const ai = await import(moduleName);
    await installExtension(pi, ai);
}
//# sourceMappingURL=index.js.map