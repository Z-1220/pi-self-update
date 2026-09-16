/**
 * pi-self-update.ts — 让 pi 在**自己的会话里**改自己，并自动生效
 *
 * 三层机制（按代价从低到高，覆盖不同种类的"自我修改"）：
 *
 *   L0 即时生效   扩展在启动后调用 pi.registerTool() 会立即生效；
 *                ~/.pi/agent/models.json 每次打开 /model 都会重读。
 *   L1 热重载     /pi-reload-runtime → ctx.reload()：同一进程内重载
 *                extensions / skills / prompt templates / themes / context(AGENTS.md) /
 *                settings.json / keybindings / packages 解析。会话不中断、上下文不丢。
 *   L2 冷重启     /pi-restart → 先 spawn 一个脱离的 bin/pi-relaunch.mjs 旁观进程，
 *                再 ctx.shutdown() 优雅退出；旁观进程发现本进程 pid 消失后，把
 *                `pi --session <id>` 注入【原控制台输入缓冲区】（bin/pi-coninject.ps1），
 *                让停在那儿的 shell 自己执行 —— 不新开窗口，真正在原终端接管。
 *                （注入写不进去时降级为 cmd /c start 新窗口。）用于 pi 自身升级、
 *                node_modules 打补丁、trust.json、环境变量、或 reload 都救不回来的情况。
 *
 * 自保设计（改自己必须防炸）：
 *   1) 写权限白名单：只允许 ~/.pi/agent/** 与当前项目目录；显式拒绝 pi 安装目录（升级会被覆盖）。
 *   2) 写前备份、写后用 bin/pi-check.mjs 在**子进程**里校验（jiti 真 import + stub 试跑），
 *      校验不过就还原备份，磁盘不留半成品。
 *   3) 生效验证：扩展加载时对自己文件算 sha256 作为"内存戳"。reload 之后：
 *        · 新代码成功加载 → 内存戳 == 磁盘哈希，且 expected_tools 都在 pi.getAllTools() 里 → 清 journal
 *        · 新代码加载失败（reload 抛错，旧实例还活着）→ 内存戳 ≠ 磁盘哈希 或工具缺失
 *          → 旧实例按 journal 自动回滚备份，并再触发一次 reload（最多 2 次，避免死循环）
 *
 * 配套文件（本包内，路径相对扩展自身而非固定 agent 目录）：
 *   ../bin/pi-check.mjs      静态校验器
 *   ../bin/pi-relaunch.mjs   旁观重启器
 *   ../bin/pi-coninject.ps1  原控制台注入器（Windows）
 * 运行时状态：~/.pi/agent/state/pi-self-update/（journal、埋点日志、重启日志）
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AGENT_DIR = getAgentDir();
// 本包自包含：脚本随包走（<pkg>/bin），运行时状态（journal/日志）放 agent 目录 ——
// 包目录可能只读、也可能被升级整体替换，不该往里写东西。
const PKG_BIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "bin");
const STATE_DIR = join(AGENT_DIR, "state", "pi-self-update");
const CHECK_SCRIPT = join(PKG_BIN_DIR, "pi-check.mjs");
const RELAUNCH_SCRIPT = join(PKG_BIN_DIR, "pi-relaunch.mjs");
const JOURNAL_FILE = join(STATE_DIR, "journal.json");

// ───────────────────────────── 自身指纹 ─────────────────────────────

function resolveSelfPath(): string {
  // 包内路径：只看 import.meta.url（不再有写死的 agent 目录兜底）
  try {
    const p = fileURLToPath(import.meta.url);
    if (p.endsWith(".ts") || p.endsWith(".js")) return p;
  } catch {
    /* jiti 下偶尔拿不到 */
  }
  return "";
}

const SELF_PATH = resolveSelfPath();

function sha256File(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
  } catch {
    return "missing";
  }
}

