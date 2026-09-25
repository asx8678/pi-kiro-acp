#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const marker = '# pi-kiro-acp managed launcher';
const begin = '# >>> pi-kiro-acp automatic Fabric repair >>>';
const end = '# <<< pi-kiro-acp automatic Fabric repair <<<';
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export function renderLauncher({ node, prepare, realPi, binDir }) {
    // exec preserves terminal handling, signals and the exact Pi exit status.
    return `#!/bin/sh\n${marker}\nexport PATH=${quote(binDir)}:"$PATH"\n${quote(node)} ${quote(prepare)} "$@" || exit $?\nexec ${quote(realPi)} "$@"\n`;
}

export function installLauncher({ home = os.homedir(), shell = path.basename(process.env.SHELL ?? ''),
    binDir = path.join(home, '.local/share/pi-kiro-acp/bin'), realPi,
    searchPath = process.env.PATH ?? '', node = process.execPath,
    prepare = fileURLToPath(new URL('./prepare-pi.mjs', import.meta.url)), report = console.log } = {}) {
    if (!['zsh', 'bash'].includes(shell)) throw new Error('Automatic launcher setup supports zsh and bash. Set SHELL to your shell executable.');
    const launcher = path.join(binDir, 'pi'), rc = path.join(home, shell === 'zsh' ? '.zshrc' : '.bashrc');
    const managedText = file => {
        const stat = fs.lstatSync(file, { throwIfNoEntry: false });
        if (!stat) return undefined;
        if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) throw new Error(`Refusing to replace a non-owned regular file: ${file}`);
        return fs.readFileSync(file, 'utf8');
    };
    const oldLauncher = managedText(launcher), oldRc = managedText(rc) ?? '';
    if (oldLauncher !== undefined && !oldLauncher.startsWith(`#!/bin/sh\n${marker}\n`))
        throw new Error(`Refusing to replace an unmanaged launcher: ${launcher}`);
    if (!realPi) {
        for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
            const candidate = path.resolve(directory, 'pi');
            if (candidate === path.resolve(launcher)) continue;
            try {
                fs.accessSync(candidate, fs.constants.X_OK);
                const resolved = fs.realpathSync(candidate);
                if (resolved === path.resolve(launcher)) continue;
                realPi = resolved; break;
            } catch { /* Continue to the next PATH entry. */ }
        }
    }
    if (!realPi) throw new Error('Install Pi first; no upstream pi executable was found on PATH.');
    realPi = fs.realpathSync(realPi);
    if (realPi === path.resolve(launcher) || fs.readFileSync(realPi, 'utf8').slice(0, 200).includes(marker))
        throw new Error('The upstream Pi executable must not be a managed launcher.');
    fs.accessSync(realPi, fs.constants.X_OK);
    const block = `${begin}\nexport PATH=${quote(binDir)}:"$PATH"\n${end}`;
    const start = oldRc.indexOf(begin), finish = oldRc.indexOf(end);
    if ((start < 0) !== (finish < 0) || (start >= 0 && (finish < start || oldRc.indexOf(begin, start + begin.length) >= 0 || oldRc.indexOf(end, finish + end.length) >= 0)))
        throw new Error(`Ambiguous managed shell block in ${rc}; no files changed.`);
    const nextRc = start < 0 ? `${oldRc}${oldRc.endsWith('\n') || !oldRc ? '' : '\n'}\n${block}\n`
        : oldRc.slice(0, start) + block + oldRc.slice(finish + end.length);
    const content = renderLauncher({ node, prepare, realPi, binDir });
    fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
    const write = (file, content, mode) => {
        const temporary = `${file}.${randomUUID()}.tmp`;
        fs.writeFileSync(temporary, content, { flag: 'wx', mode });
        fs.renameSync(temporary, file);
    };
    if (oldLauncher !== content) write(launcher, content, 0o700);
    if (oldRc !== nextRc) {
        if (fs.existsSync(rc)) {
            const backup = `${rc}.kiro-acp-backup-${randomUUID()}`;
            fs.writeFileSync(backup, oldRc, { flag: 'wx', mode: 0o600 });
            report(`Shell configuration backup: ${backup}`);
        }
        write(rc, nextRc, fs.existsSync(rc) ? fs.statSync(rc).mode & 0o777 : 0o600);
    }
    report(`Automatic Fabric repair installed: ${launcher}`);
    report(`Open a new terminal or run: export PATH=${quote(binDir)}:"$PATH"`);
    return { launcher, rc, realPi };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.length > 2) throw new Error('Usage: bun run install:launcher');
    installLauncher();
}
