<div align="center">

# pi-self-update

**Let pi modify itself — live, inside its own session.**

Write files → validate → hot reload / cold restart → verify → rollback.

[![Version](https://img.shields.io/github/v/tag/Zefyr1120/pi-self-update?label=version&sort=semver)](https://github.com/Zefyr1120/pi-self-update/tags)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![pi package](https://img.shields.io/badge/pi-package-blueviolet)](https://pi.dev/packages)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#requirements)
[![README: 中文](https://img.shields.io/badge/README-中文-red)](README.zh-CN.md)

</div>

---

## Why

A coding agent that can author its own extensions, prompts, skills, settings — or patch its own dependencies — still has to **get that code into its own runtime**. Out of the box that means: finish the edit, quit, start again, find out it was broken.

`pi-self-update` closes the loop from inside the session:

| Without | With |
|---|---|
| write file → quit pi → restart → hope | `pi_self_apply` → validated → reloaded → `✅ 自更新已生效` |
| a broken extension → dead session | validated **in a subprocess first**; nothing half-broken is left on disk |
| restart lands in a *new* window, session lost | restart re-uses the **same terminal and session** — no new window |
| "did my change actually load?" | `pi_self_status` compares the running instance's stamp against the file on disk |

## Features

- **5 tools** — `pi_self_status`, `pi_self_reload`, `pi_self_apply`, `pi_self_rollback`, `pi_self_restart`
- **2 commands** — `/pi-reload-runtime`, `/pi-restart`
- **Subprocess validation** — real `jiti` import plus a stub run of the extension factory; catches syntax errors, unresolvable imports and top-level crashes *before* they can touch your session
- **Write allow-list** — `~/.pi/agent/**` and the current project only; pi's install directory is refused (upgrades would overwrite it)
- **Journaled updates** — every apply is recorded, so "is the running instance the code on disk?" always has an answer
- **Idle-window aware reload** — reloads are queued, retried with backoff (20/40/60/90 s) and dispatched the moment the session is actually idle
- **Restarts that survive a stuck shutdown** — `--force-after 90` force-completes a restart if the graceful exit never lands
- **Native Windows terminal takeover** — the resume command is *typed into the original console* (`WriteConsoleInput`, ConPTY / Windows Terminal included): same tab, same session, no extra window
- **Cross-platform** — the tools work on Linux/macOS too; the terminal-injection path is Windows-specific and falls back to spawning with inherited stdio elsewhere

## Install

```bash
# from git (pinned ref recommended)
pi install git:github.com/Zefyr1120/pi-self-update@v0.1.3

# project scope: written to <project>/.pi/settings.json (shareable with your team)
pi install -l git:github.com/Zefyr1120/pi-self-update@v0.1.3

# try it for one run only
pi -e git:github.com/Zefyr1120/pi-self-update@v0.1.3

# from a local checkout (no copy — the checkout *is* the running copy)
pi install /absolute/path/to/pi-self-update
```

After the first load, run **`/reload` once** (or restart pi): extension code can only enter the runtime at startup or reload.

<details>
<summary><b>Global vs project scope</b></summary>

| Scope | Command | Written to | Applies to |
|---|---|---|---|
| Global (default) | `pi install <src>` | `~/.pi/agent/settings.json` | every project on this machine |
| Project | `pi install -l <src>` | `<project>/.pi/settings.json` | that project only (auto-installed for teammates once the project is trusted) |

Switch scopes with `pi remove <src>` + install again. Do **not** install the same package in both scopes — commands would be registered twice (the duplicate gets a `:2` suffix) and pending-reload state would split. Relative paths in a project settings file resolve against that file, which makes `pi install -l ../pi-self-update` a nice way to vendor it.

</details>

## Quick start

A real acceptance run — a new extension file (`probe.ts`, exposing one tool) applied from inside the session:

```text
> pi_self_apply(files=[{path: "~/.pi/agent/extensions/probe.ts", content: …}],
                expected_tools=["probe_tool"], note="add probe tool")

✅ 已写入并校验通过 1 个文件
校验结果：导入通过；stub 试跑通过（registrations: registerTool）

> pi_self_status()

内存戳 stamp ：a52323c52b5ef37b（pid 14632 于 2026-09-15T19:00:38.004Z 加载）
磁盘哈希     ：a52323c52b5ef37b
生效判定     ：✅ 当前实例就是磁盘上的最新代码
已注册工具   ：16 个
```

```
~/.pi/agent/state/pi-self-update/pi-self-update.log
[19:00:20.864Z] queue: add probe tool
[19:00:38.004Z] module loaded pid=14632 stamp=a52323c52b5ef37b
[19:00:38.072Z] session_start reason=reload journal=reload
[19:00:38.073Z] verify: landed=true missing=[] attempts=0 isIdle=true
[19:00:38.142Z] command: ctx.reload() 已返回
```

> `19:00:20` queue → `19:00:38` applied: the reload waited for an idle window (see below), then verified itself and cleared the journal.

## How it works

### Three layers

| Layer | Covers | Trigger |
|---|---|---|
| **L0 — instant** | `pi.registerTool()` called at runtime, `models.json` | nothing to do |
| **L1 — hot reload** | extensions, skills, prompt templates, themes, `AGENTS.md`, `settings.json`, keybindings | `/reload` while idle, or a queued `pi_self_apply` |
| **L2 — cold restart** | pi's own version, `node_modules` patches, `trust.json`, process environment | `pi_self_restart` |

### Why a reload can be "queued but not applied"

pi's interactive reload goes through `handleReloadCommand()`, which **refuses silently** while the session is streaming:

```js
if (this.session.isStreaming)  { showWarning("Wait for the current response to finish before reloading."); return; }
if (this.session.isCompacting) { showWarning("Wait for compaction to finish before reloading.");     return; }
```

Extensions get no callback, no error — a refused reload looks exactly like a successful one from the outside. So this package:

1. writes a **journal** entry for every apply (`~/.pi/agent/state/pi-self-update/journal.json`),
2. keeps trying: `agent_settled` (fires late, once the session is truly idle), an opportunistic dispatch on `input`/`turn_start` when `ctx.isIdle()`, and a backoff chain (20/40/60/90 s),
3. decides "did it land?" by comparing **its own load time** with the journal timestamp — not by "did some file change", which is wrong when the edit lands in a *different* extension file,
4. **never rolls back on its own**. An earlier version did, and it deleted the not-yet-loaded file before the reload got its turn. Rollback is explicit: `pi_self_rollback`.

### The restart path (Windows)

Getting the *same terminal* back is the hard part:

| Approach | Result |
|---|---|
| `spawn(detached: false)` | killed together with pi (libuv puts it in a job object) |
| `spawn(detached: true)` | survives, but libuv turns it into `CREATE_NEW_CONSOLE` — a second window appears (`windowsHide` does not stop it) |
| **`cmd /d /c start /b "…" node pi-relaunch.mjs`** | survives *and* no new console — the one combination that works |

The relauncher then waits for pi's pid to disappear and **types the resume command into the original console input buffer** (`WriteConsoleInput`, via `bin/pi-coninject.ps1`). The handle is inherited from pi's stdin (fd0) — a console handle stays writable across consoles — so the shell sitting at the prompt executes `pi --session <id>` itself. The new pi is a child of the *original* shell: same window, same tab, session continues.

Fallbacks: attach to the shell's console by pid → new window (`--mode window`) → manual command in the log.
`--force-after 90` force-ends pi if a requested graceful shutdown never lands.

> POSIX note: `--mode tty` spawns with inherited stdio and is best-effort — the terminal still belongs to the original shell, so input is shared. The reliable paths there are `/reload` and restarting manually.

### State & logs

```
~/.pi/agent/state/pi-self-update/journal.json        pending reload record (verify / rollback source)
~/.pi/agent/state/pi-self-update/pi-self-update.log  trace: queue / dispatch / command / verify
~/.pi/agent/state/pi-self-update/pi-relaunch.log     restart chain
```

## Safety

1. **Allow-list**: writes are restricted to `~/.pi/agent/**` and the current project directory; pi's install directory is refused outright.
2. **Backup → validate → restore**: every write is backed up, then validated in a **child process**; a failed validation restores the backup and leaves nothing behind.
3. **Explicit rollback**: `pi_self_rollback` restores the last `pi_self_apply`. Nothing rolls back behind your back.
4. **Don't type during a restart**: takeover works by typing into the console — your keystrokes would collide with it.

## Requirements

- pi with extension support (developed and verified against `@earendil-works/pi-coding-agent` 0.85.x)
- Node.js 20+
- Windows for the terminal-injection restart path; elsewhere the tools work and restarts fall back to spawn / new window
- Windows PowerShell 5.1+ for `bin/pi-coninject.ps1` (keep the file UTF-8 **with BOM** — PowerShell 5.1 decodes ANSI otherwise and the embedded C# fails to compile)

## Troubleshooting

| Symptom | What to do |
|---|---|
| `pi_self_apply` says "已排队" but nothing changes | The session was streaming. Wait for an idle moment, or type `/reload`. Check `pi-self-update.log` — `dispatch` without `module loaded` means the guard refused. |
| Reload worked but the tools are unchanged | Compare stamps with `pi_self_status`. If the stamp is stale, the running instance never reloaded — restart with `pi_self_restart`. |
| Restart did not come back | The resume command is written to `pi-relaunch.log`. Run it manually; then please open an issue with the log. |
| Terminal left in a weird state after a forced restart | The returning pi resets the terminal on startup; if it never started, `stty sane && reset` (POSIX) or just open a new tab. |

## Layout

```
extensions/pi-self-update.ts   tools + commands
bin/pi-check.mjs               static validator (jiti import + stub run)
bin/pi-relaunch.mjs            spectator relauncher (survives exit, injects resume)
bin/pi-coninject.ps1           console injector (Windows, UTF-8 with BOM)
```

## Development

```bash
git clone https://github.com/Zefyr1120/pi-self-update
pi install ./pi-self-update          # local path: your checkout is the running copy
# edit → pi_self_apply / pi_self_restart (or /reload) → pi_self_status
```

Validate without touching a live session:

```bash
node bin/pi-check.mjs --pi-pkg <path-to-pi-coding-agent> extensions/pi-self-update.ts
```

## License

[MIT](LICENSE) © 2026 Zefyr1120
