import type { HostContext } from '../types.js';
import type { CreditLedger, UsageTotals, SessionUsage } from '../storage/credits.js';
import type { AccountUsage } from '../kiro/account-usage.js';
import { localTime, shiftMonth, validDay, validMonth } from '../diagnostics/calendar.js';
import { publicError } from '../errors.js';
import { stripVTControlCharacters } from 'node:util';
import { tokenText } from './token-usage.js';
import type { TokenTotals } from '../kiro/tokens.js';
import { hash } from '../util.js';

export interface UsagePanel {
    render(width: number): string[];
    invalidate(): void;
    handleInput?(data: string): void;
    dispose?(): void;
    focused?: boolean;
}
export interface UsageTerminal { terminal: { rows: number }; requestRender(): void }
export interface UsageTheme { fg(color: string, text: string): string; bold(text: string): string }
interface UsageInput extends UsagePanel {
    onSubmit?: (value: string) => void;
    onEscape?: () => void;
    setValue?(value: string): void;
    handleInput(data: string): void;
}
export interface UsageUiPort {
    Input: new (options?: { prompt?: string; placeholder?: string }) => UsageInput;
    matchesKey(data: string, key: string): boolean;
    truncateToWidth(text: string, width: number, ellipsis?: string): string;
    visibleWidth(text: string): number;
    stripTerminalSequences(text: string): string;
}
export type UsageDashboard = ReturnType<CreditLedger['dashboard']>;
const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
const dayFormats = [false, true].map(weekday => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...(weekday ? { weekday: 'short' as const } : {}), day: 'numeric', month: 'short' }));
const monthFormats = [false, true].map(short => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: short ? 'short' : 'long', year: 'numeric' }));
export const creditNumber = (value: number): string => value > 0 && value < 0.0001 ? '<0.0001' : numberFormat.format(value);
export function totalText(totals: UsageTotals): string {
    if (totals.credits === null) return totals.prompts ? `${totals.unreported} ${totals.unreported === 1 ? 'request' : 'requests'} awaiting credit report` : 'no records';
    return `${creditNumber(totals.credits)} credits` + (totals.unreported ? ` (${totals.unreported} awaiting credit report)` : '');
}
function dateLabel(day: string, weekday = false): string {
    return dayFormats[Number(weekday)]!.format(new Date(`${day}T12:00:00Z`));
}
function monthLabel(month: string, short = false): string {
    return monthFormats[Number(short)]!.format(new Date(`${month}-01T12:00:00Z`));
}
function compactTotal(totals: UsageTotals): string {
    if (totals.credits === null) return totals.prompts ? 'Pending' : '—';
    return creditNumber(totals.credits) + (totals.unreported ? ' + ?' : '');
}
function shortId(kind: string, id: string): string { return hash([kind, id]).slice(0, 8); }
function sessionTitle(session: SessionUsage): string {
    const name = session.name === `Session ${session.id.slice(0, 12)}` || session.name === 'Unnamed session' ? session.summary : session.name;
    return `${shortId('session', session.id)} · ${name === 'Provider request' ? 'Session' : name}`;
}
function accountFreshness(account: AccountUsage, cacheMs: number): { text: string; stale: boolean } {
    const age = Math.max(0, Date.now() - account.checkedAt), seconds = Math.floor(age / 1000);
    const elapsed = seconds < 60 ? 'just now' : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago`
        : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ago` : `${Math.floor(seconds / 86400)}d ago`;
    const stale = Boolean(account.lastError) || age >= cacheMs;
    return { text: `${stale ? 'STALE · ' : ''}Updated ${elapsed}`, stale };
}
function requests(count: number): string { return `${count} ${count === 1 ? 'request' : 'requests'}`; }
function plainExcerpt(text: string): string {
    return text.replace(/(^|\s)#{1,6}\s+/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1');
}
interface ActivityRow {
    id: string; label: string; startedAt: number; time?: string; totals: UsageTotals; detail: string; note?: string;
    tokenRef?: { kind: 'session' | 'task' | 'prompt'; id: string };
}
interface PreparedRow extends ActivityRow { credits: string; creditWidth: number; search: string }
interface ViewState { selection: string; session?: string; query: string; sortIndex: number; selectedId?: string; cursor: number }
const sorts = [
    { field: 'date', direction: 1, label: 'date ↑' }, { field: 'date', direction: -1, label: 'date ↓' },
    { field: 'credits', direction: -1, label: 'credits ↓' }, { field: 'credits', direction: 1, label: 'credits ↑' },
] as const;
function accountLines(data: UsageDashboard): string[] {
    const account = data.account, plan = account?.allowance;
    if (!account) return ['Plan balance: not fetched yet'];
    const lines = [`${account.planName} · checked ${new Date(account.checkedAt).toLocaleString('en-GB', { timeZone: data.timeZone })}`];
    if (plan) {
        lines.push(plan.total !== null && plan.remaining !== null
            ? `Plan remaining: ${creditNumber(plan.remaining)} / ${creditNumber(plan.total)} credits  ·  Used: ${creditNumber(plan.used)}`
            : `Plan used: ${creditNumber(plan.used)} credits  ·  Allowance not exposed by Kiro`);
    } else lines.push(account.message || 'Plan balance unavailable');
    if (account.reset) lines.push(`Plan resets: ${account.reset}`);
    for (const pack of [...account.bonuses, ...account.addOns])
        lines.push(`${pack.name}: ${pack.remaining === null ? '?' : creditNumber(pack.remaining)} / ${pack.total === null ? '?' : creditNumber(pack.total)} remaining${pack.expires ? `; expires ${pack.expires}` : ''}`);
    if (account.lastError) lines.push(`Refresh unavailable${plan ? '; showing last account data' : ''}. ${account.lastError}`);
    return lines;
}
export function dashboardText(data: UsageDashboard): string {
    const lines = [
        'Kiro usage', ...accountLines(data), '', `Recorded activity (${data.timeZone})`,
        `Today: ${totalText(data.todayUsage)}`,
        `This month (${data.currentMonth}): ${totalText(data.currentMonthUsage)}`,
        `Previous month (${data.previousMonth}): ${totalText(data.previousMonthUsage)}`,
        `All recorded activity: ${totalText(data.allTime)}`,
        `History since: ${data.recordedSince ?? 'no recorded tasks yet'}. Earlier/external activity is not included in this breakdown.`, '',
        `${data.selected}: ${totalText(data.selectedUsage)}`,
    ];
    if (validDay(data.selected)) {
        for (const session of data.sessions)
            lines.push(`${localTime(session.startedAt, data.timeZone)}  ${sessionTitle(session)}  ${totalText(session)}  (${session.tasks} ${session.tasks === 1 ? 'task' : 'tasks'})\n  ${session.id}\n  ${session.summary}`);
        if (!data.sessions.length) lines.push('No recorded sessions on this day.');
    } else {
        for (const day of data.days) lines.push(`${day.day}  ${totalText(day)}`);
    }
    lines.push('', `Task log: ${data.logFile}`);
    return stripVTControlCharacters(lines.join('\n')).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' ');
}

