# Source references and compatibility provenance

Inspected during implementation on 2026-09-24. GitHub source is primary evidence
for the referenced implementation, not a promise of permanent protocol stability.
The package is original implementation code; it does not vendor KiroCrew,
vibekit, pi-kiro-models, Pi, Fabric or Fovea code or credentials.

| Interface | Reference | Inspected file SHA |
|---|---|---|
| Native Pi provider example | https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/extensions/llama/provider.ts | `659ed1758358c01ec6440c6b6fc4ea91b8b68e97` |
| Pi transcript/message types | https://github.com/earendil-works/pi/blob/main/packages/ai/src/types.ts | `00483dd8b6259379b8f358fed3ff03df7913ae27` |
| Pi stream factory | https://github.com/earendil-works/pi/blob/main/packages/ai/src/utils/event-stream.ts | `c4f731d59bf192d6889d9b25ba3f3dd2b1b5a9e6` |
| Pi extension hooks/provider interface | https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts | `a51dab8b097d8a62844ccfb19da4e36200da388c` |
| Crew latest stable release, checked 2026-09-24 | https://github.com/kirodotdev/KiroCrew/releases/tag/v0.7.0 | Release/publication manifest source commit `ba797801739c0a0a94663837feb3c1b761fc0855` |
| Crew stable ACP name and advertised version | https://github.com/kirodotdev/KiroCrew/blob/ba797801739c0a0a94663837feb3c1b761fc0855/src/kiro_crew/acp/client.py#L267-L268 | Same stable release commit; `kirocrew` / `0.1.2` |
| Crew shared-runtime ACP identity | https://github.com/kirodotdev/KiroCrew/blob/ba797801739c0a0a94663837feb3c1b761fc0855/src/kiro_crew/acp/runtime.py#L962-L963 | Same stable release commit |
| Crew product version, separate from ACP version | https://github.com/kirodotdev/KiroCrew/blob/ba797801739c0a0a94663837feb3c1b761fc0855/src/kiro_crew/__init__.py#L10 | Same stable release commit; `0.7.0` |
| Crew default agent name | https://github.com/kirodotdev/KiroCrew/blob/ba797801739c0a0a94663837feb3c1b761fc0855/src/kiro_crew/agent.py#L384 | Same stable release commit |
| Crew core MCP name and version | https://github.com/kirodotdev/KiroCrew/blob/ba797801739c0a0a94663837feb3c1b761fc0855/src/kiro_crew/mcp_core.py#L2726-L2731 | Same stable release commit |
| Crew v3 protocol revision | https://github.com/kirodotdev/KiroCrew/blob/ba797801739c0a0a94663837feb3c1b761fc0855/src/kiro_crew/acp/harness/kas.py#L58-L60 | Same stable release commit |
| Crew installation-ID format and atomic creation | https://github.com/kirodotdev/KiroCrew/blob/ba797801739c0a0a94663837feb3c1b761fc0855/src/kiro_crew/beacon.py#L328-L419 | Same stable release commit; UUID4 lowercase hex, private temporary file and atomic hard link |
| Development ACP version and telemetry explanation | https://github.com/kirodotdev/KiroCrew/blob/e183a46e79c53109de3b24b0548e01a8dbef055c/src/kiro_crew/acp/client.py#L274-L285 | Development main, `0.8.0` package version; not the stable release identity |
| Kiro v3 relay/auth ownership | https://github.com/kirodotdev/KiroCrew/blob/main/src/kiro_crew/acp/kas_transport.py | `43b614e8bb86b2cf1ee2c1eef0389516c35122c3` |
| Injected custom agent format | https://github.com/kirodotdev/KiroCrew/blob/main/src/kiro_crew/acp/kas_agents.py | `9840cf56fd34b6dbd3d88b8f70c23721679a0643` |
| v3 permission rules | https://github.com/kirodotdev/KiroCrew/blob/main/src/kiro_crew/acp/kas_permissions.py | `9308bba92850bd55fda86d7bc4edaf84f9a62935` |
| MCP reported-state limitations | https://github.com/kirodotdev/KiroCrew/blob/main/src/kiro_crew/acp/mcp_session_report.py | `c735cfc1654106d723f52c315a88c9c99c65d297` |
| v3 config/steering methods | https://github.com/cplieger/vibekit/blob/main/internal/vibekit/methods.go | `6dfbf3450f3d3064796eafe9accdeac8111fc24c` |
| Model entitlement caveat | https://github.com/cplieger/vibekit/blob/main/internal/vibekit/model_entitlement.go | `3d85f1938bab2f114b0440d03e815d70e9a75511` |

General references:

- Pi provider docs: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md
- Pi package docs: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md
- Kiro ACP overview: https://kiro.dev/docs/cli/acp/
- ACP initialization and implementation information: https://agentclientprotocol.com/protocol/v1/initialization
- ACP config options: https://agentclientprotocol.com/protocol/v1/session-config-options
- Fabric Pi child semantics: https://github.com/monotykamary/pi-fabric/blob/main/docs/agents.md
- Fovea context/tool integration: https://github.com/monotykamary/pi-fovea/blob/main/README.md

Public documentation can lag a specific v3 release. The checked adapter therefore
has explicit gates and does not infer wire schemas from method names alone.
