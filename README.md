![pi-kiro-acp — connected coding tools](docs/assets/readme-banner-v2.png)

**Pi + Kiro, one coding workspace.** An ACP integration with local tools, session controls and a usage dashboard.

- **Connected workflow** — Pi tools, with optional Fabric workers and Fovea context.
- **Visible activity** — reported credits, token counts and session history.
- **Private setup** — a unique local installation ID, preserved across updates and excluded from Git and packages.

## Get started

Requires **Node.js 22.16+**, **Pi**, and **Kiro CLI with ACP support**. Compiled files are included.

```sh
git clone https://github.com/asx8678/pi-kiro-acp.git
cd pi-kiro-acp
kiro-cli login
node dist/src/cli.js init --experimental
node scripts/install-pi.mjs
node dist/src/cli.js doctor
pi
```

Already configured? Skip `init`. To update, pull the latest code, rerun the installer and restart Pi.
The installer also synchronizes installed Fabric with the bridge's reviewed version,
pins it in Pi settings and the package manifest, and verifies its routing patch.
After reinstalling Fabric or rebuilding bridge policy code, run `bun run repair:fabric`
and restart Pi. This preserves your other Pi settings and refuses unrecognized patch sources.

To make repairs automatic when starting Pi, run once (zsh or bash):

```sh
bun run install:launcher
```

Open a new terminal, then use `pi` normally. The launcher checks Fabric before Pi
loads extensions, repairs recognized patches, and restores/pins the bridge's
reviewed Fabric version if it drifted. A healthy start makes no changes or package
downloads. Upstream Pi stays intact; shell configuration is backed up. Unsupported
Fabric releases are downgraded to the reviewed version, never automatically approved.
Offline starts can repair local patches but refuse required package downloads.
Already running Pi sessions/workers still need restarting after maintenance.
Launches that bypass the managed executable retain the existing manual repair check.

## Inside Pi

| Command | Action |
|---|---|
| `/model` | Select a Kiro entry |
| `/usage` | Open the credit and activity dashboard |
| `/kiro doctor` | Check the connection |
| `/kiro status` | Inspect session status |
| `/kiro cancel` | Cancel active work |

[Configuration](docs/operations.md) · [Privacy](SECURITY.md) · [Compatibility](docs/compatibility.md) · [Development & tests](docs/testing.md)

*Experimental · [MIT license](LICENSE) · Independent community project*