class Dashboard implements UsagePanel {
    focused = true;
    private data: UsageDashboard;
    private selection: string;
    private cursor = 0;
    private offset = 0;
    private pageSize = 8;
    private session?: string;
    private sessionName?: string;
    private sessionTotals?: UsageTotals;
    private activityOnly = true;
    private input?: UsageInput;
    private error = '';
    private refreshing = false;
    private disposed = false;
    private timer: NodeJS.Timeout;
    private sourceRows: PreparedRow[] = [];
    private activity: PreparedRow[] = [];
    private query = '';
    private sortIndex = 0;
    private parents: ViewState[] = [];
    private creditColumns = 12;
    private selectedTokenKey = '';
    private selectedTokens: TokenTotals = { prompts: 0, reportedPrompts: 0, fields: {} };
    private selectedTokenText = '';
    private tokensExpanded = false;
    private tokenOffset = 0;
    private tokenPageSize = 8;
    private wrappedTokens?: { width: number; lines: string[] };
    constructor(private ledger: CreditLedger, selected: string | undefined, private refresh: (force?: boolean) => Promise<AccountUsage>, private ui: UsageUiPort,
        private tui: UsageTerminal, private theme: UsageTheme, private done: (value: void) => void, private accountCacheMs: number) {
        this.data = ledger.dashboard(selected);
        this.selection = this.data.selected;
        this.rebuildRows(validDay(this.selection) ? undefined : this.data.today);
        this.timer = setInterval(() => this.reload(), 5000);
        this.timer.unref();
        void this.refreshPlan(false);
    }
    private clean(text: string): string { return this.ui.stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ' '); }
    private reload(): void {
        if (this.disposed) return;
        try { this.data = this.ledger.dashboard(this.selection); this.rebuildRows(); this.error = ''; }
        catch (error) { this.error = publicError(error); }
        this.tui.requestRender();
    }
    private async refreshPlan(force: boolean): Promise<void> {
        if (this.refreshing || this.disposed) return;
        this.refreshing = true;
        this.tui.requestRender();
        let failure = '';
        try { await this.refresh(force); }
        catch (error) { failure = publicError(error); }
        finally {
            this.refreshing = false;
            if (!this.disposed) { this.reload(); if (failure) { this.error = failure; this.tui.requestRender(); } }
        }
    }
    private captureView(): ViewState {
        return { selection: this.selection, session: this.session, query: this.query, sortIndex: this.sortIndex,
            selectedId: this.activity[this.cursor]?.id, cursor: this.cursor };
    }
    private showView(view: ViewState): boolean {
        try {
            const data = this.ledger.dashboard(view.selection);
            this.selection = data.selected; this.data = data; this.session = view.session;
            this.query = view.query; this.sortIndex = view.sortIndex; this.cursor = view.cursor; this.offset = 0;
            this.error = ''; this.input = undefined; this.tokensExpanded = false;
            this.activity = []; // A new view must not inherit a coincidentally matching row ID.
            this.rebuildRows(view.selectedId);
            return true;
        } catch (error) { this.error = publicError(error); return false; }
        finally { this.tui.requestRender(); }
    }
    private navigate(selected: string, selectedId?: string): boolean {
        const ok = this.showView({ selection: selected, query: '', sortIndex: this.sortIndex, cursor: 0,
            selectedId: selectedId ?? (selected === this.data.currentMonth ? this.data.today : undefined) });
        if (ok) this.parents = [];
        return ok;
    }
    private back(): void {
        const parent = this.parents.at(-1);
        if (parent) { if (this.showView(parent)) this.parents.pop(); }
        else if (this.session) this.showView({ selection: this.selection, query: '', sortIndex: this.sortIndex, cursor: 0, selectedId: this.session });
        else if (validDay(this.selection)) this.navigate(this.selection.slice(0, 7), this.selection);
        else this.done();
    }
    private days() { return this.data.days.filter(day => !this.activityOnly || day.prompts > 0); }
    private rows(): PreparedRow[] { return this.activity; }
    private rebuildRows(selectedId = this.activity[this.cursor]?.id): void {
        const session = this.data.sessions.find(item => item.id === this.session);
        this.sessionName = session ? sessionTitle(session) : undefined;
        this.sessionTotals = session;
        this.sourceRows = this.loadRows().map(row => {
            const credits = compactTotal(row.totals);
            return { ...row, credits, creditWidth: this.ui.visibleWidth(credits),
                search: this.clean([row.id, row.tokenRef?.id ?? '', row.label, validDay(this.selection) ? this.selection : '', row.time ?? '', row.note ?? ''].join(' ')).toLowerCase() };
        });
        this.applyView(selectedId, true);
    }
    private applyView(selectedId = this.activity[this.cursor]?.id, forceTokens = false): void {
        const query = this.query.toLowerCase(), sort = sorts[this.sortIndex]!;
        this.activity = this.sourceRows.filter(row => !query || row.search.includes(query)).sort((a, b) => {
            if (sort.field === 'credits') {
                if (a.totals.credits === null && b.totals.credits !== null) return 1;
                if (b.totals.credits === null && a.totals.credits !== null) return -1;
                const difference = (a.totals.credits ?? 0) - (b.totals.credits ?? 0);
                if (difference) return difference * sort.direction;
            }
            const date = a.startedAt - b.startedAt;
            return date * (sort.field === 'date' ? sort.direction : 1) || a.id.localeCompare(b.id);
        });
        const index = this.activity.findIndex(row => row.id === selectedId);
        this.cursor = index >= 0 ? index : Math.max(0, Math.min(this.cursor, this.activity.length - 1));
        this.offset = Math.min(this.offset, this.cursor);
        this.creditColumns = this.activity.reduce((max, row) => Math.min(18, Math.max(max, row.creditWidth)), 12);
        this.updateTokens(forceTokens);
    }
    private updateTokens(force = false): void {
        const selected = this.activity[this.cursor], ref = selected?.tokenRef;
        const key = JSON.stringify([this.selection, this.session, selected?.id]);
        if (!force && key === this.selectedTokenKey) return;
        if (key !== this.selectedTokenKey) { this.tokensExpanded = false; this.tokenOffset = 0; }
        this.wrappedTokens = undefined;
        try {
            this.selectedTokens = ref?.kind === 'task' ? this.ledger.taskTokens(ref.id, this.selection)
                : ref?.kind === 'prompt' ? this.ledger.promptTokens(ref.id, this.selection)
                : ref?.kind === 'session' ? this.ledger.sessionTokens(ref.id, this.selection)
                : { prompts: 0, reportedPrompts: 0, fields: {} };
            this.selectedTokenText = tokenText(this.selectedTokens);
            this.selectedTokenKey = key;
        } catch (error) {
            // Never display the previous row's tokens under a newly selected identity.
            this.selectedTokens = { prompts: selected?.totals.prompts ?? 0, reportedPrompts: 0, fields: {} };
            this.selectedTokenText = 'Token data unavailable'; this.selectedTokenKey = '';
            throw error;
        }
    }
    private loadRows(): ActivityRow[] {
        if (this.session) {
            return this.ledger.sessionTasks(this.selection, this.session).map(task => ({
                id: `${task.kind}:${task.id}`, startedAt: task.startedAt, tokenRef: { kind: task.kind, id: task.id },
                label: `${shortId(task.kind, task.id)} · ${task.summary === 'Provider request' ? task.kind === 'prompt' ? 'Request' : 'Task' : task.summary}`,
                time: localTime(task.startedAt, this.data.timeZone), totals: task,
                detail: `${task.outcome.charAt(0).toUpperCase() + task.outcome.slice(1)} · ${requests(task.prompts)}${task.unfinished ? ` · ${task.unfinished} unfinished` : ''}${task.unreported ? ` · ${task.unreported} unreported credits` : ''}`,
                note: plainExcerpt(task.resultSummary || (task.summary === 'Provider request' ? '' : task.summary)),
            }));
        }
        if (validDay(this.selection))
            return this.data.sessions.map(session => ({ id: session.id, startedAt: session.startedAt, tokenRef: { kind: 'session', id: session.id },
                label: sessionTitle(session), time: localTime(session.startedAt, this.data.timeZone), totals: session,
                detail: `${session.tasks} ${session.tasks === 1 ? 'task/request' : 'tasks/requests'} · ${requests(session.prompts)}${session.unreported ? ` · ${session.unreported} unreported credits` : ''}`,
                note: session.summary === 'Provider request' ? '' : session.summary }));
        return this.days().map(day => ({ id: day.day, startedAt: Date.parse(`${day.day}T12:00:00Z`),
            label: dateLabel(day.day, true) + (day.day === this.data.today ? ' · Today' : ''), totals: day,
            detail: day.unreported ? `${day.unreported} unreported credits` : '' }));
    }
    private startInput(search: boolean): void {
        this.input = new this.ui.Input({ prompt: search ? 'Find: ' : 'Date: ', placeholder: search ? 'Label, date or ID · Enter applies' : 'YYYY-MM-DD or YYYY-MM' });
        this.input.focused = this.focused;
        if (search) this.input.setValue?.(this.query);
        this.input.onSubmit = value => {
            if (!search) { this.navigate(value.trim()); return; }
            this.query = this.clean(value).trim().slice(0, 200); this.input = undefined; this.offset = 0;
            this.applyView(); this.tui.requestRender();
        };
        this.input.onEscape = () => { this.input = undefined; this.error = ''; };
    }
    handleInput(data: string): void {
        if (this.disposed) return;
        if (this.input) {
            try { this.input.handleInput(data); } catch (error) { this.error = publicError(error); }
            this.tui.requestRender(); return;
        }
        const key = (name: string) => this.ui.matchesKey(data, name);
        if (data === 'q' || key('ctrl+c')) { this.done(); return; }
        if (this.tokensExpanded) {
            if (key('escape') || data === 'b' || data === 't') this.tokensExpanded = false;
            else if (key('up') || data === 'k') this.tokenOffset = Math.max(0, this.tokenOffset - 1);
            else if (key('down') || data === 'j') this.tokenOffset++;
            else if (key('pageUp')) this.tokenOffset = Math.max(0, this.tokenOffset - this.tokenPageSize);
            else if (key('pageDown')) this.tokenOffset += this.tokenPageSize;
            else if (data === 'r') void this.refreshPlan(true);
            this.tui.requestRender(); return;
        }
        try {
            if (key('escape') || data === 'b') this.back();
            else if (data === 'r') void this.refreshPlan(true);
            else if (data === '1') this.navigate(this.data.currentMonth);
            else if (data === '2') this.navigate(this.data.previousMonth);
            else if (data === 'a' && !validDay(this.selection)) { this.activityOnly = !this.activityOnly; this.rebuildRows(); }
            else if (key('left')) this.navigate(shiftMonth(this.data.month, -1));
            else if (key('right')) this.navigate(shiftMonth(this.data.month, 1));
            else if (data === 'd' || data === '/') this.startInput(data === '/');
            else if (data === 'c') { this.query = ''; this.applyView(); }
            else if (data === 's') { this.sortIndex = (this.sortIndex + 1) % sorts.length; this.applyView(); }
            else if (data === 't' && this.activity[this.cursor]?.tokenRef) { this.tokensExpanded = true; this.tokenOffset = 0; }
            else if (key('up') || data === 'k') this.cursor = Math.max(0, this.cursor - 1);
            else if (key('down') || data === 'j') this.cursor = Math.max(0, Math.min(this.rows().length - 1, this.cursor + 1));
            else if (key('pageUp')) this.cursor = Math.max(0, this.cursor - this.pageSize);
            else if (key('pageDown')) this.cursor = Math.max(0, Math.min(this.rows().length - 1, this.cursor + this.pageSize));
            else if (key('return')) {
                const selected = this.activity[this.cursor];
                if (selected && this.session) { this.tokensExpanded = true; this.tokenOffset = 0; }
                else if (selected) {
                    const parent = this.captureView();
                    if (this.showView({ selection: validDay(this.selection) ? this.selection : selected.id,
                        session: validDay(this.selection) ? selected.id : undefined, query: '', sortIndex: this.sortIndex, cursor: 0 })) this.parents.push(parent);
                }
            }
            this.updateTokens();
        } catch (error) { this.error = publicError(error); }
        this.tui.requestRender();
    }
    render(width: number): string[] {
        const w = Math.max(0, Math.floor(width)), inner = w - 4, th = this.theme;
        const height = Math.max(1, this.tui.terminal.rows - 2);
        if (!w) return [];
        if (height < 14 || w < 36) return [this.ui.truncateToWidth('Resize terminal for usage. q closes.', w)];
        if (this.tokensExpanded) return this.renderTokens(w, height);
        const cell = (text: string, size: number, color = 'text', align: 'left' | 'right' = 'left', bold = false) => {
            if (size <= 0) return '';
            const clipped = this.ui.truncateToWidth(this.clean(text), size, '…');
            const pad = ' '.repeat(Math.max(0, size - this.ui.visibleWidth(clipped)));
            const value = bold ? th.bold(clipped) : clipped;
            return th.fg(color, align === 'right' ? pad + value : value + pad);
        };
        const frame = (content: string) => th.fg('borderMuted', '│ ') + content + th.fg('borderMuted', ' │');
        const row = (text: string, color = 'text', bold = false) => frame(cell(text, inner, color, 'left', bold));
        const pair = (left: string, right: string, color = 'text', bold = false) => {
            const rightWidth = Math.min(Math.floor(inner / 2), this.ui.visibleWidth(this.clean(right)));
            return frame(cell(left, inner - rightWidth - 2, color, 'left', bold) + '  ' + cell(right, rightWidth, 'muted', 'right'));
        };
        const line = () => th.fg('borderMuted', `├${'─'.repeat(w - 2)}┤`);
        const wrap = (text: string, count: number) => {
            let rest = this.clean(text).replace(/\s+/g, ' ').trim();
            const lines: string[] = [];
            while (rest && lines.length < count) {
                if (lines.length === count - 1) { lines.push(this.ui.truncateToWidth(rest, inner, '…')); break; }
                let part = this.ui.truncateToWidth(rest, inner, '');
                const space = part.lastIndexOf(' ');
                if (part.length < rest.length && space > inner / 3) part = part.slice(0, space);
                lines.push(part); rest = rest.slice(part.length).trimStart();
            }
            return lines;
        };
        const colorFor = (totals: UsageTotals) => totals.unreported ? 'warning' : totals.credits === null ? 'muted' : 'accent';
        const accountExtras = Math.min(3, (this.data.account?.bonuses.length ?? 0) + (this.data.account?.addOns.length ?? 0)) + (this.data.account?.lastError ? 1 : 0);
        const compact = height < 21 + accountExtras + (inner < 64 ? 2 : 0) + (this.query ? 1 : 0) || inner < 50;
        const dayView = validDay(this.selection);
        const header = [th.fg('borderAccent', `╭${'─'.repeat(w - 2)}╮`), pair('KIRO USAGE', this.data.timeZone, 'accent', true)];
        if (!dayView) {
            const account = this.data.account, plan = account?.allowance;
            if (!compact) header.push(row(`ACCOUNT${account ? ` · ${account.planName}` : ''}`, 'muted'));
            if (plan?.remaining !== null && plan?.remaining !== undefined && plan.total !== null) {
                const remaining = `${creditNumber(plan.remaining)} / ${creditNumber(plan.total)} credits left`;
                const fraction = plan.total > 0 ? Math.max(0, Math.min(1, plan.remaining / plan.total)) : 0;
                const color = fraction <= 0.1 ? 'error' : fraction <= 0.25 ? 'warning' : 'success';
                const filled = Math.round(fraction * 12);
                header.push(compact ? row(remaining, color, true) : pair(remaining, `${'█'.repeat(filled)}${'░'.repeat(12 - filled)} ${Math.round(fraction * 100)}%`, color, true));
            } else header.push(row(plan ? `${creditNumber(plan.used)} credits used · allowance unavailable` : 'Account balance unavailable', 'warning'));
            const freshness = account ? accountFreshness(account, this.accountCacheMs) : undefined;
            if (compact && freshness) header.push(row(freshness.text, freshness.stale ? 'warning' : 'muted'));
            if (!compact && account) {
                const reset = account.reset && validDay(account.reset.slice(0, 10)) ? dateLabel(account.reset.slice(0, 10)) : account.reset;
                header.push(row(`${freshness!.text}${reset ? ` · resets ${reset}` : ''}${plan ? ` · ${creditNumber(plan.used)} used` : ''}`, freshness!.stale ? 'warning' : 'muted'));
                const packs = [...account.bonuses, ...account.addOns];
                for (const pack of packs.slice(0, 2))
                    header.push(pair(pack.name, `${pack.remaining === null ? '?' : creditNumber(pack.remaining)} / ${pack.total === null ? '?' : creditNumber(pack.total)} left`, 'muted'));
                if (packs.length > 2) header.push(row(`${packs.length - 2} more credit packs · details in /kiro usage`, 'muted'));
            }
            if (account?.lastError && height >= 18) header.push(row(plan ? 'Account refresh failed · showing the last balance' : 'Account refresh failed · r to retry', 'warning'));
            if (compact && height >= 18) {
                header.push(pair('Today / All recorded', `${compactTotal(this.data.todayUsage)} / ${compactTotal(this.data.allTime)}`));
                header.push(pair(`${monthLabel(this.data.currentMonth, true)} / ${monthLabel(this.data.previousMonth, true)}`, `${compactTotal(this.data.currentMonthUsage)} / ${compactTotal(this.data.previousMonthUsage)}`));
            } else if (!compact) {
                header.push(row(''));
                header.push(row(`RECORDED HERE · credits${this.data.recordedSince ? ` · since ${dateLabel(this.data.recordedSince)} ${this.data.recordedSince.slice(0, 4)}` : ''}`, 'muted'));
                const stats = [
                    { label: 'Today', value: this.data.todayUsage },
                    { label: monthLabel(this.data.currentMonth, true), value: this.data.currentMonthUsage },
                    { label: monthLabel(this.data.previousMonth, true), value: this.data.previousMonthUsage },
                    { label: 'All recorded', value: this.data.allTime },
                ];
                const columns = inner >= 64 ? 4 : 2;
                const size = Math.floor((inner - (columns - 1) * 2) / columns);
                for (let index = 0; index < stats.length; index += columns) {
                    const group = stats.slice(index, index + columns);
                    const tail = ' '.repeat(inner - size * columns - (columns - 1) * 2);
                    header.push(frame(group.map(stat => cell(stat.label, size, 'muted')).join('  ') + tail));
                    header.push(frame(group.map(stat => cell(compactTotal(stat.value), size, colorFor(stat.value), 'left', true)).join('  ') + tail));
                }
            }
            if (height >= 18) header.push(row(this.data.allTime.unreported ? 'Here only · — no records · ? / Pending = unreported' : 'Recorded here only · — means no records', 'muted'));
            header.push(line(), pair(monthLabel(this.data.month, compact), totalText(this.data.selectedUsage), 'accent', true));
        } else {
            header.push(row(`${compact ? `${dateLabel(this.selection)} ${this.selection.slice(0, 4)}` : `${monthLabel(this.data.month)}  ›  ${dateLabel(this.selection, true)}`}${this.session ? '  ›  Tasks' : '  ›  Sessions'}`, 'muted'));
            const selected = this.sessionTotals;
            header.push(pair(this.session ? this.sessionName || 'Session' : `${this.data.sessions.length} ${this.data.sessions.length === 1 ? 'session' : 'sessions'}`, totalText(selected ?? this.data.selectedUsage), 'accent', true));
            header.push(line());
        }
        if (this.query) header.push(row(`Find: ${this.query} · c clears · totals remain unfiltered`, 'muted'));
        const rows = this.rows();
        this.cursor = Math.max(0, Math.min(this.cursor, rows.length - 1));
        const selected = rows[this.cursor];
        const details: string[] = [];
        if (dayView && selected && height >= 20) {
            details.push(line(), row(selected.detail, selected.totals.unreported ? 'warning' : 'muted'));
            const label = selected.tokenRef?.kind === 'prompt' ? 'Request' : this.session ? 'Task' : 'Session';
            details.push(...wrap(`${label} tokens (${this.selection}): ${this.selectedTokenText}`, 2).map(text => row(text, 'muted')));
            if (this.ui.visibleWidth(this.clean(selected.label)) > inner - 25)
                details.push(...wrap(selected.label, 2).map(text => row(text)));
            if (selected.note && selected.note !== selected.label)
                details.push(...wrap(selected.note, 2).map(text => row(text, 'muted')));
        }
        const creditWidth = Math.min(Math.floor(inner / 2), this.creditColumns);
        const leadingWidth = dayView ? 5 : inner - creditWidth - (inner < 50 ? 4 : 8) - 6;
        const middleWidth = inner - creditWidth - leadingWidth - 6;
        header.push(frame('  ' + cell(dayView ? 'Time' : 'Day', leadingWidth, 'muted') + '  ' + cell(dayView ? this.session ? 'Task' : 'Session' : inner < 50 ? 'Req' : 'Requests', middleWidth, 'muted', dayView ? 'left' : 'right') + '  ' + cell('Credits', creditWidth, 'muted', 'right')));
        const footer: string[] = [line()];
        if (this.input) {
            this.input.focused = this.focused;
            footer.push(...this.input.render(inner).map(frame));
        } else footer.push(row(inner < 50 ? `↑↓ Enter /find s${sorts[this.sortIndex]!.label.replace(' ', '')}${dayView ? ' t info' : ''}` : `↑↓ select  Enter ${this.session ? 'tokens' : dayView ? 'tasks' : 'sessions'}  / search  s ${sorts[this.sortIndex]!.label}${dayView ? '  t tokens' : ''}`, 'muted'));
        if (this.error || this.refreshing) footer.push(row(this.error || 'Refreshing account balance…', this.error ? 'error' : 'muted'));
        const toggle = dayView ? '' : inner < 50 ? 'a days ' : `a ${this.activityOnly ? 'all days' : 'active days'}  `;
        footer.push(pair(inner < 50 ? '←→ d date r Esc q close' : `←→ month  d date  ${toggle}r refresh  Esc back  q close`, rows.length ? `${this.cursor + 1}/${rows.length}${this.query ? ` (${this.sourceRows.length})` : ''}` : '0', 'muted'));
        footer.push(th.fg('borderAccent', `╰${'─'.repeat(w - 2)}╯`));
        while (details.length && header.length + details.length + footer.length >= height) details.pop();
        this.pageSize = Math.max(1, height - header.length - details.length - footer.length);
        if (this.cursor < this.offset) this.offset = this.cursor;
        if (this.cursor >= this.offset + this.pageSize) this.offset = this.cursor - this.pageSize + 1;
        const visible = rows.slice(this.offset, this.offset + this.pageSize);
        const body = visible.map((item, index) => {
            const active = index + this.offset === this.cursor;
            const color = active ? 'accent' : item.totals.prompts ? 'text' : 'muted';
            return frame(th.fg('accent', active ? '› ' : '  ')
                + cell(dayView ? item.time || '' : item.label, leadingWidth, color)
                + '  ' + cell(dayView ? item.label : String(item.totals.prompts || '—'), middleWidth, color, dayView ? 'left' : 'right', active)
                + '  ' + cell(item.credits, creditWidth, colorFor(item.totals), 'right', active));
        });
        if (!body.length) body.push(row(this.query ? 'No matches. / edits search · c clears.' : 'No recorded activity for this selection.', 'muted'));
        while (body.length < this.pageSize) body.push(row(''));
        return [...header, ...body, ...details, ...footer];
    }
    private renderTokens(width: number, height: number): string[] {
        const inner = width - 4, th = this.theme, selected = this.activity[this.cursor];
        const row = (text: string, color = 'text') => {
            const clipped = this.ui.truncateToWidth(this.clean(text), inner, '…');
            return th.fg('borderMuted', '│ ') + th.fg(color, clipped + ' '.repeat(Math.max(0, inner - this.ui.visibleWidth(clipped)))) + th.fg('borderMuted', ' │');
        };
        const line = () => th.fg('borderMuted', `├${'─'.repeat(width - 2)}┤`);
        if (!this.wrappedTokens || this.wrappedTokens.width !== inner) {
            const source = [
                `${requests(this.selectedTokens.prompts)} · ${this.selectedTokens.reportedPrompts} with token reports`,
                ...this.selectedTokenText.split(' · '),
                'Coverage is per field. Fields may overlap; do not add them to infer a total.',
            ];
            const lines: string[] = [];
            for (const text of source) {
                let rest = this.clean(text);
                while (rest) {
                    let part = this.ui.truncateToWidth(rest, inner, '');
                    const space = part.lastIndexOf(' ');
                    if (part.length < rest.length && space > inner / 3) part = part.slice(0, space);
                    if (!part) break;
                    lines.push(part); rest = rest.slice(part.length).trimStart();
                }
            }
            this.wrappedTokens = { width: inner, lines };
        }
        const header = [th.fg('borderAccent', `╭${'─'.repeat(width - 2)}╮`), row('TOKEN DETAILS', 'accent'),
            row(selected?.label ?? 'No selection'), row(`Scope: ${this.selection} · ${this.data.timeZone} · prompt start`, 'muted'), line()];
        const footer = [line(), row('↑↓ / PgUp PgDn scroll · t / Esc back', 'muted'), row(this.error || (this.refreshing ? 'Refreshing…' : 'r refresh · q close'), this.error ? 'error' : 'muted'),
            th.fg('borderAccent', `╰${'─'.repeat(width - 2)}╯`)];
        this.tokenPageSize = Math.max(1, height - header.length - footer.length);
        const lines = this.wrappedTokens.lines;
        this.tokenOffset = Math.max(0, Math.min(this.tokenOffset, lines.length - this.tokenPageSize));
        const body = lines.slice(this.tokenOffset, this.tokenOffset + this.tokenPageSize).map(text => row(text));
        while (body.length < this.tokenPageSize) body.push(row(''));
        return [...header, ...body, ...footer];
    }
    invalidate(): void { this.wrappedTokens = undefined; this.input?.invalidate(); }
    dispose(): void { this.disposed = true; clearInterval(this.timer); }
}

export async function openUsageDashboard(args: string, ctx: HostContext, ledger: CreditLedger, refresh: (force?: boolean) => Promise<AccountUsage>, ui?: UsageUiPort, accountCacheMs = 300000): Promise<void> {
    const selected = args.trim();
    if (selected && selected !== 'refresh' && !validDay(selected) && !validMonth(selected)) {
        ctx.ui?.notify('Usage: /usage [YYYY-MM | YYYY-MM-DD | refresh]', 'error'); return;
    }
    if (selected === 'refresh') await refresh(true);
    const selection = selected === 'refresh' ? undefined : selected || undefined;
    if (!ui || !ctx.ui?.custom || (ctx.mode && ctx.mode !== 'tui')) {
        await refresh(false);
        ctx.ui?.notify(dashboardText(ledger.dashboard(selection)), 'info');
        return;
    }
    await ctx.ui.custom<void>((tui, theme, _keys, done) => new Dashboard(ledger, selection, refresh, ui, tui, theme, done, accountCacheMs), { overlay: true, overlayOptions: { width: '100%' } });
}