/** 本次加载时的"内存戳"：新代码真的被加载了，它才等于磁盘哈希 */
const STAMP = sha256File(SELF_PATH);
const LOADED_AT = new Date().toISOString();
const LOAD_PID = process.pid;

// ─────────────────────── 自更新自己的日志（诊断用） ───────────────────────
// 交互模式的 handleReloadCommand() 在 isStreaming/isCompacting 时只弹 TUI 警告、不报错，
// 扩展侧完全看不到 "reload 被拒"。所以把关键节点写进文件，事后可查。
const SELF_LOG = join(STATE_DIR, "pi-self-update.log");
function dbg(msg: string): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(SELF_LOG, `[${new Date().toISOString()}] ${msg}\n`, "utf8");
  } catch {
    /* 诊断日志只是尽力而为 */
  }
}
dbg(`module loaded pid=${LOAD_PID} stamp=${STAMP}`);

// ───────────────────────────── journal ─────────────────────────────

interface JournalEntry {
  kind: "reload" | "restart";
  at: string;
  note?: string;
  files?: string[];
  backups?: Record<string, string | null>;
  expectedTools?: string[];
  attempts?: number;
  hinted?: boolean;
}

function readJournal(): JournalEntry | undefined {
  try {
    if (!existsSync(JOURNAL_FILE)) return undefined;
    return JSON.parse(readFileSync(JOURNAL_FILE, "utf8")) as JournalEntry;
  } catch {
    return undefined;
  }
}

function writeJournal(entry: JournalEntry): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(JOURNAL_FILE, JSON.stringify(entry, null, 2), "utf8");
  } catch {
    /* journal 只是尽力而为 */
  }
}

