#!/usr/bin/env node
/**
 * pi-relaunch.mjs — 等 pi 进程退出后，把同一会话在原终端重新拉起
 *
 * 为什么需要它：CLI 里 agent 无法重启自己的父进程（shell）。做法是先 spawn 一个旁观
 * 进程（本脚本），它不随 pi 退出而死；pi 调 ctx.shutdown() 正常退出并打印
 * "To resume this session: pi --session <id>"，本脚本发现 pid 消失后再拉起同一会话。
 *
 * 拉起方式（--mode）：
 *   inject / auto(win32)  真·原终端接管（Windows）：把 `pi --session <id>` 当键盘输入
 *                         写进【原控制台】的输入缓冲区，让停在那儿的 shell 自己执行它。
 *                         终端、窗口、标签页都不变，不新开窗口。
 *                         依赖：本进程 fd0 是 pi 所在控制台的输入句柄（pi-self-update
 *                         扩展以 stdio:["inherit",...] 继承下来；跨控制台句柄可写）。
 *                         ⚠️ 已知不适用：shell 不在提示符处（例如 pi 由一次性脚本拉起）、
 *                         stdout 被重定向、非 Windows —— 这些情况自动降级 window。
 *   tty / auto(posix)     直接 spawn 并继承 stdio（POSIX 下尽力而为）。
 *                         ⚠️ Windows 上不要用：libuv 会把 detached spawn 换成
 *                         CREATE_NEW_CONSOLE —— 结果是新开一个控制台窗口，而不是接管原终端。
 *   window                新开一个终端窗口（Windows: cmd /c start；POSIX: 依次试终端模拟器）
 *   print                 只打印将执行的命令（演练用）
 *
 * 用法:
 *   node pi-relaunch.mjs --pid <pi进程pid> --cwd <工作目录> \
 *        [--session <会话id>] [--session-dir <目录>] [--mode auto] \
 *        [--node <node.exe>] [--cli <cli.js>] [--shell-pid <宿主shell pid>] \
 *        [--inject-text <覆盖注入文本>] [--timeout 180] [--delay 400] [--force-after 0]
 *
 *   --timeout <秒>    等 pi 退出的上限（超过就放弃，默认 180）
 *   --force-after <秒> 超过这么长时间还没退出（说明优雅退出卡住了），强制结束 pi 再拉起；
 *                     0 = 不强制（默认）。实测遇过一次：pi 的 shutdown 请求没落地，
 *                     旧进程一直活着，重启就永远等下去 —— 需要外部强制才行。
 *
 * 退出码: 0 = 已成功拉起 / 3 = 未等到退出（超时）/ 4 = 拉起失败
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const INJECT_SCRIPT = join(HERE, "pi-coninject.ps1");

// 运行时状态（日志 / 待拉起 marker）不写在包目录里：包可能只读、也可能被升级替换。
// 默认 ~/.pi/agent/state/pi-self-update，可用 --state-dir 覆盖（扩展会显式传）。
let STATE_DIR = "";
let LOG = "";
let PENDING = "";
function initStateDir(dir) {
  STATE_DIR = dir;
  LOG = join(dir, "pi-relaunch.log");
  PENDING = join(dir, "pi-relaunch.pending.json");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try {
    appendFileSync(LOG, line + "\n", "utf8");
  } catch {
    /* ignore */
  }
  try {
    process.stdout.write(line + "\n");
  } catch {
    /* stdio 不可用（无控制台/句柄无效）时忽略 */
  }
}

// 旁观进程可能挂在用户的控制台上（cmd /c start /b），Ctrl+C 不能把我们带走
process.on("SIGINT", () => {});
process.on("SIGBREAK", () => {});
process.stdout?.on?.("error", () => {});
process.stderr?.on?.("error", () => {});

function parseArgs(argv) {
  const out = { mode: "auto", timeout: 180, delay: 400 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    out[key] = val;
  }
  return out;
}

/** 模式归一：Windows 上 tty 没有意义（detached spawn = 新控制台窗口），一律走 inject */
function resolveMode(m) {
  if (m === "auto") return process.platform === "win32" ? "inject" : "tty";
  if (m === "tty" && process.platform === "win32") return "inject";
  return m;
}

/** 宿主 shell pid：--shell-pid 优先；没有就现场问一次 pi 的父进程（必须在 pi 还活着时查） */
function resolveShellPid(args) {
  const given = Number(args["shell-pid"]);
  if (Number.isInteger(given) && given > 0) return given;
  if (process.platform !== "win32") return 0;
  try {
    const r = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(args.pid)}' -ErrorAction SilentlyContinue).ParentProcessId`,
      ],
      { encoding: "utf8", timeout: 20_000, windowsHide: true },
    );
    const v = Number(String(r.stdout ?? "").trim());
    return Number.isInteger(v) && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}

function isAlive(p) {
  try {
    process.kill(p, 0);
    return true;
  } catch (e) {
    // EPERM 表示进程存在但无权限；ESRCH 表示已退出
    return e?.code === "EPERM";
  }
}

/** pi 命令行：优先用 PATH 上的 pi；同时支持从环境变量覆盖（测试/自定义安装） */
const PI_CMD = process.env.PI_BIN || "pi";

