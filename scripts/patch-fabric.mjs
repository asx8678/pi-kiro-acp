import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkedPatch, digest } from './checked-patch.mjs';
import { FABRIC_POLICY_VERSION, REVIEWED_FABRIC_VERSION, FABRIC_PATCH_FILES } from '../dist/src/policy/fabric.js';

// Reviewed against 0.96.3. Never guess anchors or overwrite unknown upstream code.
const root = path.resolve(process.argv.slice(2).find(arg => arg !== '--check') || path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent'), 'npm/node_modules/pi-fabric'));
const policy = new URL('../dist/src/policy/fabric.js', import.meta.url);
const previousApprovalEdits = [
    ['var completeWithPiProvider = async (context, model, request, options) => {', 'var completeWithPiProvider = async (context, model, request, options) => {\n  assertFabricProvider(model.provider);'],
    ['provider.streamSimple(model, request, options)', 'provider.streamSimple(model, normalizeContext(request), options)'],
    ['    const auth = await context.modelRegistry.getApiKeyAndHeaders(model);', '    assertFabricProvider(model.provider);\n    const auth = await context.modelRegistry.getApiKeyAndHeaders(model);'],
];
const specs = [
    ['46b5c4f122647edc00fd9c8735350fc3a03c91831a12523b2cd9f7f23bd747f7', 'guardFabricWorker, assertFabricProvider', [
        ['  async #spawn(request, signal) {', '  async #spawn(request, signal) {\n    request = guardFabricWorker(request, this.config);'],
        ['      if (runner === "pi") model = await this.#prepareModel(model);', '      if (runner === "pi") model = await this.#prepareModel(model);\n      assertFabricProvider(typeof model === "string" ? model.split("/")[0] : undefined);'],
        ['  async #relaunch(managed, record, resume) {\n    try {', '  async #relaunch(managed, record, resume) {\n    try {\n      guardFabricWorker(managed, this.config);'],
        ['        const model = await this.#prepareModel(managed.model);', '        const model = await this.#prepareModel(managed.model);\n        assertFabricProvider(typeof model === "string" ? model.split("/")[0] : undefined);'],
    ]],
    ['cbc9b88752d7af968b10ce1eb3b57edaf3971d1e1f75db7a3eb4b12b038d9322', 'rejectFabricJev', [
        ['  async evaluate(request, signal) {', '  async evaluate(request, signal) {\n    rejectFabricJev();'],
    ]],
    ['4e2db30c5683db13a04cb8f91799c475fe65bb046bcaa257f3c00108306e4b62', 'assertFabricProvider', [
        ['var completeWithPiProvider = async (context, model, request, options) => {', 'var completeWithPiProvider = async (context, model, request, options) => {\n  assertFabricProvider(model.provider);'],
        ['  if (provider) return provider.streamSimple(model, request, options).result();', `  if (model.provider === "kiro-acp") {
    const completionProvider = typeof provider?.completeStructured === "function" ? provider : context.modelRegistry.getRegisteredNativeProvider?.(model.provider);
    if (typeof completionProvider?.completeStructured !== "function") throw new Error("Kiro approval completion requires the updated ACP provider. Restart Pi.");
    return completionProvider.completeStructured(model, normalizeContext(request), options);
  }
  if (provider) return provider.streamSimple(model, normalizeContext(request), options).result();`],
        // Kiro validates exact advertised effort values. The generic classifier's
        // hardcoded "minimal" is not a supported effort on every Kiro model.
        ['...model.reasoning ? { reasoning: "minimal" } : {},', '...model.reasoning && model.provider !== "kiro-acp" ? { reasoning: "minimal" } : {},'],
        ['    const auth = await context.modelRegistry.getApiKeyAndHeaders(model);', '    assertFabricProvider(model.provider);\n    const auth = await context.modelRegistry.getApiKeyAndHeaders(model);'],
    ]],
    ['7bd7589f12db742cad796eb7cd6dff7c0dae4e4f07ba9369423106f27109c4a0', 'applyFabricProfile', [
        ['  return normalizeFabricConfig(merged);', '  return normalizeFabricConfig(applyFabricProfile(merged));'],
    ]],
    ['a75e56f1dd89f6dbe67dae763cdf199d4828b00b861802f4df21929ba257a335', 'guardFabricWorker', [
        ['  const options = optionHelpers.parseWorkerOptions();', '  const options = guardFabricWorker(optionHelpers.parseWorkerOptions());'],
    ]],
].map(([sha256, imports, edits], i) => {
    const header = version => `// pi-kiro-acp reviewed dispatch policy v${version}\nimport { ${imports} } from ${JSON.stringify(policy.href)};\n${i === 2 ? 'import { normalizeContext } from "@earendil-works/pi-ai";\n' : ''}`;
    return { name: FABRIC_PATCH_FILES[i], sha256, edits, header: header(FABRIC_POLICY_VERSION),
        previous: [{ header: header(2), edits: i === 2 ? previousApprovalEdits : edits }],
    };
});
checkedPatch({ root, packageName: 'pi-fabric', packageVersion: REVIEWED_FABRIC_VERSION, specs,
    manifestName: '.kiro-acp-policy.json', check: process.argv.includes('--check'),
    metadata: { version: FABRIC_POLICY_VERSION, fabricVersion: REVIEWED_FABRIC_VERSION, policy: policy.href, policyHash: digest(fs.readFileSync(fileURLToPath(policy))) },
});
console.log(`Verified Kiro dispatch guards in Fabric ${REVIEWED_FABRIC_VERSION} (${specs.length} files). Restart Pi to activate.`);