function clearJournal(): void {
  try {
    rmSync(JOURNAL_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

// ─────────────────────── 写权限白名单 & 校验 ───────────────────────

/** 允许：~/.pi/agent/** 与当前项目目录。拒绝：pi 安装目录里的任何东西。 */
function assertWritable(target: string, cwd: string): string {
  const abs = resolve(target);
  const inside = (root: string) => {
    const rel = relative(resolve(root), abs);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  if (!inside(AGENT_DIR) && !inside(cwd)) {
    throw new Error(`拒绝写入 ${abs}：白名单只含 ${AGENT_DIR} 与项目目录 ${resolve(cwd)}`);
  }
  if (inside(getPackageDir())) {
    throw new Error(`拒绝写入 pi 安装目录（升级会被覆盖）：${abs}`);
  }
  return abs;
}

function validateFiles(files: string[]): { ok: boolean; output: string } {
  if (files.length === 0) return { ok: true, output: "（无文件需要校验）" };
  if (!existsSync(CHECK_SCRIPT)) {
    return { ok: false, output: `找不到校验器 ${CHECK_SCRIPT}，为安全起见中断` };
  }
  const r = spawnSync(process.execPath, [CHECK_SCRIPT, "--pi-pkg", getPackageDir(), ...files], {
    encoding: "utf8",
    timeout: 120_000,
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  return { ok: r.status === 0, output: output || `退出码 ${r.status}` };
}

function ok(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}
function fail(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `❌ ${msg}` }], details: { error: msg }, isError: true };
}

// ─────────────────────── reload / restart 动作 ───────────────────────

// 待执行的重载：由 agent_settled 在「本轮真正结束」后派发。
// ⚠️ 不要用 sendUserMessage("/pi-reload-runtime", { deliverAs: "followUp" })：
//    prompt() 对【扩展命令】永远是「立即执行」（不看 deliverAs）。若此刻 agent 正在
//    流式输出，handleReloadCommand() 会以 isStreaming 为由拒绝 → "排队"静默失效。
// 于是这里不只"排一条消息"，而是"派发 + 核对 + 退避重试"：
//   磁盘哈希 ≠ 内存戳 ⇒ 本实例还是旧的（没生效），且 journal 还在 ⇒ 继续重试；
//   journal 被新实例清掉（或自己没了）⇒ 立刻停手（避免 reload 成功后幽灵实例又开一枪）。
let pendingReload: string | null = null;
let reloadAttempts = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function updateStillPending(): boolean {
  // 以 journal 为准：有 kind=reload 记录 = 还有未落地的自更新。
  // ⚠️ 不能用“本扩展文件哈希 ≠ 内存戳”判断 —— 改动可能落在别的扩展文件上
  // （实测踩到：改探针 pi-rl-live.ts 时该判据恒为 false，重试链第一发就自己停了）。
  const j = readJournal();
  return !!j && j.kind === "reload";
}

function queueReload(pi: ExtensionAPI, note: string): void {
  pendingReload = note;
  reloadAttempts = 0;
  dbg(`queue: ${note}`);
  // 手动重载（pi_self_reload）没有修改文件、原本不会写 journal，
  // 而退避重试/verify 都以 journal 为准 → 会空转。这里补一条最小记录：
  // 新实例的 LOADED_AT 晚于它的 at，即说明"这次 reload 真落地了"。
  if (!existsSync(JOURNAL_FILE)) {
    writeJournal({ kind: "reload", at: new Date().toISOString(), note, files: [], backups: {}, expectedTools: [], attempts: 0 });
  }
  pi.sendMessage(
    {
      customType: "pi-self-update",
      content: `🔄 已排重载：${note}（本轮结束后自动执行；若加载失败会按 journal 回滚）`,
      display: true,
    },
    { deliverAs: "followUp" },
  );
  // 不依赖 agent_settled：实测该事件在本交互会话里会延迟到会话真空闲才到，
  // 所以排完队就直接把逆退重试链启上 —— 定时器会在会话空闲时再打。
  scheduleRetry(pi);
}

function scheduleRetry(pi: ExtensionAPI): void {
  if (retryTimer) clearTimeout(retryTimer);
  if (!pendingReload || reloadAttempts >= 5) return;
  // 延迟要够长：交互模式的 reload 在 isStreaming 时会被静默拒（只弹 TUI 警告），
  // 而重试若都在 agent 生成过程中触发就白打 —— 拉到秒级/十几秒级才有机会落在会话空闲窗口里。
  const delay = [20000, 40000, 60000, 90000][Math.min(reloadAttempts, 3)] ?? 90000;
  retryTimer = setTimeout(() => {
    if (!pendingReload) return;
    if (!existsSync(JOURNAL_FILE)) {
      dbg(`retry stop: journal 已清（说明新实例已接管）`);
      pendingReload = null;
      return;
    }
    if (!updateStillPending()) {
      dbg(`retry stop: 磁盘哈希 == 内存戳`);
      pendingReload = null;
      return;
    }
    dispatchReload(pi, `retry after ${delay}ms`);
  }, delay);
}

function dispatchReload(pi: ExtensionAPI, why: string): void {
  if (!pendingReload) return;
  reloadAttempts++;
  dbg(`dispatch #${reloadAttempts} (${why})`);
  void Promise.resolve(pi.sendUserMessage("/pi-reload-runtime", { expandPromptTemplates: true }))
    .then(() => dbg(`dispatch #${reloadAttempts} returned（命令链已跑完）`))
    .catch((e) => dbg(`dispatch #${reloadAttempts} threw: ${e instanceof Error ? e.message : String(e)}`));
  scheduleRetry(pi);
}

/** 本轮 settle（isStreaming=false）后派发重载命令；多次登记只执行一次 */
function flushPendingReload(pi: ExtensionAPI): void {
  if (!pendingReload) return;
  dispatchReload(pi, "agent_settled");
}

function spawnRelauncher(ctx: ExtensionContext, reason: string, mode: string): string {
  if (!existsSync(RELAUNCH_SCRIPT)) throw new Error(`找不到重启器 ${RELAUNCH_SCRIPT}`);
  const sessionId = ctx.sessionManager.getSessionId();
  const sessionDir = ctx.sessionManager.getSessionDir();
  const defaultDir = join(AGENT_DIR, "sessions");
  const args = [
    RELAUNCH_SCRIPT,
    "--pid", String(process.pid),
    "--cwd", ctx.cwd,
    "--session", sessionId,
    "--mode", mode,
    "--node", process.execPath,
    "--cli", process.argv[1] ?? "",
    "--shell-pid", String(process.ppid),
    "--state-dir", STATE_DIR,
    // 优雅退出卡住时的兜底：90s 内没退出就强制结束（实测遇过一次 shutdown 请求没落地，重启挂死）
    "--force-after", "90",
  ];
  if (sessionDir && resolve(sessionDir) !== resolve(defaultDir)) args.push("--session-dir", sessionDir);

  // 让旁观进程活过 pi 退出、且不新开控制台窗口（Windows 上这两条互斥，必须借 cmd 的 start）：
  //   · detached:false → 被 libuv 挂在 Job Object 上，pi 一退就被连带杀死；
  //   · detached:true  → 活下来了，但 libuv 用 CREATE_NEW_CONSOLE 起它 → 多一个窗口
  //                      （windowsHide 挡不住，实测 visible=True）——就是「重启后多一个终端」的真因；
  //   · cmd /c start /b → 既不进 Job、也不新开控制台，唯一同时满足两者的方式。
  // 同时把 fd0 继承为原控制台输入句柄（+ --shell-pid 兜底）：重启器用它把
  // `pi --session <id>` 注入原终端，让停在那儿的 shell 自己执行 —— 真·原终端接管。
  const isWin = process.platform === "win32";
  let child;
  if (isWin) {
    const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const line = ["start", "/b", '""', quote(process.execPath), ...args.map(quote)].join(" ");
    child = spawn("cmd.exe", ["/d", "/c", line], {
      cwd: ctx.cwd,
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ["inherit", "ignore", "ignore"],
    });
  } else {
    child = spawn(process.execPath, args, { cwd: ctx.cwd, detached: true, stdio: "ignore" });
  }
  child.unref();
  writeJournal({ kind: "restart", at: new Date().toISOString(), note: reason });
  return `旁观进程已就位（pid ${child.pid}），本进程退出后它会执行：pi --session ${sessionId}；若 90s 内本进程未退出则强制结束（兑底）`;
}

// ───────────────────────────── 扩展本体 ─────────────────────────────

export default function (pi: ExtensionAPI) {
  // ---- 命令：热重载入口（工具不能直接调 ctx.reload，必须走命令）----
  pi.registerCommand("pi-reload-runtime", {
    description: "Reload extensions, skills, prompts, themes, context files, settings, keybindings",
    handler: async (_args, ctx) => {
      dbg("command entered: pi-reload-runtime");
      try {
        await ctx.reload();
        dbg("command: ctx.reload() 已返回");
      } catch (e) {
        dbg(`command: ctx.reload() 抛错 ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
      return; // reload 之后本 handler 的旧帧仍在跑，不要假设旧状态还有效
    },
  });

  // ---- 命令：冷重启入口 ----
  pi.registerCommand("pi-restart", {
    description: "Restart pi (kill + relaunch same session) via bin/pi-relaunch.mjs",
    handler: async (args, ctx) => {
      try {
        const mode = args.trim() || "tty";
        const info = spawnRelauncher(ctx, "手动 /pi-restart", mode);
        ctx.ui.notify?.(info, "info");
      } catch (e) {
        ctx.ui.notify?.(`重启失败：${e instanceof Error ? e.message : String(e)}`, "error");
        return;
      }
      ctx.shutdown();
    },
  });

  // ---- 工具 1：状态（也是"新代码是否生效"的证据来源）----
  pi.registerTool({
    name: "pi_self_status",
    label: "自更新状态",
    description:
      "查看 pi 自身配置/扩展的加载状态：本扩展内存戳 vs 磁盘哈希、journal、会话、模型、已注册工具。reload/重启之后调它可确认新代码是否真的生效。",
    promptSnippet: "pi 自更新机制的状态查询（配套 pi_self_reload / pi_self_apply / pi_self_restart）",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const disk = sha256File(SELF_PATH);
      const j = readJournal();
      const tools = pi.getAllTools().map((t: any) => t.name);
      const expected = j?.expectedTools ?? [];
      const missing = expected.filter((n) => !tools.includes(n));
      const lines = [
        `自更新扩展：${SELF_PATH}`,
        `内存戳 stamp ：${STAMP}（pid ${LOAD_PID} 于 ${LOADED_AT} 加载）`,
        `磁盘哈希     ：${disk}`,
        `生效判定     ：${disk === STAMP && missing.length === 0 ? "✅ 当前实例就是磁盘上的最新代码" : `⚠️ 当前实例不是最新（缺工具：${missing.join(",") || "无"}）`}`,
        `会话         ：${ctx.sessionManager.getSessionId()} → ${ctx.sessionManager.getSessionFile() ?? "(未持久化)"}`,
        `工作目录     ：${ctx.cwd}`,
        `模型         ：${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(未知)"}`,
        `已注册工具   ：${tools.length} 个`,
        `journal      ：${j ? `${j.kind} @ ${j.at}${j.note ? `（${j.note}）` : ""}${j.attempts ? ` attempts=${j.attempts}` : ""}` : "(空)"}`,
      ];
      return ok(lines.join("\n"), { stamp: STAMP, disk, journal: j ?? null });
    },
  });

  // ---- 工具 2：热重载 ----
  pi.registerTool({
    name: "pi_self_reload",
    label: "热重载 pi 运行时",
    description:
      "重载 pi 的扩展/技能/提示词/主题/上下文(AGENTS.md)/settings.json/keybindings/包解析，同一进程、会话不中断。改完这些文件后调它即可自动生效。",
    parameters: Type.Object({
      reason: Type.Optional(Type.String({ description: "为什么重载，写进 transcript" })),
    }),
    async execute(_id, params) {
      queueReload(pi, params.reason ?? "手动触发热重载");
      return ok("已排重载：本轮回答结束后自动执行（agent_settled 触发），之后用 pi_self_status 核对 stamp。");
    },
  });

  // ---- 工具 3：改文件 + 校验 + 自动重载（带备份/回滚）----
  pi.registerTool({
    name: "pi_self_apply",
    label: "应用自更新",
    description:
      "在会话内修改 pi 自己的配置/扩展文件并自动生效：写入前备份 → 子进程校验(jiti 真 import + stub 试跑) → 排队热重载 → 事后按预期工具名核对，加载失败会自动回滚。只能写 ~/.pi/agent/** 与当前项目目录。",
    parameters: Type.Object({
      files: Type.Array(
        Type.Object({
          path: Type.String({ description: "绝对路径，或相对当前工作目录" }),
          content: Type.String({ description: "新文件全文（整体覆盖）" }),
        }),
        { description: "要写入的文件列表" },
      ),
      expected_tools: Type.Optional(
        Type.Array(Type.String(), { description: "重载后应出现的工具名，用于验证新代码是否真的加载（可留空）" }),
      ),
      note: Type.Optional(Type.String({ description: "本次修改的说明" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backups: Record<string, string | null> = {};
      const written: string[] = [];
      try {
        const targets = params.files.map((f) => ({ ...f, abs: assertWritable(f.path, ctx.cwd) }));
        // 1) 备份 + 写入
        for (const t of targets) {
          backups[t.abs] = existsSync(t.abs) ? `${t.abs}.bak-${stamp}` : null;
          if (backups[t.abs]) copyFileSync(t.abs, backups[t.abs] as string);
          mkdirSync(dirname(t.abs), { recursive: true });
          writeFileSync(t.abs, t.content, "utf8");
          written.push(t.abs);
        }
        // 2) 校验（子进程，不污染当前 pi 进程）
        const v = validateFiles(written);
        if (!v.ok) {
          for (const abs of written) {
            const bak = backups[abs];
            if (bak) copyFileSync(bak, abs);
            else rmSync(abs, { force: true });
          }
          return fail(`校验未通过，已还原备份，磁盘未变更：\n${v.output}`);
        }
        // 3) 记账 + 排队重载
        writeJournal({
          kind: "reload",
          at: new Date().toISOString(),
          note: params.note,
          files: written,
          backups,
          expectedTools: params.expected_tools ?? [],
          attempts: 0,
        });
        queueReload(pi, params.note ?? `更新 ${written.length} 个文件`);
        return ok(
          `✅ 已写入并校验通过 ${written.length} 个文件：\n${written.map((w) => ` - ${w}`).join("\n")}\n` +
            `备份：${Object.values(backups).filter(Boolean).join("、") || "(均为新文件，无备份)"}\n` +
            `校验结果：\n${v.output}\n\n已排队热重载；结束后调 pi_self_status 核对 stamp 与工具列表。`,
        );
      } catch (e) {
        return fail(e);
      }
    },
  });

  // ---- 工具 4：回滚 ----
  pi.registerTool({
    name: "pi_self_rollback",
    label: "回滚自更新",
    description: "按 journal 还原上一次 pi_self_apply 的备份（新文件会被删除），然后触发一次热重载。",
    parameters: Type.Object({}),
    async execute() {
      const j = readJournal();
      if (!j || j.kind !== "reload" || !j.backups) {
        return ok("没有可回滚的记录（journal 为空或不是 reload 类型）。");
      }
      const restored: string[] = [];
      for (const [abs, bak] of Object.entries(j.backups)) {
        if (bak && existsSync(bak)) {
          copyFileSync(bak, abs);
          restored.push(abs);
        } else {
          rmSync(abs, { force: true });
          restored.push(`${abs}（删除）`);
        }
      }
      clearJournal();
      queueReload(pi, "手动回滚自更新");
      return ok(`已回滚：\n${restored.map((r) => ` - ${r}`).join("\n")}\n并已排队热重载。`);
    },
  });

  // ---- 工具 5：冷重启 ----
  pi.registerTool({
    name: "pi_self_restart",
    label: "重启 pi（续同一会话）",
    description:
      "冷重启：spawn 旁观重启器 → 优雅退出 → 由重启器拉起。Windows 默认把 `pi --session <id>` 注入原控制台输入缓冲区，让原终端里停着的 shell 自己执行 —— 不新开窗口，真·原终端接管（注入失败自动降级新窗口）。仅 Windows 支持注入；POSIX 仍为继承 stdio 直接 spawn。可用 --mode window 显式要求新窗口。",
    parameters: Type.Object({
      reason: Type.Optional(Type.String({ description: "重启原因" })),
      mode: Type.Optional(
        Type.String({
          description: "tty（默认，Windows 上=原终端注入接管）/ window（新开窗口）/ print（仅打印命令，不执行）",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const info = spawnRelauncher(ctx, params.reason ?? "LLM 请求重启", params.mode ?? "tty");
        ctx.shutdown(); // 交互模式下会等本轮结束、彻底空闲后再退出
        return ok(`${info}\n本进程将优雅退出，随后由旁观进程接管同一会话。`);
      } catch (e) {
        return fail(e);
      }
    },
  });

  // ---- 生效核对 / 空闲补发（⚠️ 不再擅自回滚）----
  // 回滚是**破坏性**的（会把用户刚写的文件改回去/删掉）。而热重载需要"会话空闲"才放行，
  // 在活跃对话里可能要等很久 —— 实测踩过：回滚先动手，把待加载的新文件删了，
  // 结果 reload 落地时已经没东西可加载。所以：未落地就**只等 + 补发**，要撤销请显式
  // 调 pi_self_rollback。
  function verifyAndMaybeRecover(ctx: ExtensionContext): void {
    const j = readJournal();
    if (!j || j.kind !== "reload") return;

    const tools = pi.getAllTools().map((t: any) => t.name);
    const missing = (j.expectedTools ?? []).filter((n) => !tools.includes(n));
    const stale = sha256File(SELF_PATH) !== STAMP;
    // “本实例是否是在这条 journal 之后才加载的” = 这次 reload 是否真落地了。
    // 比 stale 更准：手动 reload（不改文件）也能判定。
    const landed = Date.parse(LOADED_AT) > Date.parse(j.at);
    dbg(`verify: landed=${landed} stale=${stale} missing=[${missing.join(",")}] attempts=${j.attempts ?? 0} isIdle=${ctx.isIdle()}`);

    if (landed && missing.length === 0) {
      // 已生效：当前实例就是磁盘最新代码
      clearJournal();
      pi.sendMessage(
        {
          customType: "pi-self-update",
          content: `✅ 自更新已生效（stamp ${STAMP}${j.note ? `，${j.note}` : ""}）`,
          display: true,
        },
        { triggerTurn: false },
      );
      return;
    }

    // 尚未落地：会话空闲就补发（input/agent_settled 都可能带来空闲窗口）
    if (pendingReload && ctx.isIdle()) dispatchReload(pi, "verify: idle");

    // 拖太久就提醒一次（只提醒，不擅自动手）
    const waitedMin = Math.round((Date.now() - Date.parse(j.at)) / 60000);
    if (!j.hinted && Number.isFinite(waitedMin) && waitedMin >= 5) {
      writeJournal({ ...j, hinted: true });
      pi.sendMessage(
        {
          customType: "pi-self-update",
          content: `⏳ 自更新已排队 ${waitedMin} 分钟仍未落地（缺工具：${missing.join(",") || "无"}）。会话空闲时手敲 /reload 可立即生效；若要撤销改动，显式调 pi_self_rollback。`,
          display: true,
        },
        { triggerTurn: false },
      );
    }
  }

  // 本轮 settle 后派发待执行的重载（isStreaming 此时已为 false，reload 不会被拒）
  pi.on("agent_settled", () => {
    flushPendingReload(pi);
  });

  pi.on("session_start", async (event, ctx) => {
    const reason = String((event as { reason?: string } | undefined)?.reason ?? "start");
    const j = readJournal();
    dbg(`session_start reason=${reason} journal=${j?.kind ?? "无"}`);
    if (reason === "reload") {
      // 热重载触发的 session_start ≠ 冷重启：不消费 kind=restart 的 journal（那次重启还没发生）
      if (j?.kind === "reload") verifyAndMaybeRecover(ctx);
      return;
    }
    if (!j) return;
    if (j.kind === "restart") {
      clearJournal();
      pi.sendMessage(
        {
          customType: "pi-self-update",
          content: `🔄 已自动重启并续上原会话（pid ${LOAD_PID}，${LOADED_AT}）。原因：${j.note ?? "(未记录)"}`,
          display: true,
        },
        { triggerTurn: false },
      );
      return;
    }
    verifyAndMaybeRecover(ctx);
  });

  // reload 失败时不会触发 session_start，旧实例还在跑 → 靠后续事件兜底核对
  pi.on("turn_start", (_event, ctx) => {
    dbg("event: turn_start");
    verifyAndMaybeRecover(ctx);
  });
  pi.on("input", (_event, ctx) => {
    dbg(`event: input isIdle=${ctx.isIdle()}`);
    verifyAndMaybeRecover(ctx);
  });
}
