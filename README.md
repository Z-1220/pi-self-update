# pi-self-update

让 pi 在**自己的会话里**改自己的配置与扩展，并自动生效 —— 写文件 → 校验 → 热重载 / 冷重启 → 核对 → （必要时）回滚。

不是产品功能，是给「用 pi 开发 pi」的人用的系统级工具。

## 安装

```bash
# 本地目录（开发中常用）
pi install /absolute/path/to/pi-self-update

# git（发布的仓库）
pi install git:github.com/<user>/pi-self-update@v0.1.0

# npm
pi install npm:pi-self-update

# 只在本轮试用，不写 settings
pi -e /absolute/path/to/pi-self-update
```

卸载：`pi remove /absolute/path/to/pi-self-update`（git/npm 同理）。
首次加载后**需要一次 `/reload` 或重启 pi** 才能让扩展生效——这是 pi 的固有约束：扩展代码只能由「启动 / 重载」进入运行时。

## 工具

| 工具 | 作用 |
|---|---|
| `pi_self_status` | 核对：内存戳 vs 磁盘哈希、journal、已注册工具、会话/模型信息 |
| `pi_self_reload` | 热重载（扩展/技能/提示词/主题/AGENTS.md/settings/keybindings） |
| `pi_self_apply` | 写文件 + 白名单校验 + 子进程静态校验 + 排队重载（失败自动还原） |
| `pi_self_rollback` | **显式**回滚上一次 `pi_self_apply`（不会自动执行） |
| `pi_self_restart` | 冷重启：同一终端接管、会话续上、不新开窗口 |

## 三层能力（实测结论）

| 层 | 覆盖 | 触发 | 注意 |
|---|---|---|---|
| **L0 即时** | 运行中 `registerTool()`、`models.json` | 无需操作 | — |
| **L1 热重载** | 扩展 / 技能 / 提示词 / 主题 / AGENTS.md / settings / keybindings | 会话**空闲**时手敲 `/reload`；或 `pi_self_apply` 排队后自动等空闲窗口 | 交互模式的 reload 有 `isStreaming`/`isCompacting` 守卫，会**静默拒绝**（只弹 TUI 警告，扩展侧无回调）→ 活跃对话中可能需要等一会儿；排队**不会**擅自回滚 |
| **L2 冷重启** | pi 自身升级、`node_modules` 补丁、`trust.json`、进程环境变量 | `pi_self_restart` | 原终端接管（fd0 继承注入）、不新开窗口、会话自动续上、`--force-after 90` 防卡死 |

关键实现点（踩过的坑，都写在代码注释里）：

- **Windows 上 `detached:false` 的子进程会随父进程被杀**（libuv 的 Job Object），而 `detached:true` 会被换成 `CREATE_NEW_CONSOLE` 多开一个窗口（`windowsHide` 挡不住）→ 用 `cmd /c start /b` 才能"活下来且不新开窗口"。
- 冷重启的"原终端接管"靠**把 resume 命令注入原控制台输入缓冲区**（`WriteConsoleInput`），由停在那儿的 shell 自己执行；句柄来自 pi 进程 stdin 的**继承**（跨控制台可写），失败时按 shell pid `AttachConsole` 兜底，再失败降级新窗口。
- 判断"更新是否落地"要用 **journal**（而不是"本扩展文件哈希变没变"——改动可能落在别的扩展文件上，实测踩过）。
- `pi-coninject.ps1` 必须存为 **UTF-8 with BOM**（PowerShell 5.1 无 BOM 会按 ANSI 解码，中文注释字节串进 Add-C# 源码会让编译失败）。

## 安全边界

1. 写白名单：只允许 `~/.pi/agent/**` 与当前项目目录；显式拒绝 pi 安装目录。
2. 写前备份、写后子进程校验（jiti 真 import + stub 试跑），校验不过立刻还原、磁盘不留半成品。
3. 回滚是**显式**操作；自动回滚已取消（它会在 reload 还没轮到落地时先把新文件删掉）。
4. 冷重启期间不要敲键盘 —— 注入是"打字"进控制台，会与按键冲突。

## 运行时状态与日志

```
~/.pi/agent/state/pi-self-update/journal.json      待处理的 reload 记录（核对/回滚依据）
~/.pi/agent/state/pi-self-update/pi-self-update.log 埋点：queue/dispatch/command/verify
~/.pi/agent/state/pi-self-update/pi-relaunch.log    重启链路日志
```

## 目录结构

```
extensions/pi-self-update.ts   扩展本体（工具 + 命令：/pi-reload-runtime、/pi-restart）
bin/pi-check.mjs               静态校验器（jiti 真 import + stub 试跑）
bin/pi-relaunch.mjs            旁观重启器（等 pid 退出 → 注入 resume 命令）
bin/pi-coninject.ps1           原控制台注入器（Windows，UTF-8 with BOM）
```

## 验收方式（可复现）

1. `pi_self_status` → 内存戳 == 磁盘哈希；
2. `pi_self_apply` 改一个小文件（例如新建一个只注册一个工具的探针扩展，`expected_tools` 指定它）；
3. 会话空闲时（手敲 `/reload`，或等 `agent_settled`/退避重试抓住窗口）→ transcript 出现 `✅ 自更新已生效`，探针工具可调用；
4. `pi_relaunch.log` 里应出现 `source=inherited`（继承句柄路径）与 `重启完成`。
