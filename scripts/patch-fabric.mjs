import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Reviewed against 0.94.0. Never guess anchors or overwrite unknown upstream code.
const root = path.resolve(process.argv[2] || path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent'), 'npm/node_modules/pi-fabric'));
const policy = new URL('../dist/src/policy/fabric.js', import.meta.url);
if (!fs.existsSync(fileURLToPath(policy))) throw new Error('Run bun run build before patching Fabric.');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (pkg.version !== '0.94.0') throw new Error(`Fabric ${pkg.version} needs a fresh dispatch review; supported version is 0.94.0.`);
const specs = [
    ['dist/chunks/chunk-DBLT6J5B.js', '5fc387b85ae3b47531ea816eab6ad7347512af737bafe1460aa3b0d3ceba0f5b', 'guardFabricWorker, assertFabricProvider', [
        ['  async #spawn(request, signal) {', '  async #spawn(request, signal) {\n    request = guardFabricWorker(request, this.config);'],
        ['      if (runner === "pi") model = await this.#prepareModel(model);', '      if (runner === "pi") model = await this.#prepareModel(model);\n      assertFabricProvider(typeof model === "string" ? model.split("/")[0] : undefined);'],
    ]],
    ['dist/chunks/chunk-TGAVMUOS.js', 'cbc9b88752d7af968b10ce1eb3b57edaf3971d1e1f75db7a3eb4b12b038d9322', 'rejectFabricJev', [
        ['  async evaluate(request, signal) {', '  async evaluate(request, signal) {\n    rejectFabricJev();'],
    ]],
    ['dist/chunks/chunk-D4B4CCTA.js', '4e2db30c5683db13a04cb8f91799c475fe65bb046bcaa257f3c00108306e4b62', 'assertFabricProvider', [
        ['var completeWithPiProvider = async (context, model, request, options) => {', 'var completeWithPiProvider = async (context, model, request, options) => {\n  assertFabricProvider(model.provider);'],
    ]],
    ['dist/chunks/chunk-H6RSDEWW.js', '07222147cc0289b0e1c79700fb8a1e4f73399cce2d7c1f8008f1279b2f856957', 'applyFabricProfile', [
        ['  return normalizeFabricConfig(merged);', '  return normalizeFabricConfig(applyFabricProfile(merged));'],
    ]],
    ['dist/worker.js', '84e9ec917c0e59b64666717ebe03a74e34ee13f19826fd543eb7ca85ec7bc067', 'guardFabricWorker', [
        ['  const options = optionHelpers.parseWorkerOptions();', '  const options = guardFabricWorker(optionHelpers.parseWorkerOptions());'],
    ]],
];
const digest = (value) => createHash('sha256').update(value).digest('hex');
const plan = specs.map(([name, expected, imports, edits]) => {
    const file = path.join(root, name), backup = `${file}.kiro-acp-original`;
    const source = fs.readFileSync(fs.existsSync(backup) ? backup : file, 'utf8');
    if (digest(source) !== expected) throw new Error(`Unrecognized Fabric code: ${name}. No files changed.`);
    let patched = source;
    for (const [before, after] of edits) {
        if (patched.split(before).length !== 2) throw new Error(`Nonunique patch location in ${name}. No files changed.`);
        patched = patched.replace(before, after);
    }
    const header = `// pi-kiro-acp reviewed dispatch policy v1\nimport { ${imports} } from ${JSON.stringify(policy.href)};\n`;
    patched = patched.startsWith('#!') ? patched.replace(/^(#![^\n]*\n)/, `$1${header}`) : header + patched;
    const current = fs.readFileSync(file, 'utf8');
    if (current !== source && current !== patched) throw new Error(`Modified Fabric installation: ${name}. No files changed.`);
    return { name, file, backup, source, patched };
});
// Validate all files first; the extension refuses a partial patch without a matching manifest.
for (const item of plan) {
    if (!fs.existsSync(item.backup)) fs.writeFileSync(item.backup, item.source, { flag: 'wx', mode: 0o600 });
    if (fs.readFileSync(item.file, 'utf8') !== item.patched) {
        const temporary = `${item.file}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, item.patched, { mode: fs.statSync(item.file).mode & 0o777 });
        fs.renameSync(temporary, item.file);
    }
}
const manifest = { version: 1, fabricVersion: pkg.version, policy: policy.href, files: Object.fromEntries(plan.map(item => [item.name, digest(item.patched)])) };
const manifestPath = path.join(root, '.kiro-acp-policy.json');
fs.writeFileSync(`${manifestPath}.tmp`, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
fs.renameSync(`${manifestPath}.tmp`, manifestPath);
console.log(`Verified Kiro dispatch guards in Fabric ${pkg.version} (${plan.length} files). Restart Pi to activate.`);