function resumeArgs(session, sessionDir) {
  const a = [];
  if (sessionDir) a.push("--session-dir", `"${sessionDir}"`);
  if (session) a.push("--session", session);
  return a;
}

/** 用户 shell 里能否解析到 pi 命令（不能就用 node+cli 绝对路径兜底） */
function piOnPath(cmd) {
  const r =
    process.platform === "win32"
      ? spawnSync("where", [cmd], { encoding: "utf8", windowsHide: true })
      : spawnSync("sh", ["-lc", `command -v ${cmd}`], { encoding: "utf8" });
  return r.status === 0 && String(r.stdout ?? "").trim().length > 0;
}

/** 宿主 shell 类型（决定绝对路径命令怎么写） */
function shellKindOf(pid) {
  if (!pid || process.platform !== "win32") return "";
  try {
    const r = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}' -ErrorAction SilentlyContinue).Name`,
      ],
      { encoding: "utf8", timeout: 20000, windowsHide: true },
    );
    return String(r.stdout ?? "").trim().toLowerCase();
  } catch {
    return "";
  }
}

/** 要注入原终端的命令文本（最终由用户 shell 执行） */
function buildCommand(args) {
  if (args["inject-text"] && args["inject-text"] !== "true") return String(args["inject-text"]);
  const ra = resumeArgs(args.session && args.session !== "true" ? args.session : "", args["session-dir"] && args["session-dir"] !== "true" ? args["session-dir"] : "");
  const cwd = args.cwd && args.cwd !== "true" ? args.cwd : "";
  const kind = shellKindOf(args["shell-pid"]);
  // 新 pi 的 cwd = 原 pi 的 cwd（不假设 shell 留在原目录；shell 未知就不加）
  let cdPrefix = "";
  if (cwd) {
    if (kind.includes("powershell") || kind.includes("pwsh")) cdPrefix = `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'; `;
    else if (kind.includes("cmd")) cdPrefix = `cd /d "${cwd}" && `;
  }
  if (piOnPath(PI_CMD)) return `${cdPrefix}${[PI_CMD, ...ra].join(" ")}`;
  const node = args.node && args.node !== "true" ? args.node : process.execPath;
  const cli = args.cli && args.cli !== "true" ? args.cli : "";
  if (!cli) throw new Error("pi 不在 PATH 上，且没有 --node/--cli 兜底命令");
  const base = `"${node}" "${cli}"`;
  if (kind.includes("powershell") || kind.includes("pwsh")) return `${cdPrefix}& ${base} ${ra.join(" ")}`;
  return `${cdPrefix}${base} ${ra.join(" ")}`;
}

