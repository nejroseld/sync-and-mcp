# Sync and MCP

**English** | [Русский](README.ru.md)

An Obsidian plugin that syncs your vaults between devices with end-to-end encryption and gives AI assistants (Claude and other MCP clients) controlled access to the notes you choose. It works with your own server, [sync-and-mcp-backend](https://github.com/nejroseld/sync-and-mcp-backend).

## Features

- **End-to-end encrypted sync.** Files are encrypted on the device with rclone crypt before upload. The server stores only ciphertext and never sees the encryption password.
- **Several vaults in one.** Sync the whole vault or individual folders, each with its own server vault and password.
- **Many devices.** Add a device by scanning a QR code; each device has its own token and can be disconnected separately.
- **MCP access for AI assistants.** Choose with rules which notes an assistant can see. The plugin publishes them to the server, and Claude, ChatGPT or any other MCP client can read and search them.
- **Edits suggested by AI.** An assistant with write access proposes changes; the plugin applies them locally only when the rules allow it and the note has not changed in the meantime. Conflicts never overwrite your files.
- **Accounts and invitations.** A server administrator invites people with a ready-to-forward message; everyone manages their own vaults, devices and assistants.
- **Desktop and mobile.** Works on Windows, macOS, Linux, Android and iOS.

## Privacy model

Regular sync and AI access use different privacy models:

- Synced files reach the server **encrypted**.
- Notes you allow for AI are published to the server **in plain text**, so the server can index them and hand them to MCP clients.

AI access is off by default. Nothing is published until you turn it on and pick the notes in the rules.

## Requirements

- Obsidian 1.4.4 or later.
- A running [sync-and-mcp-backend](https://github.com/nejroseld/sync-and-mcp-backend) server, either your own or one where an administrator has invited you.

## Installation

The plugin is not yet listed in the Obsidian Community plugins directory. Until then, use one of these options.

**With BRAT (recommended).** Install [BRAT](https://github.com/TfTHacker/obsidian42-brat), run the command "BRAT: Add a beta plugin for testing" and enter `nejroseld/sync-and-mcp`. BRAT keeps the plugin up to date.

**Manually.** Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/nejroseld/sync-and-mcp/releases/latest), put them into `<vault>/.obsidian/plugins/sync-and-mcp/` and enable "Sync and MCP" in Settings → Community plugins. When updating, replace only these three files and keep `data.json`: it holds your local settings and secrets.

## Getting started

On first launch the plugin opens a step-by-step welcome window:

1. Choose how to connect:
   - "I have an invitation": paste the whole message from the administrator, and the plugin finds the server address and the code;
   - "Sign in to my account";
   - "Copy setup from another device": scan the QR code shown on a device that is already set up.
2. Pick a server vault or create one. A new account is offered to create its first vault right away.
3. Set the encryption password. It is separate from the account password and must be the same on every device.
4. Decide whether AI assistants get access to this vault.

The first sync starts automatically when the wizard finishes.

Settings are split into tabs: Overview, Sync, Folders, Devices, AI and Server. The status bar shows the sync state; click it for quick actions.

## Connecting an AI assistant

Open Settings → Sync and MCP → AI → Assistants and click "Connect an assistant". Give it a name, pick the vaults and the access level ("Read and search" or "Read, search and suggest edits"). The plugin then shows a ready command for Claude Code, a config for Claude Desktop and the `…/mcp` address with a header for any other MCP client. The access key is shown only once; "Disconnect" revokes it.

## Documentation

The full user guide (in Russian) is in [docs/PLUGIN.md](docs/PLUGIN.md). It covers every settings tab, AI access rules, administration and troubleshooting.

For developers: [architecture](docs/ARCHITECTURE.md), [code map](docs/CODEMAP.md), [HTTP API contract](docs/API.md).

## Building from source

```bash
npm install
npm run typecheck
npm test
npm run build
```

The build produces `main.js` in the repository root. To publish a release, set the same version in `manifest.json`, `package.json` and `versions.json`, then push a tag equal to the version (for example `0.1.0`, without `v`). The GitHub workflow builds the plugin and creates a draft release with `main.js`, `manifest.json` and `styles.css`.

## License

[GNU GPL v3](LICENSE). The sync engine in `src/sync/` is derived from [Remotely Save](https://github.com/remotely-save/remotely-save) (Apache License 2.0); see [NOTICE](NOTICE) for details.
