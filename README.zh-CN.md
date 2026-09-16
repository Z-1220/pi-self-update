<div align="center">

# pi-self-update

**让 pi 在自己的会话里改自己 —— 当场生效。**

写文件 → 校验 → 热重载 / 冷重启 → 核对 → （必要时）回滚。

[![Version](https://img.shields.io/github/v/tag/Origin1120/pi-self-update?label=version&sort=semver)](https://github.com/Origin1120/pi-self-update/tags)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![pi package](https://img.shields.io/badge/pi-package-blueviolet)](https://pi.dev/packages)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#环境要求)
[![README: English](https://img.shields.io/badge/README-English-blue)](README.md)

</div>

---

## 为什么需要它

一个能自己写扩展、提示词、技能、甚至给自己打补丁的 coding agent，仍然要面对同一个问题：**写出来的代码怎么进入它自己的运行时**。默认流程是「改完 → 退出 → 重开 → 发现写坏了」。

`pi-self-update` 在会话内把这条环路闭合：

| 没有它 | 有它 |
|---|---|
| 写文件 → 退出 pi → 重启 → 祈祷 | `pi_self_apply` → 校验通过 → 自动重载 → `✅ 自更新已生效` |
| 扩展写坏 → 会话直接死掉 | **先在子进程里校验**；磁盘上不留半成品 |
| 重启开到新窗口、会话丢了 | 重启**在原终端**接管、会话自动续上、不新开窗口 |
| 「我改的东西到底加载了没？」 | `pi_self_status` 用运行实例的内存戳对比磁盘哈希 |

## 特性

- **5 个工具** —— `pi_self_status` / `pi_self_reload` / `pi_self_apply` / `pi_self_rollback` / `pi_self_restart`
- **2 个命令** —— `/pi-reload-runtime`、`/pi-restart`
- **子进程校验** —— 用真实 `jiti` import + 用 stub 跑一遍扩展工厂；语法错误、依赖解析失败、模块顶层崩溃都在**伤不到会话**的地方被拦下
- **写白名单** —— 只允许 `~/.pi/agent/**` 与当前项目目录；明确拒绝 pi 安装目录（升级会覆盖）
- **带账本（journal）的更新** —— 每次 apply 都有记录，「运行的是不是磁盘上的代码」永远有答案
- **会等空闲窗口的热重载** —— 排队 + 退避重试（20/40/60/90s）+ 在会话真正空闲时补发
- **能扛住"优雅退出卡死"的重启** —— `--force-after 90` 兜底强制完成
- **Windows 原生原终端接管** —— 把 resume 命令**注入原控制台输入缓冲区**（`WriteConsoleInput`，ConPTY / Windows Terminal 均可）：同一个标签页、同一个会话、不多开窗口
- **跨平台** —— 工具在 Linux/macOS 同样可用；终端注入路径是 Windows 专属，其它平台回退为继承 stdio 直接拉起

## 安装

```bash
# git（推荐钉住 tag）
pi install git:github.com/Origin1120/pi-self-update@v0.1.2

# 项目级：写进 <项目>/.pi/settings.json（可随仓库共享给团队）
pi install -l git:github.com/Origin1120/pi-self-update@v0.1.2

# 只在本轮试用
pi -e git:github.com/Origin1120/pi-self-update@v0.1.2

# 本地检出（不复制 —— 检出目录就是运行副本）
pi install /absolute/path/to/pi-self-update
```

首次加载后需要**一次 `/reload` 或重启 pi**：扩展代码只能在「启动 / 重载」时进入运行时。

<details>
<summary><b>全局作用域 vs 项目作用域</b></summary>

| 作用域 | 命令 | 写入 | 生效范围 |
|---|---|---|---|
| 全局（默认） | `pi install <src>` | `~/.pi/agent/settings.json` | 本机所有项目 |
| 项目 | `pi install -l <src>` | `<项目>/.pi/settings.json` | 仅该项目（项目受信任后团队自动安装） |

切换用 `pi remove <src>` 后换作用域重装。**不要两个作用域同时装** —— 同名命令会重复注册（第二个带 `:2` 后缀），待重载状态也会分裂。项目作用域里的相对路径是相对该 settings 文件解析的，`pi install -l ../pi-self-update` 很适合把包随仓库一起带。

</details>

## 快速开始

一次真实的验收过程（新增一个只注册一个工具的扩展文件）：

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

> `19:00:20` 排队 → `19:00:38` 落地：重载在等一个空闲窗口（见下），落地后自己完成核对并清空账本。

## 工作原理

### 三层能力

| 层 | 覆盖 | 触发 |
|---|---|---|
| **L0 即时** | 运行中调用 `pi.registerTool()`、`models.json` | 无需操作 |
| **L1 热重载** | 扩展、技能、提示词、主题、`AGENTS.md`、`settings.json`、keybindings | 空闲时 `/reload`，或 `pi_self_apply` 排队后自动等窗口 |
| **L2 冷重启** | pi 自身版本、`node_modules` 补丁、`trust.json`、进程环境变量 | `pi_self_restart` |

### 为什么"排了重载却没生效"

pi 交互模式的重载走 `handleReloadCommand()`，在流式输出期间**静默拒绝**：

```js
if (this.session.isStreaming)  { showWarning("Wait for the current response to finish before reloading."); return; }
if (this.session.isCompacting) { showWarning("Wait for compaction to finish before reloading.");     return; }
```

扩展侧收不到任何回调或异常 —— 被拒的重载从外部看和成功的重载一模一样。所以本包：

1. 每次 apply 都写一条 **journal**（`~/.pi/agent/state/pi-self-update/journal.json`）；
2. 持续争取：`agent_settled`（会延迟到会话真空闲才到）、`input` / `turn_start` 时若 `ctx.isIdle()` 就机会性补发、以及 20/40/60/90s 退避链；
3. 判定"是否落地"用的是**本实例的加载时间**与 journal 时间戳比较 —— 而不是"某个文件变没变"（改动可能落在**别的**扩展文件上，这个判据会把成功误判成失败）；
4. **绝不擅自回滚**。早期版本会，结果在 reload 还没轮到落地时就把待加载的新文件删了。回滚是显式操作：`pi_self_rollback`。

### 重启路径（Windows）

难点在于**把同一个终端拿回来**：

| 做法 | 结果 |
|---|---|
| `spawn(detached: false)` | 随 pi 一起被杀（libuv 把它挂进 Job Object） |
| `spawn(detached: true)` | 活下来了，但被换成 `CREATE_NEW_CONSOLE` —— 多出第二个窗口（`windowsHide` 挡不住） |
| **`cmd /d /c start /b "…" node pi-relaunch.mjs`** | 既活下来、又不新开控制台 —— 唯一同时满足两者的组合 |

接着旁观进程等 pi 的 pid 消失，把 resume 命令**注入原控制台输入缓冲区**（`WriteConsoleInput`，实现见 `bin/pi-coninject.ps1`）。句柄继承自 pi 进程的 stdin（fd0）—— 控制台句柄跨控制台依然可写 —— 于是停在提示符处的 shell 自己执行 `pi --session <id>`。新 pi 是**原 shell 的子进程**：同一个窗口、同一个标签页、会话继续。

回退链：按 shell pid `AttachConsole` → 新窗口（`--mode window`）→ 日志里给出可手敲的命令。
`--force-after 90`：优雅退出迟迟不落地时强制结束 pi。

> POSIX 说明：`--mode tty` 继承 stdio 直接拉起，属尽力而为 —— 终端仍属于原 shell，输入会互相竞争。可靠路径是 `/reload` 与手动重启。

### 状态与日志

```
~/.pi/agent/state/pi-self-update/journal.json        待处理的 reload 记录（核对/回滚依据）
~/.pi/agent/state/pi-self-update/pi-self-update.log  埋点：queue / dispatch / command / verify
~/.pi/agent/state/pi-self-update/pi-relaunch.log     重启链路
```

## 安全边界

1. **白名单**：只允许写 `~/.pi/agent/**` 与当前项目目录；pi 安装目录直接拒绝。
2. **备份 → 校验 → 还原**：每次写入先备份，再在**子进程**里校验；校验不过立刻还原，磁盘零残留。
3. **回滚是显式操作**：`pi_self_rollback` 还原上一次 `pi_self_apply`。没有任何"背后自动回滚"。
4. **重启期间不要敲键盘**：接管靠向控制台"打字"，你的按键会和它撞车。

## 环境要求

- 支持扩展的 pi（开发与实测环境：`@earendil-works/pi-coding-agent` 0.85.x）
- Node.js 20+
- Windows 才能走"原终端注入"重启路径；其它平台工具可用，重启回退为直接拉起 / 新窗口
- Windows PowerShell 5.1+ 运行 `bin/pi-coninject.ps1`（该文件必须保持 **UTF-8 with BOM** —— 5.1 无 BOM 会按 ANSI 解码，内嵌的 C# 会编译失败）

## 常见问题

| 现象 | 处理 |
|---|---|
| `pi_self_apply` 显示"已排队"但没有变化 | 当时会话在流式输出。等一个空闲时刻，或直接敲 `/reload`。看 `pi-self-update.log`：只有 `dispatch` 没有 `module loaded`，就是被守门拒了。 |
| 重载了但工具没变 | 用 `pi_self_status` 比 stamp。stamp 还是旧的说明运行实例没换 → 用 `pi_self_restart`。 |
| 重启后没回来 | resume 命令写在 `pi-relaunch.log` 里，手动执行即可；顺便把日志附到 issue 里。 |
| 强制重启后终端状态怪 | 归来的 pi 会在启动时重置终端；如果它没起来，POSIX 下 `stty sane && reset`，Windows 下开个新标签页即可。 |

## 目录结构

```
extensions/pi-self-update.ts   工具与命令
bin/pi-check.mjs               静态校验器（jiti import + stub 试跑）
bin/pi-relaunch.mjs            旁观重启器（活过 pi 退出 + 注入 resume）
bin/pi-coninject.ps1           控制台注入器（Windows，UTF-8 with BOM）
```

## 开发

```bash
git clone https://github.com/Origin1120/pi-self-update
pi install ./pi-self-update          # local path：检出目录就是运行副本
# 改文件 → pi_self_apply / pi_self_restart（或 /reload）→ pi_self_status
```

不动线上会话也能校验：

```bash
node bin/pi-check.mjs --pi-pkg <path-to-pi-coding-agent> extensions/pi-self-update.ts
```

## 许可

[MIT](LICENSE) © 2026 Origin1120