/** 注入原控制台：优先用继承来的 fd0（原控制台输入句柄），不行再按 pid 挂到目标控制台 */
function injectIntoConsole(text, attachPid) {
  if (process.platform !== "win32") return { ok: false, output: "注入模式仅支持 Windows" };
  if (!existsSync(INJECT_SCRIPT)) return { ok: false, output: `找不到注入器 ${INJECT_SCRIPT}` };
  const psArgs = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", INJECT_SCRIPT, "-Text", text];
  if (Number(attachPid) > 0) psArgs.push("-TargetPid", String(Number(attachPid)));
  const r = spawnSync("powershell.exe", psArgs, {
    stdio: ["inherit", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() || `退出码 ${r.status}`;
  return { ok: r.status === 0, output };
}

/** 新开一个控制台窗口。start 的第一个引号参数是窗口标题，必须留空。 */
function launchWindow(cwd, ra) {
  try {
    if (process.platform === "win32") {
      const child = spawn("cmd.exe", ["/c", "start", "", PI_CMD, ...ra], {
        cwd,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
    } else {
      const terms = [
        ["x-terminal-emulator", ["-e", PI_CMD, ...ra]],
        ["gnome-terminal", ["--", PI_CMD, ...ra]],
        ["konsole", ["-e", PI_CMD, ...ra]],
        ["xterm", ["-e", PI_CMD, ...ra]],
      ];
      let launched = false;
      for (const [bin, a] of terms) {
        const w = spawnSync("sh", ["-lc", `command -v ${bin}`], { encoding: "utf8" });
        if (w.status === 0 && w.stdout.trim()) {
          spawn(bin, a, { cwd, detached: true, stdio: "ignore" }).unref();
          launched = true;
          log(`已用 ${bin} 新窗口拉起`);
          break;
        }
      }
      if (!launched) {
        log("没有找到可用的终端模拟器，回退为 tty 模式");
        return launchTty(cwd, ra);
      }
    }
    log("已请求在新窗口拉起（窗口模式无法回传结果，请看新窗口）");
    return "ok";
  } catch (e) {
    log(`新窗口拉起失败：${e instanceof Error ? e.message : String(e)}，回退 tty 模式`);
    return launchTty(cwd, ra);
  }
}

/** 直接 spawn 并继承 stdio。POSIX 下尽力而为；Windows 上会被 libuv 换成新控制台窗口。 */
function launchTty(cwd, ra) {
  if (process.platform === "win32") {
    log("⚠️ Windows 上 tty 模式 = detached spawn = CREATE_NEW_CONSOLE，会新开窗口（不是接管原终端）");
  }
  try {
    const child = spawn(PI_CMD, ra, {
      cwd,
      detached: true,
      stdio: ["inherit", "inherit", "inherit"],
      shell: process.platform === "win32",
      windowsHide: true,
    });
    child.unref();
    log(`已 spawn 拉起（pid ${child.pid}）`);
    return "ok";
  } catch (e) {
    log(`拉起失败：${e instanceof Error ? e.message : String(e)}`);
    return "failed";
  }
}

function launch(cwd, args) {
  const session = args.session && args.session !== "true" ? args.session : "";
  const sessionDir = args["session-dir"] && args["session-dir"] !== "true" ? args["session-dir"] : "";
  const ra = resumeArgs(session, sessionDir);
  const mode = resolveMode(args.mode);

  if (mode === "print") {
    let text = "";
    try {
      text = buildCommand(args);
    } catch (e) {
      text = `(构造失败：${e instanceof Error ? e.message : String(e)})`;
    }
    log(`[print/inject] ${text}`);
    if (process.platform === "win32") {
      log(`[print/window] cd ${JSON.stringify(cwd)} && cmd /c start "" ${PI_CMD} ${ra.join(" ")}`);
    }
    log(`[print/tty] cd ${JSON.stringify(cwd)} && ${PI_CMD} ${ra.join(" ")}`);
    return "ok";
  }

  if (mode === "inject") {
    let text;
    try {
      text = buildCommand(args);
    } catch (e) {
      log(`构造注入命令失败（${e instanceof Error ? e.message : String(e)}），降级新窗口`);
      return launchWindow(cwd, ra);
    }
    const r = injectIntoConsole(text, args["shell-pid"]);
    if (r.ok) {
      log(`已在原终端注入命令，交由原 shell 接管：${text}（${r.output}）`);
      return "ok";
    }
    log(`原终端注入失败（${r.output}），降级为新窗口拉起`);
    return launchWindow(cwd, ra);
  }

  if (mode === "window") return launchWindow(cwd, ra);
  return launchTty(cwd, ra);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  initStateDir(
    args["state-dir"] && args["state-dir"] !== "true"
      ? args["state-dir"]
      : join(homedir(), ".pi", "agent", "state", "pi-self-update"),
  );
  const pid = Number(args.pid);
  const cwd = args.cwd && args.cwd !== "true" ? args.cwd : process.cwd();
  const session = args.session && args.session !== "true" ? args.session : "";
  const timeoutMs = Number(args.timeout) * 1000;
  const delayMs = Number(args.delay);
  const mode = resolveMode(args.mode);

  if (!Number.isInteger(pid) || pid <= 0) {
    log(`参数错误：--pid 需要有效进程号（收到 ${args.pid}）`);
    process.exit(2);
  }

  // 注入靠的是「原控制台」：优先用 --shell-pid，其次现场查 pi 的父进程（现在 pi 还活着）
  args["shell-pid"] = String(resolveShellPid(args) || "");

  log(`旁观启动：等待 pi pid=${pid} 退出（mode=${mode}, cwd=${cwd}, session=${session || "(未指定)"}, shell=${args["shell-pid"] || "?"}）`);
  try {
    writeFileSync(PENDING, JSON.stringify({ pid, session, cwd, mode, startedAt: new Date().toISOString() }, null, 2), "utf8");
  } catch {
    /* ignore */
  }

  const t0 = Date.now();
  const forceAfterMs = Number(args["force-after"] ?? 0) * 1000;
  let forced = false;
  const timer = setInterval(() => {
    const waited = Date.now() - t0;
    if (isAlive(pid)) {
      if (forceAfterMs > 0 && !forced && waited > forceAfterMs) {
        forced = true;
        log(`⚠️ 等 ${Math.round(waited / 1000)}s 仍未退出（优雅退出卡住？）→ 强制结束 pid=${pid} 后照常拉起`);
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          if (!isAlive(pid)) return;
          try {
            spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
          } catch {
            /* ignore */
          }
        }, 1500);
      }
      if (waited > timeoutMs) {
        clearInterval(timer);
        log(`超时 ${args.timeout}s 仍未等到 pid=${pid} 退出，放弃拉起（marker 保留）`);
        process.exit(3);
      }
      return;
    }
    clearInterval(timer);
    log(`检测到 pid=${pid} 已退出，${delayMs}ms 后拉起`);
    setTimeout(() => {
      const result = launch(cwd, args);
      if (result === "ok") {
        try {
          rmSync(PENDING, { force: true });
        } catch {
          /* ignore */
        }
        log("重启完成");
        process.exit(0);
      }
      log("重启失败，请手动执行 pi " + resumeArgs(session, args["session-dir"] ?? "").join(" ") + `（工作目录 ${cwd}）`);
      if (!existsSync(PENDING)) log("（无 marker 文件）");
      process.exit(4);
    }, delayMs);
  }, 250);
}

const isEntry = !!process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isEntry) main();

export { main, buildCommand, injectIntoConsole };
