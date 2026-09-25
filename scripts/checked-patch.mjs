import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(value).digest('hex');

// Review every source hash and replacement before touching the installation.
// A manifest is published last; an interrupted install is never reported ready.
export function checkedPatch({ root, packageName, packageVersion, specs, manifestName, metadata = {}, check = false }) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg.name !== packageName || pkg.version !== packageVersion)
        throw new Error(`${packageName} ${pkg.version} needs a fresh review; supported version is ${packageVersion}. No files changed.`);
    const plan = specs.map(({ name, sha256, edits, header = '', previous = [] }) => {
        const file = path.join(root, name), backup = `${file}.kiro-acp-original`;
        const source = fs.readFileSync(fs.existsSync(backup) ? backup : file, 'utf8');
        if (digest(source) !== sha256) throw new Error(`Unrecognized ${packageName} code: ${name}. No files changed.`);
        const render = ({ edits, header = '' }) => {
            let patched = source;
            for (const [before, after, count = 1] of edits) {
                if (patched.split(before).length !== count + 1)
                    throw new Error(`Unexpected patch locations in ${name}. No files changed.`);
                patched = patched.split(before).join(after);
            }
            return patched.startsWith('#!') ? patched.replace(/^(#![^\n]*\n)/, `$1${header}`) : header + patched;
        };
        const patched = render({ edits, header });
        // Upgrade only byte-exact, reviewed older recipes. A backup or manifest
        // alone never authorizes overwriting modified installed code.
        const prior = previous.map(render);
        const current = fs.readFileSync(file, 'utf8');
        if (current !== source && current !== patched && !prior.includes(current))
            throw new Error(`Modified ${packageName} installation: ${name}. No files changed.`);
        return { name, file, backup, source, patched, current };
    });
    const manifest = { ...metadata, files: Object.fromEntries(plan.map(item => [item.name, digest(item.patched)])) };
    const manifestPath = path.join(root, manifestName);
    const encoded = JSON.stringify(manifest, null, 2) + '\n';
    if (check) {
        if (plan.some(item => item.current !== item.patched) || !fs.existsSync(manifestPath) || fs.readFileSync(manifestPath, 'utf8') !== encoded)
            throw new Error(`${packageName} patch is missing or changed; apply its patch and restart Pi.`);
    } else {
        for (const item of plan) {
            if (!fs.existsSync(item.backup)) fs.writeFileSync(item.backup, item.source, { flag: 'wx', mode: 0o600 });
            if (item.current === item.patched) continue;
            const temporary = `${item.file}.${process.pid}.tmp`;
            fs.writeFileSync(temporary, item.patched, { flag: 'wx', mode: fs.statSync(item.file).mode & 0o777 });
            fs.renameSync(temporary, item.file);
        }
        const temporary = `${manifestPath}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, encoded, { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, manifestPath);
    }
    return manifest;
}
