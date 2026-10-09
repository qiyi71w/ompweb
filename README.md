# ompweb

[![npm version](https://img.shields.io/npm/v/@kahme247/ompweb.svg?logo=npm&color=e05d44)](https://www.npmjs.com/package/@kahme247/ompweb)
[![node version](https://img.shields.io/node/v/@kahme247/ompweb.svg?logo=node.js&color=44cc11)](https://nodejs.org)
[![license](https://img.shields.io/github/license/kahme247/ompweb.svg?color=44cc11)](./LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/@kahme247/ompweb.svg?color=44cc11)](https://www.npmjs.com/package/@kahme247/ompweb)
[![GitHub stars](https://img.shields.io/github/stars/kahme247/ompweb.svg?logo=github)](https://github.com/kahme247/ompweb/stargazers)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/kahme247/ompweb/pulls)

[English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md)

Community: [Join the OMPWEB Discord](https://discord.gg/evqgGzRfM5)

A clean, modern web UI for the [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi) coding agent. It reads your local omp sessions and gives you a browser workspace to chat with the agent, browse projects, manage settings, and preview files.

![ompweb — live session demo](docs/demo.gif)

<details>
<summary>Screenshots (light / dark)</summary>

![ompweb — light theme](docs/screenshot-light.png)

![ompweb — dark theme](docs/screenshot-dark.png)

</details>

## Requirements

- [omp](https://github.com/can1357/oh-my-pi) installed and available on your `PATH` (or specified via `OMP_WEB_OMP_BIN`)
- Node.js `>= 22.19.0`

The **Steer** action on a queued follow-up requires an omp runtime with the `promote_queued_message` RPC command (not available in omp 18.1.16). Older runtimes report an error and leave the message queued as a follow-up; ompweb does not send a duplicate steering message.

Queue **Delete** and **Edit** additionally require `remove_queued_message`. Deletion is confirmed by OMP before the chip disappears; editing recalls text only after cancellation succeeds. Unsupported runtimes or messages that are no longer pending leave the queue unchanged and display a notice.

The queue panel shows omp's own queue (`queuedMessages` in `get_state` and `queue_update` events, omp 18.4.4 or later), so every device viewing a session sees the same queued messages. **Stop** moves the text of messages still waiting in the queue back into the composer instead of letting the agent run them; a steer the model already picked up through live steering still runs. Older omp runtimes show no queue panel, and Stop cannot take queued messages back.

## App installation behind authentication

To install the web app, sign in first and use your browser's installation menu.
The single manifest link requests `/api/manifest` with credentials; that endpoint
uses the existing web-password guard and private, revalidating caching. Its
192×192 and 512×512 PNG icons are embedded from the packaged assets because
Android's native installer fetches ordinary icon URLs without authentication
cookies. The app still launches at `/` with scope `/`.

Keep Cloudflare Access and application authentication enabled; no public
manifest exception or Access bypass rule is needed. This does not add offline
support. Local Chromium verification covered cookie-gated metadata with HTTP
icon URLs blocked (zero installability errors). The owner also confirmed that
installation on a physical phone works as expected behind Cloudflare Access.

Skill startup notices require an OMP runtime with `get_skill_diagnostics`,
`set_skill_startup_diagnostics`, and `skill_diagnostics_update`. Conflicts and
redundant installations appear above the composer when its OMP session starts;
an empty new-chat page does not start OMP just for diagnostics. **Details** shows
the resolved default, variants, identical copies, backing paths, sources, and
selection reason. The **×** button dismisses the notice for that session until
the diagnostic report changes. **Turn off** and **Settings →
Interface & Behavior → Skill startup notices** use OMP's persisted
`skills.showStartupDiagnostics` preference, not a separate browser setting.
**Settings → Extensions & Tools → Skills → View skill diagnostics** remains
available for a selected running session when notices are off. Inspection does
not resume stopped sessions. Missing support or no running session is unavailable,
not a clean result.

## Native settings and inheritance

Settings, **API Keys & Providers → OMP System → Retry & fallback**, and
**Native OMP registry** show values read from your installed OMP. The context
card identifies the binary/version, workspace, profile and target file.
Choose **Global / profile** or **Workspace** before editing. A saved override
is shown separately from the native effective value; **Restore inheritance**
removes that field from the selected layer rather than writing a guessed
default. Explicit `false`, `0` and empty lists are preserved.

Only the changed fields are saved. Unrelated terminal edits are retained. If
the same field changed elsewhere, review the fresh values and use **Refresh
native values** before retrying. Saving does not restart or stop sessions;
each field explains when its saved value is used. Session-only launch state
that a configuration query cannot reproduce is shown as unknown.

Unsupported settings and failed queries are read-only. OMP 18.8.4 does not
register Auto Thinking Source, Skill startup notices or Advisor for subagents;
their saved values are retained. The automatic-thinking ceiling is displayed
as a native constraint. Existing global `config.yaml` is updated in place.
OMP 18.8.4 ignores project `.omp/config.yaml`, so that project target remains
read-only and no `config.yml` is silently created; ordinary project
`.omp/config.yml` is writable. Invalid YAML is never overwritten.

**OMP model roles** starts in the native `modelRoleStorage` scope. Select the
target layer explicitly to edit a role or restore its inherited value. Custom
role names are retained. The selector keeps literal IDs such as `:free`, native
role aliases and routing suffixes; only native thinking selectors are split.
Provider preference order and fallback chains preserve their literal entries.
Complex path-scoped model/provider filters are preserved with a read-only reason.

**Custom providers** displays the actual models file being edited. Saves carry
individual field/entity intentions and the original baselines, retaining
unrelated external additions, unknown fields and YAML comments. Renames and
ordering retain model comment identity. A conflict requires refreshing and
reviewing the changed file; the editor never silently replays the draft.
Editing thinking levels keeps known efforts in their canonical order, including
after disabling and re-enabling a level. Future effort names keep their relative
order, and unrelated custom wire mappings and native options are preserved.
Stored credentials are not returned to the browser. Leave them untouched or
choose **Preserve stored credential**, enter a replacement, or explicitly
choose **Clear stored credential**. The model **Test** action only validates
registry resolution, using preserved credentials server-side; it sends no prompt.
Both `models.yml` and its `models.yaml` fallback are blocked from generic file
reads and downloads under the OMP configuration roots.

New sessions inherit the selected workspace's native model and thinking defaults.
The model shown before startup is a candidate, not an override; choosing a model
or a thinking level explicitly applies it only to that session. **Inherit native
default** differs from **Auto**: Auto asks OMP to choose effort, and the composer
shows the resolved native level after startup. Neither choice saves a future default.

Model and authentication queries use the same trusted workspace/profile launch
context as session startup. External settings, model files and Web agent environment
edits are picked up on the next applicable query or new process, without a watcher.
Utility replacement waits for active commands; an ongoing login keeps its original
context. Saving configuration does not stop an active session. Existing sessions
retain their spawn environment until restarted.

The existing workspace **Profile** launch setting selects that profile's session
list, settings, models, authentication and agents. Session URLs retain an opaque
root token, so refresh, reconnect and a Web server restart reopen the same native
storage even after the workspace's launch default changes. Bare legacy session
IDs explicitly select the Web server's default root; they never search other profiles.
The sidebar shows one selected context, not a cross-profile session inventory.

Root locators are stored atomically in `omp-web-session-roots.json` under the Web
server's own agent directory (`PI_CODING_AGENT_DIR`, or `~/.omp/agent`). Keep that
server storage with your deployment: unknown tokens are rejected. This metadata
contains only canonical agent/profile/session/blob locations, not credentials,
environment values, native session contents or a second settings store. Native
session IDs remain unchanged on disk. Custom agent roots, opt-in XDG data storage,
`PI_CODING_AGENT_SESSION_DIR` and validated `--session-dir` are supported; the CLI
directory takes precedence over the environment. `--no-session` remains nonpersistent.
Web archives use the sibling `archive/<session-directory-name>` directory, keeping
custom session directories separate and the normal `archive/sessions` layout intact.

An offline session reference restores its root and recorded workspace, not past
unrecorded runtime overrides. Those effective settings remain **Unknown**. Model
catalog/filter management uses the independently obtained native configuration
query value, not an assertion about the running session's effective state.

**Extensions & Tools → MCP** separates file inventory from the selected native
session's observations. Project loading uses the same workspace/profile context;
turning it off leaves the project file editable. Viewing or refreshing inventory
does not start a session. **Start this session and query MCP** is the explicit
action for an offline session. OMP 18.8.4's compact RPC list reports configured
servers, not connection or loading evidence, so those states remain **Unknown**.

Project MCP edits submit only changed fields or explicit create/rename/delete
intentions. Unrelated external edits and unknown JSON fields are preserved;
same-field/entity changes return a conflict without replaying the old edit.
Select the latest server or refresh before editing again. `env` and `headers`
have separate **Preserve**, **Replace**, and **Clear** controls; saved credentials
are never returned. User-level and external-provider files remain read-only.
Saving does not reconnect existing sessions. Start a new session to load changes.
MCP files remain strict JSON: invalid JSON, including comments, is not overwritten.

Signing in authenticates the provider but does not alter native model filters.
An authenticated, disabled provider remains visibly disabled under **Composer
model picker**. Its **Enable in OMP** action edits the saved disabled-provider
list in the displayed scope with conflict protection. For inherited filters,
select the scope containing the saved list; complex lists remain read-only.
Saving refreshes model queries without claiming to change running sessions.

**Safety & Approvals** lists native `tools.approval` dictionary members,
including Bash, custom tools and MCP tools. Enter the exact tool name or native
`policyKey` and choose **Prepare entry** to obtain its current baseline without
writing a policy. Then select `allow`, `prompt` or `deny`, or use **Restore
inheritance** to remove only that layer's entry. Dots, colons and other
punctuation stay part of the literal name. An inherited entry is distinct from
an explicit `prompt`; OMP resolves its tool tier, policy-key fallback and
approval mode when the call executes.

The preserved legacy `extension` entry is a literal dictionary member, not a
grant for every extension tool. Tool, login and editor confirmations remain
interactive; only your response answers a pending Web confirmation. Saved
policy changes take effect in new sessions and do not stop an active session.

**Extensions & Tools → Skills / Plugins** follows the selected session's
trusted cwd, profile and environment, even if workspace launch defaults change.
Skills distinguishes files installed on disk, native discovery and unknown
active-session loading. A failed or unavailable native list is labeled as a
nonauthoritative fallback; confirmed disabled sources stay excluded from that
discovery. Installing into a disabled source does not enable or load it.

Skill search uses skills.sh and installation uses `npx skills`, independently
of native `skills.registryUrl`. Plugin and registry skills are visible without
granting permission to edit their files. User-owned hide toggles preserve
unrelated frontmatter and return a fresh view on conflicting edits; review it
before retrying. Plugin operations use native `omp plugin`, refresh related
skill/agent inventories, and do not automatically restart active sessions.

Web speech transcription uses `OMP_WEB_STT_ENDPOINT`, `OMP_WEB_STT_KEY` and
`OMP_WEB_STT_MODEL`; browser speech synthesis supplies TTS. Sound, layout and
completion entry preferences are Web controls, separate from native terminal
settings and the `spelling.autocomplete` engine. Web session auto-resume is
also separate from native `autoResume`.

**Agents** shows project templates before user templates, extension/npm-link
plugins, marketplace plugins and bundled defaults, with source and shadowed
paths. OMP 18.8.4 has no read-only complete agent-inventory command; the page
labels its filesystem inventory and unknown session-only discovery coverage.
Bundled caches are keyed by binary/version identity. Unpacking never replaces
an existing user template.

Enable/disable writes native `task.disabledAgents`, including for bundled
agents. Legacy template `enabled: false` is displayed but preserved, not
converted. Template edits save only explicit fields with conflict checks,
preserving comments and unknown metadata. Clearing thinking removes both
`thinkingLevel` and its `thinking` alias. An explicitly empty Tools field saves
`tools: []`; native OMP still adds `yield`. Restore inheritance removes the key.

Native dispatch controls expose model overrides and effort settings separately
from template declarations, plus read-only concurrency and recursion limits.
Advanced dispatch settings remain managed with `omp config list --json`.
Template parsing does not prove which model ran: the subagent transcript uses
native progress's resolved model and shows unknown when that evidence is absent.
Writes share in-process file serialization and atomic replacement, not a
cross-process transaction with terminal editors.


## Quick Start

**Run directly without installing:**

```bash
npx @kahme247/ompweb@latest
```

or
```bash
nix run github:kahme247/ompweb
```

**Or install globally:**

```bash
npm install -g @kahme247/ompweb
ompweb
```

Open [http://127.0.0.1:30177](http://127.0.0.1:30177) in your browser.

### CLI Options

```bash
ompweb --port 8080                         # Custom port
ompweb --hostname 0.0.0.0                  # Listen on network
ompweb --password "your-password"          # Enable password protection
ompweb --no-open                           # Don't auto-open the browser
ompweb --install-tray                      # Install Windows System Tray service & Desktop shortcuts
ompweb --uninstall-tray                    # Uninstall Windows System Tray service & shortcuts
ompweb --tray                              # Start background System Tray manager
ompweb systemd install                     # Install Linux systemd user service
ompweb --help                              # Show help
ompweb --version                           # Show version
```

### Run as a Windows Service (System Tray)

Install ompweb as a Windows background service with a system tray icon and autostart at login:

```bash
ompweb --install-tray
```

Manage it from **Settings → System & Updates → Windows Background Service**, or via CLI:

```bash
ompweb --tray          # Start the tray manager
ompweb --uninstall-tray
```

Shortcuts are created on the Desktop and Start Menu. The service restarts automatically and shows the current port and status in the tray.

### Run as a macOS Service (launchd)

Install ompweb as a launchd user agent that starts at login and restarts on crash:

```bash
npx --yes @kahme247/ompweb@latest ompweb-launchd install
```

Manage it with:

```bash
npx --yes @kahme247/ompweb@latest ompweb-launchd status      # Show service state
npx --yes @kahme247/ompweb@latest ompweb-launchd uninstall   # Stop and remove
```

The service runs `npx --yes @kahme247/ompweb@latest`; pass a package spec to pin a
version, e.g. `ompweb-launchd install @kahme247/ompweb@0.3.6`. All
[environment variables](#environment-variables) are read at install time and baked
into the plist, plus `OMP_WEB_PKG` (package spec, same as the positional argument).
As a service, the browser is **not** auto-opened by default — install with
`OMP_WEB_NO_OPEN=0` to restore that.

```bash
OMP_WEB_PASSWORD=secret npx --yes @kahme247/ompweb@latest ompweb-launchd install
```

When binding to a non-loopback host, require authentication (`OMP_WEB_PASSWORD`
or equivalent access control) and HTTPS through a trusted reverse proxy or VPN.
Never expose the unauthenticated web UI or send its password/session cookie over
plaintext HTTP.

Logs go to `~/Library/Logs/ompweb/ompweb.log` and the plist lives at
`~/Library/LaunchAgents/com.kahme247.ompweb.plist` (mode 600; a configured
password is stored there in plain text).

### Run as a Linux Service (systemd)

Install ompweb as a systemd **user** service that starts at login and restarts
on crash:

```bash
npx --yes --package=@kahme247/ompweb@latest ompweb-systemd install
```
The installer creates `~/.omp/agent/web-service.env` automatically with mode
`600`; no manual file creation is required. The explicit `--package` form makes
`npx` run the systemd executable from the selected package.

To bind the service to all IPv4 interfaces for LAN access, set a password while
installing:

```bash
OMP_WEB_HOSTNAME=0.0.0.0 OMP_WEB_PASSWORD='change-me' \
  npx --yes --package=@kahme247/ompweb@latest ompweb-systemd install
```

Manage it with:

```bash
npx --yes --package=@kahme247/ompweb@latest ompweb-systemd status    # Show service state
npx --yes --package=@kahme247/ompweb@latest ompweb-systemd restart   # start / stop / restart
npx --yes --package=@kahme247/ompweb@latest ompweb-systemd uninstall # Stop and remove
```

The service runs the locally installed `ompweb` binary resolved at install time
(override with `OMP_WEB_SYSTEMD_BIN`). Runtime configuration lives in
`~/.omp/agent/web-service.env` — the tray (or any editor) can change the port,
hostname, and password there and just restart the service; no reinstall needed.
Install-time [environment variables](#environment-variables) are baked into
that file. As a service, the browser is **not** auto-opened by default. The
unit lives at `~/.config/systemd/user/ompweb.service` and logs go to the
journal:

```bash
journalctl --user -u ompweb -f
```

On a headless server, enable user lingering if the service must keep running
after the last login session ends:

```bash
loginctl enable-linger "$USER"
```

### Linux System Tray (KDE Plasma and compatible)

On Linux, `ompweb-tray` registers a StatusNotifierItem tray icon with a context
menu: open the web UI, copy its URL, start/stop/restart the systemd service,
view logs, expose the web UI to the network, change the port, set the web
password, toggle autostart, and quit the tray.

```bash
npx --yes @kahme247/ompweb@latest ompweb-tray --install      # Icons + autostart + start tray
npx --yes @kahme247/ompweb@latest ompweb-tray --status       # Tray and service status
npx --yes @kahme247/ompweb@latest ompweb-tray --uninstall    # Remove autostart, stop tray
```

**Expose to Network** rebinds the service from `127.0.0.1` to `0.0.0.0` so the
web UI is reachable from your LAN or VPN (e.g. Tailscale). Leaving loopback
requires a web password — the tray prompts for one via `kdialog`/`zenity` when
needed. **Change Port…** and **Set Web Password…** edit
`~/.omp/agent/web-service.env` and restart the service. When binding to a
non-loopback host, use HTTPS through a trusted reverse proxy or VPN for remote
access.

"Start with Plasma" in the tray menu toggles a desktop autostart entry at
`~/.config/autostart/ompweb-tray.desktop`. Requires a running StatusNotifierItem
host (KDE Plasma, and most Wayland/X11 desktops).

## Features

- **Interactive Chat**: Real-time streaming conversation with your local `omp` agent — tool calls, thinking levels, token counts, cost, context gauge, queue controls, and interrupt & retry.
- **Message Copy**: Copy user messages and completed assistant replies as rendered plain text or original Markdown using the buttons below each message. Thinking, tool output, and message controls are excluded. Oversized messages that use the raw-text viewer copy their full source in either format.
- **Queue Deletion Confirmation**: Preview and confirm before cancelling queued follow-ups or steered messages in OMP. Requires native `remove_queued_message` support; already-delivered messages cannot be recalled.
- **Session Management**: Browse past conversations by project, fork sessions, branch within a session, archive/restore, import session files, and deep-link via URL.
- **Draft Recovery**: Unsent text stays scoped to its conversation or new-session workspace and is restored after Back/Forward navigation or reload in the same tab when browser storage is available (up to 50 drafts). Images and file attachments remain in memory only.
- **Live Plans & Subagents**: Collapsible panels pinned above the composer track live todo phases and running subagents (status, tool, retries, tokens/cost, nested tasks) with transcript dialogs and history recovery.
- **Tool Preset Picker**: A browser-local preference for new sessions: `none` disables tools; `default` selects `read,bash,edit,write`; `full` inherits the native toolset without adding a limiting list. Stored in localStorage, not native defaults; changing it does not replace a running session's tools.
- **File Explorer & Previews**: Browse workspaces side-by-side with chat; preview code, markdown, Mermaid, images, audio, PDFs, and diffs with allow-listed access.
- **Git Worktree Support**: Create, switch, and manage Git worktrees directly from the sidebar; sessions and file roots stay grouped by project.
- **Usage & Analytics**: Dashboard in **Settings → Usage** for tokens, costs, cache savings, and breakdowns by provider / model / day / project with SQLite persistence.
- **Windows System Tray & Service**: Background service, tray icon, logon autostart, and Desktop/Start Menu shortcuts (Windows).
- **macOS launchd Service**: LaunchAgent that starts at login, restarts on crash, and logs under `~/Library/Logs/ompweb`.
- **Linux systemd Service & Tray**: User service that starts at login and restarts on crash, plus a StatusNotifierItem tray icon with service controls (KDE Plasma and compatible desktops).
- **Web-based Settings** (8 tabs): Interface & Behavior, Safety & Approvals, AI Model Defaults, API Keys & Providers, Usage, Agent & Intelligence (advisor, memory, compaction), Agents, Extensions & Tools (MCP, skills, plugins), System & Updates.
- **Slash Commands & Shortcuts**: Quick prompts (`/plan`, `/review`, `/fix`, `/test`, etc.), `⌘K` / `Ctrl+K` palette, and model/reasoning cycling.
- **UI Themes & Localization**: Warm paper light/dark themes plus an omp.sh-inspired midnight (`omp`) theme, chat font size & interface scale, with full English, Chinese (简体中文), and Japanese (日本語) translations.

## Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `PORT` | Server port | `30177` |
| `OMP_WEB_HOSTNAME` | Server bind host | `127.0.0.1` |
| `OMP_WEB_PASSWORD` | Optional password for web login | _None (auth disabled)_ |
| `OMP_WEB_NO_OPEN` | Set to `1` to prevent auto-opening browser | `0` |
| `OMP_WEB_DISABLE_AUTOUPDATE` | Set to `1` to disable update checks and in-app updates; restart after changing | `0` |
| `OMP_WEB_OMP_BIN` | Path to `omp` binary if not on `PATH` | _auto-detected_ |
| `OMP_WEB_DEV_ORIGIN` | Additional allowed hostname for the development server (no scheme or port); ignored in production | _None_ |
| `PI_CODING_AGENT_DIR` | Custom omp agent directory | `~/.omp/agent` |
| `OMP_WEB_STT_ENDPOINT` | OpenAI-compatible transcription endpoint URL | _None (disabled)_ |
| `OMP_WEB_STT_KEY` | Optional API key for the STT endpoint | _None_ |
| `OMP_WEB_STT_MODEL` | Optional model name for the STT endpoint | _None_ |

## Development

```bash
git clone https://github.com/kahme247/ompweb.git
cd ompweb
npm install
npm run dev
```

The dev server runs at [http://127.0.0.1:30178](http://127.0.0.1:30178).

The development server allows loopback and RFC1918 private IPv4 origins
(`10.0.0.0/8`, `172.16.0.0/12`, and `192.168.0.0/16`). When using a tunnel
or reverse proxy with a custom hostname, set it without editing `next.config.ts`:

```bash
OMP_WEB_DEV_ORIGIN=dev.example.com npm run dev
```

For a persistent setup, set the variable in your local environment or service
configuration and restart the dev server. This does not change the bind address
or enable authentication. Next.js hostname patterns cannot express IPv6 CIDRs;
a private IPv6 origin must be supplied explicitly (for example, `[fd00::1]`).

### Checks

```bash
npm run typecheck   # Type check (TypeScript)
npm run lint        # ESLint
npm test            # Run test suite
```

> **Note**: Do not run `npm run build` during local dev — it populates `.next/` and can break `npm run dev`.

## License & Credits

- Forked from [agegr/pi-web](https://github.com/agegr/pi-web) (MIT) and adapted for [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi).
- Released under the [MIT License](./LICENSE).
