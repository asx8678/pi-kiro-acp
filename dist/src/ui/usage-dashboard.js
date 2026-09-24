import { localTime, shiftMonth, validDay, validMonth } from '../diagnostics/calendar.js';
import { publicError } from '../errors.js';
import { stripVTControlCharacters } from 'node:util';
import { tokenText } from './token-usage.js';
export const creditNumber = (value) => value > 0 && value < 0.0001 ? '<0.0001' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(value);
export function totalText(totals) {
    if (totals.credits === null)
        return totals.prompts ? `${totals.unreported} ${totals.unreported === 1 ? 'request' : 'requests'} awaiting credit report` : 'no records';
    return `${creditNumber(totals.credits)} credits` + (totals.unreported ? ` (${totals.unreported} awaiting credit report)` : '');
}
function dateLabel(day, weekday = false) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...(weekday ? { weekday: 'short' } : {}), day: 'numeric', month: 'short' }).format(new Date(`${day}T12:00:00Z`));
}
function monthLabel(month, short = false) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: short ? 'short' : 'long', year: 'numeric' }).format(new Date(`${month}-01T12:00:00Z`));
}
function compactTotal(totals) {
    if (totals.credits === null)
        return totals.prompts ? 'Pending' : '—';
    return creditNumber(totals.credits) + (totals.unreported ? ' + ?' : '');
}
function sessionTitle(session) {
    return session.name === `Session ${session.id.slice(0, 12)}` || session.name === 'Unnamed session' ? session.summary : session.name;
}
function requests(count) { return `${count} ${count === 1 ? 'request' : 'requests'}`; }
function plainExcerpt(text) {
    return text.replace(/(^|\s)#{1,6}\s+/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1');
}
function accountLines(data) {
    const account = data.account, plan = account?.allowance;
    if (!account)
        return ['Plan balance: not fetched yet'];
    const lines = [`${account.planName} · checked ${new Date(account.checkedAt).toLocaleString('en-GB', { timeZone: data.timeZone })}`];
    if (plan) {
        lines.push(plan.total !== null && plan.remaining !== null
            ? `Plan remaining: ${creditNumber(plan.remaining)} / ${creditNumber(plan.total)} credits  ·  Used: ${creditNumber(plan.used)}`
            : `Plan used: ${creditNumber(plan.used)} credits  ·  Allowance not exposed by Kiro`);
    }
    else
        lines.push(account.message || 'Plan balance unavailable');
    if (account.reset)
        lines.push(`Plan resets: ${account.reset}`);
    for (const pack of [...account.bonuses, ...account.addOns])
        lines.push(`${pack.name}: ${pack.remaining === null ? '?' : creditNumber(pack.remaining)} / ${pack.total === null ? '?' : creditNumber(pack.total)} remaining${pack.expires ? `; expires ${pack.expires}` : ''}`);
    if (account.lastError)
        lines.push(`Refresh unavailable${plan ? '; showing last account data' : ''}. ${account.lastError}`);
    return lines;
}
export function dashboardText(data) {
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
            lines.push(`${localTime(session.startedAt, data.timeZone)}  ${session.name}  ${totalText(session)}  (${session.tasks} ${session.tasks === 1 ? 'task' : 'tasks'})\n  ${session.id}\n  ${session.summary}`);
        if (!data.sessions.length)
            lines.push('No recorded sessions on this day.');
    }
    else {
        for (const day of data.days)
            lines.push(`${day.day}  ${totalText(day)}`);
    }
    lines.push('', `Task log: ${data.logFile}`);
    return stripVTControlCharacters(lines.join('\n')).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' ');
}
class Dashboard {
    ledger;
    refresh;
    ui;
    tui;
    theme;
    done;
    focused = true;
    data;
    selection;
    cursor = 0;
    offset = 0;
    pageSize = 8;
    session;
    sessionName;
    activityOnly = true;
    input;
    error = '';
    refreshing = false;
    disposed = false;
    timer;
    constructor(ledger, selected, refresh, ui, tui, theme, done) {
        this.ledger = ledger;
        this.refresh = refresh;
        this.ui = ui;
        this.tui = tui;
        this.theme = theme;
        this.done = done;
        this.data = ledger.dashboard(selected);
        this.selection = this.data.selected;
        if (!validDay(this.selection))
            this.cursor = this.days().findIndex(day => day.day === this.data.today);
        this.cursor = Math.max(0, this.cursor);
        this.timer = setInterval(() => this.reload(), 5000);
        this.timer.unref();
        void this.refreshPlan(false);
    }
    clean(text) { return this.ui.stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ' '); }
    reload() {
        if (this.disposed)
            return;
        try {
            this.data = this.ledger.dashboard(this.selection);
        }
        catch (error) {
            this.error = publicError(error);
        }
        this.tui.requestRender();
    }
    async refreshPlan(force) {
        if (this.refreshing)
            return;
        this.refreshing = true;
        this.tui.requestRender();
        try {
            await this.refresh(force);
        }
        catch (error) {
            this.error = publicError(error);
        }
        finally {
            this.refreshing = false;
            this.reload();
        }
    }
    navigate(selected) {
        try {
            const data = this.ledger.dashboard(selected);
            this.selection = data.selected;
            this.data = data;
            this.cursor = data.selected === data.currentMonth ? Math.max(0, this.days().findIndex(day => day.day === data.today)) : 0;
            this.offset = 0;
            this.session = undefined;
            this.sessionName = undefined;
            this.error = '';
            this.input = undefined;
        }
        catch (error) {
            this.error = publicError(error);
        }
        this.tui.requestRender();
    }
    days() { return this.data.days.filter(day => !this.activityOnly || day.prompts > 0); }
    rows() {
        if (this.session) {
            const tasks = this.ledger.sessionTasks(this.selection, this.session);
            return tasks.map(task => ({ id: task.id, label: task.summary, time: localTime(task.startedAt, this.data.timeZone), totals: task,
                detail: `${task.outcome.charAt(0).toUpperCase() + task.outcome.slice(1)} · ${requests(task.prompts)}${task.unreported ? ` · ${task.unreported} awaiting credit report` : ''}`,
                note: plainExcerpt(task.resultSummary || task.summary) }));
        }
        if (validDay(this.selection))
            return this.data.sessions.map(session => ({ id: session.id, label: sessionTitle(session), time: localTime(session.startedAt, this.data.timeZone), totals: session,
                detail: `${session.tasks} ${session.tasks === 1 ? 'task' : 'tasks'} · ${requests(session.prompts)}${session.unreported ? ` · ${session.unreported} awaiting credit report` : ''}`,
                note: session.summary }));
        return this.days().map(day => ({ id: day.day, label: dateLabel(day.day, true) + (day.day === this.data.today ? ' · Today' : ''), totals: day,
            detail: day.unreported ? `${day.unreported} awaiting credit report` : '' }));
    }
    handleInput(data) {
        if (this.input) {
            this.input.handleInput(data);
            this.tui.requestRender();
            return;
        }
        const key = (name) => this.ui.matchesKey(data, name);
        if (key('escape') || data === 'b') {
            if (this.session) {
                const id = this.session;
                this.session = undefined;
                this.sessionName = undefined;
                this.cursor = Math.max(0, this.data.sessions.findIndex(session => session.id === id));
                this.offset = 0;
            }
            else if (validDay(this.selection)) {
                const day = this.selection;
                this.navigate(day.slice(0, 7));
                this.cursor = Math.max(0, this.days().findIndex(row => row.day === day));
            }
            else
                this.done();
        }
        else if (data === 'q' || key('ctrl+c'))
            this.done();
        else if (data === 'r')
            void this.refreshPlan(true);
        else if (data === '1')
            this.navigate(this.data.currentMonth);
        else if (data === '2')
            this.navigate(this.data.previousMonth);
        else if (data === 'a' && !validDay(this.selection)) {
            const selected = this.days()[this.cursor]?.day;
            this.activityOnly = !this.activityOnly;
            this.cursor = Math.max(0, this.days().findIndex(day => day.day === selected));
            this.offset = 0;
        }
        else if (key('left')) {
            try {
                this.navigate(shiftMonth(this.data.month, -1));
            }
            catch (error) {
                this.error = publicError(error);
            }
        }
        else if (key('right')) {
            try {
                this.navigate(shiftMonth(this.data.month, 1));
            }
            catch (error) {
                this.error = publicError(error);
            }
        }
        else if (data === 'd') {
            this.input = new this.ui.Input({ prompt: 'Date: ', placeholder: 'YYYY-MM-DD or YYYY-MM' });
            this.input.focused = true;
            this.input.onSubmit = value => this.navigate(value.trim());
            this.input.onEscape = () => { this.input = undefined; this.error = ''; };
        }
        else if (key('up') || data === 'k')
            this.cursor = Math.max(0, this.cursor - 1);
        else if (key('down') || data === 'j')
            this.cursor = Math.min(this.rows().length - 1, this.cursor + 1);
        else if (key('pageUp'))
            this.cursor = Math.max(0, this.cursor - this.pageSize);
        else if (key('pageDown'))
            this.cursor = Math.min(this.rows().length - 1, this.cursor + this.pageSize);
        else if (key('return') && !this.session) {
            if (validDay(this.selection)) {
                const row = this.data.sessions[this.cursor];
                if (row) {
                    this.session = row.id;
                    this.sessionName = sessionTitle(row);
                    this.cursor = 0;
                    this.offset = 0;
                }
            }
            else {
                const row = this.days()[this.cursor];
                if (row)
                    this.navigate(row.day);
            }
        }
        this.tui.requestRender();
    }
    render(width) {
        const w = Math.max(4, width), inner = w - 4, th = this.theme;
        const height = Math.max(1, this.tui.terminal.rows - 2);
        if (height < 14 || w < 36)
            return [this.ui.truncateToWidth('Resize terminal for usage. q closes.', w)];
        const cell = (text, size, color = 'text', align = 'left', bold = false) => {
            if (size <= 0)
                return '';
            const clipped = this.ui.truncateToWidth(this.clean(text), size, '…');
            const pad = ' '.repeat(Math.max(0, size - this.ui.visibleWidth(clipped)));
            const value = bold ? th.bold(clipped) : clipped;
            return th.fg(color, align === 'right' ? pad + value : value + pad);
        };
        const frame = (content) => th.fg('borderMuted', '│ ') + content + th.fg('borderMuted', ' │');
        const row = (text, color = 'text', bold = false) => frame(cell(text, inner, color, 'left', bold));
        const pair = (left, right, color = 'text', bold = false) => {
            const rightWidth = Math.min(Math.floor(inner / 2), this.ui.visibleWidth(this.clean(right)));
            return frame(cell(left, inner - rightWidth - 2, color, 'left', bold) + '  ' + cell(right, rightWidth, 'muted', 'right'));
        };
        const line = () => th.fg('borderMuted', `├${'─'.repeat(w - 2)}┤`);
        const wrap = (text, count) => {
            let rest = this.clean(text).replace(/\s+/g, ' ').trim();
            const lines = [];
            while (rest && lines.length < count) {
                if (lines.length === count - 1) {
                    lines.push(this.ui.truncateToWidth(rest, inner, '…'));
                    break;
                }
                let part = this.ui.truncateToWidth(rest, inner, '');
                const space = part.lastIndexOf(' ');
                if (part.length < rest.length && space > inner / 3)
                    part = part.slice(0, space);
                lines.push(part);
                rest = rest.slice(part.length).trimStart();
            }
            return lines;
        };
        const colorFor = (totals) => totals.unreported ? 'warning' : totals.credits === null ? 'muted' : 'accent';
        const accountExtras = Math.min(3, (this.data.account?.bonuses.length ?? 0) + (this.data.account?.addOns.length ?? 0)) + (this.data.account?.lastError ? 1 : 0);
        const compact = height < 21 + accountExtras + (inner < 64 ? 2 : 0) || inner < 50;
        const dayView = validDay(this.selection);
        const header = [th.fg('borderAccent', `╭${'─'.repeat(w - 2)}╮`), pair('KIRO USAGE', this.data.timeZone, 'accent', true)];
        if (!dayView) {
            const account = this.data.account, plan = account?.allowance;
            if (!compact)
                header.push(row(`ACCOUNT${account ? ` · ${account.planName}` : ''}`, 'muted'));
            if (plan?.remaining !== null && plan?.remaining !== undefined && plan.total !== null) {
                const remaining = `${creditNumber(plan.remaining)} / ${creditNumber(plan.total)} credits left`;
                const fraction = plan.total > 0 ? Math.max(0, Math.min(1, plan.remaining / plan.total)) : 0;
                const color = fraction <= 0.1 ? 'error' : fraction <= 0.25 ? 'warning' : 'success';
                const filled = Math.round(fraction * 12);
                header.push(compact ? row(remaining, color, true) : pair(remaining, `${'█'.repeat(filled)}${'░'.repeat(12 - filled)} ${Math.round(fraction * 100)}%`, color, true));
            }
            else
                header.push(row(plan ? `${creditNumber(plan.used)} credits used · allowance unavailable` : 'Account balance unavailable', 'warning'));
            if (!compact && account) {
                const reset = account.reset && validDay(account.reset.slice(0, 10)) ? dateLabel(account.reset.slice(0, 10)) : account.reset;
                const checked = new Date(account.checkedAt).toLocaleString('en-GB', { timeZone: this.data.timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
                header.push(row(`${plan ? `${creditNumber(plan.used)} used · ` : ''}${reset ? `resets ${reset} · ` : ''}checked ${checked}`, 'muted'));
                const packs = [...account.bonuses, ...account.addOns];
                for (const pack of packs.slice(0, 2))
                    header.push(pair(pack.name, `${pack.remaining === null ? '?' : creditNumber(pack.remaining)} / ${pack.total === null ? '?' : creditNumber(pack.total)} left`, 'muted'));
                if (packs.length > 2)
                    header.push(row(`${packs.length - 2} more credit packs · details in /kiro usage`, 'muted'));
            }
            if (account?.lastError)
                header.push(row(plan ? 'Account refresh failed · showing the last balance' : 'Account refresh failed · r to retry', 'warning'));
            if (compact) {
                header.push(pair('Today / All recorded', `${compactTotal(this.data.todayUsage)} / ${compactTotal(this.data.allTime)}`));
                header.push(pair(`${monthLabel(this.data.currentMonth, true)} / ${monthLabel(this.data.previousMonth, true)}`, `${compactTotal(this.data.currentMonthUsage)} / ${compactTotal(this.data.previousMonthUsage)}`));
            }
            else {
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
            header.push(row(this.data.allTime.unreported ? 'Here only · — no records · ? / Pending = unreported' : 'Recorded here only · — means no records', 'muted'));
            header.push(line(), pair(monthLabel(this.data.month, compact), totalText(this.data.selectedUsage), 'accent', true));
        }
        else {
            header.push(row(`${compact ? `${dateLabel(this.selection)} ${this.selection.slice(0, 4)}` : `${monthLabel(this.data.month)}  ›  ${dateLabel(this.selection, true)}`}${this.session ? '  ›  Tasks' : '  ›  Sessions'}`, 'muted'));
            const selected = this.session ? this.data.sessions.find(session => session.id === this.session) : undefined;
            header.push(pair(this.session ? this.sessionName || 'Session' : `${this.data.sessions.length} ${this.data.sessions.length === 1 ? 'session' : 'sessions'}`, totalText(selected ?? this.data.selectedUsage), 'accent', true));
            header.push(line());
        }
        const rows = this.rows();
        this.cursor = Math.max(0, Math.min(this.cursor, rows.length - 1));
        const selected = rows[this.cursor];
        const details = [];
        if (dayView && selected && height >= 20) {
            details.push(line(), row(selected.detail, selected.totals.unreported ? 'warning' : 'muted'));
            const tokens = this.session ? this.ledger.taskTokens(selected.id) : this.ledger.sessionTokens(selected.id);
            const label = this.session ? 'Prompt tokens' : 'Session tokens (all days)';
            details.push(...wrap(`${label}: ${tokenText(tokens)}`, 2).map(text => row(text, 'muted')));
            if (this.ui.visibleWidth(this.clean(selected.label)) > inner - 25)
                details.push(...wrap(selected.label, 2).map(text => row(text)));
            if (selected.note && selected.note !== selected.label)
                details.push(...wrap(selected.note, 2).map(text => row(text, 'muted')));
        }
        const creditWidth = Math.min(Math.floor(inner / 2), 18, Math.max(12, ...rows.map(item => this.ui.visibleWidth(compactTotal(item.totals)))));
        const leadingWidth = dayView ? 5 : inner - creditWidth - (inner < 50 ? 4 : 8) - 6;
        const middleWidth = inner - creditWidth - leadingWidth - 6;
        header.push(frame('  ' + cell(dayView ? 'Time' : 'Day', leadingWidth, 'muted') + '  ' + cell(dayView ? this.session ? 'Task' : 'Session' : inner < 50 ? 'Req' : 'Requests', middleWidth, 'muted', dayView ? 'left' : 'right') + '  ' + cell('Credits', creditWidth, 'muted', 'right')));
        const footer = [line()];
        if (this.input) {
            this.input.focused = this.focused;
            footer.push(...this.input.render(inner).map(frame));
        }
        else
            footer.push(row(inner < 50 ? '↑↓ Enter ←→ d date Esc back' : `↑↓ select   ${this.session ? '' : `Enter ${dayView ? 'tasks' : 'sessions'}   `}←→ month   d date`, 'muted'));
        if (this.error || this.refreshing)
            footer.push(row(this.error || 'Refreshing account balance…', this.error ? 'error' : 'muted'));
        const toggle = dayView ? '' : inner < 50 ? 'a days  ' : `a ${this.activityOnly ? 'all days' : 'active days'}   `;
        footer.push(pair(inner < 50 ? `${toggle}r reload  q close` : `${toggle}r refresh   Esc back   q close`, rows.length ? `${this.cursor + 1}/${rows.length}` : '', 'muted'));
        footer.push(th.fg('borderAccent', `╰${'─'.repeat(w - 2)}╯`));
        this.pageSize = Math.max(1, height - header.length - details.length - footer.length);
        if (this.cursor < this.offset)
            this.offset = this.cursor;
        if (this.cursor >= this.offset + this.pageSize)
            this.offset = this.cursor - this.pageSize + 1;
        const visible = rows.slice(this.offset, this.offset + this.pageSize);
        const body = visible.map((item, index) => {
            const active = index + this.offset === this.cursor;
            const color = active ? 'accent' : item.totals.prompts ? 'text' : 'muted';
            return frame(th.fg('accent', active ? '› ' : '  ')
                + cell(dayView ? item.time || '' : item.label, leadingWidth, color)
                + '  ' + cell(dayView ? item.label : String(item.totals.prompts || '—'), middleWidth, color, dayView ? 'left' : 'right', active)
                + '  ' + cell(compactTotal(item.totals), creditWidth, colorFor(item.totals), 'right', active));
        });
        if (!body.length)
            body.push(row('No recorded activity for this selection.', 'muted'));
        while (body.length < this.pageSize)
            body.push(row(''));
        return [...header, ...body, ...details, ...footer];
    }
    invalidate() { this.input?.invalidate(); }
    dispose() { this.disposed = true; clearInterval(this.timer); }
}
export async function openUsageDashboard(args, ctx, ledger, refresh, ui) {
    const selected = args.trim();
    if (selected && selected !== 'refresh' && !validDay(selected) && !validMonth(selected)) {
        ctx.ui?.notify('Usage: /usage [YYYY-MM | YYYY-MM-DD | refresh]', 'error');
        return;
    }
    if (selected === 'refresh')
        await refresh(true);
    const selection = selected === 'refresh' ? undefined : selected || undefined;
    if (!ui || !ctx.ui?.custom || (ctx.mode && ctx.mode !== 'tui')) {
        await refresh(false);
        ctx.ui?.notify(dashboardText(ledger.dashboard(selection)), 'info');
        return;
    }
    await ctx.ui.custom((tui, theme, _keys, done) => new Dashboard(ledger, selection, refresh, ui, tui, theme, done), { overlay: true, overlayOptions: { width: '100%' } });
}
//# sourceMappingURL=usage-dashboard.js.map