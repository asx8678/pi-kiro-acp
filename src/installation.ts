import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateDir, type Config } from './config.js';
import { BridgeError } from './errors.js';
import { object } from './util.js';

type InstallationConfig = Pick<Config, 'stateDir'>;
const FILE_NAME = 'kiro-acp-installation-id';
const MAX_BYTES = 4096;

export function installationIdPath(config: InstallationConfig): string {
    return path.join(config.stateDir, FILE_NAME);
}

function readId(config: InstallationConfig, secure = false): string | undefined {
    const file = installationIdPath(config);
    let fd: number | undefined;
    try {
        const check = (st: fs.Stats) => {
            if (!st.isFile() || (process.getuid && st.uid !== process.getuid()))
                throw new BridgeError('CONFIG', 'Installation ID must be an owner-owned regular file.');
            if (st.size > MAX_BYTES)
                throw new BridgeError('CONFIG', 'Installation ID file is too large.');
        };
        check(fs.lstatSync(file));
        // Reject symlinks and avoid blocking if the file changes to a FIFO before open.
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
        check(fs.fstatSync(fd));
        const bytes = Buffer.alloc(MAX_BYTES + 1);
        const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
        const id = bytes.subarray(0, length).toString('utf8').trim();
        if (length > MAX_BYTES || !/^[0-9a-f]{32}$/.test(id))
            throw new BridgeError('CONFIG', 'Installation ID is malformed. Restore its private file or remove it before setup to generate a new ID.');
        if (secure) fs.fchmodSync(fd, 0o600);
        return id;
    } catch (e) {
        if (object(e) && e.code === 'ENOENT') return undefined;
        throw e;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

/** Inspect without creating an identity, modifying permissions or returning its value. */
export function installationStatus(config: InstallationConfig): { file: string; initialized: boolean } {
    return { file: installationIdPath(config), initialized: readId(config) !== undefined };
}

/** Crew-compatible uuid4().hex format, persisted only in this adapter's private state. */
export function ensureInstallationId(config: InstallationConfig): string {
    privateDir(config.stateDir);
    const existing = readId(config, true);
    if (existing !== undefined) return existing;

    const id = randomUUID().replaceAll('-', '');
    const file = installationIdPath(config);
    const temp = path.join(config.stateDir, `.${FILE_NAME}.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
        fd = fs.openSync(temp, 'wx', 0o600);
        fs.writeFileSync(fd, id, 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        try {
            // Like Crew's os.link: publish a complete file without replacing a winner.
            fs.linkSync(temp, file);
            return id;
        } catch (e) {
            if (!object(e) || e.code !== 'EEXIST') throw e;
            const winner = readId(config, true);
            if (winner !== undefined) return winner;
            throw new BridgeError('CONFIG', 'Installation ID disappeared during setup. Retry setup.');
        }
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
}
