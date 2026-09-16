#!/usr/bin/env node
/**
 * pi-check.mjs — pi 扩展 / 配置文件的静态校验器
 *
 * 为什么单独起子进程：候选代码如果直接在当前 pi 进程里 import，会污染模块缓存、
 * 可能 hang 住或调用 process.exit()，把正在跑的会话搞坏。子进程里炸掉无所谓。
 *
 * 校验三件事：
 *   1. JSON 文件 → JSON.parse
 *   2. .ts/.js/.mjs → 用 pi 自带的 jiti + 同一套 alias 真正 import 一次（语法 + 依赖解析）
 *   3. 带 --exec（默认）时，若 default export 是函数（扩展工厂），用 stub API 试跑一遍
 *
 * 用法:  node pi-check.mjs --pi-pkg <pi 包目录> [--no-exec] <file...>
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
let piPkg = process.env.PI_PKG_DIR || "";
let doExec = true;
const files = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--pi-pkg") piPkg = argv[++i] ?? "";
  else if (a === "--no-exec") doExec = false;
  else files.push(a);
}

const results = [];
const push = (file, ok, msg) => results.push({ file, ok, msg });

if (!piPkg) {
  console.error("pi-check: 缺少 --pi-pkg <pi 包目录>");
  process.exit(2);
}
if (files.length === 0) {
  console.error("pi-check: 没有待校验文件");
  process.exit(2);
}

/** 与 pi 内置 loader 一致的 alias 表（见 dist/core/extensions/loader.js getAliases） */
function buildAliases() {
  const req = createRequire(join(piPkg, "package.json"));
  const alias = {};
  const put = (specs, target) => {
    for (const s of specs) alias[s] = target;
  };
  const codingAgent = join(piPkg, "dist", "index.js");
  const resolve1 = (spec) => {
    try {
      return req.resolve(spec);
    } catch {
      return undefined;
    }
  };
  let typebox = resolve1("typebox");
  let typeboxCompile = resolve1("typebox/compile");
  let typeboxValue = resolve1("typebox/value");
  let piAi = resolve1("@earendil-works/pi-ai/compat") ?? resolve1("@earendil-works/pi-ai");
  let piTui = resolve1("@earendil-works/pi-tui");
  let piCore = resolve1("@earendil-works/pi-agent-core");

  put(["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"], codingAgent);
  if (piAi) put(["@earendil-works/pi-ai", "@earendil-works/pi-ai/compat", "@mariozechner/pi-ai", "@mariozechner/pi-ai/compat"], piAi);
  if (piTui) put(["@earendil-works/pi-tui", "@mariozechner/pi-tui"], piTui);
  if (piCore) put(["@earendil-works/pi-agent-core", "@mariozechner/pi-agent-core"], piCore);
  if (typebox) put(["typebox", "@sinclair/typebox"], typebox);
  if (typeboxCompile) put(["typebox/compile", "@sinclair/typebox/compile"], typeboxCompile);
  if (typeboxValue) put(["typebox/value", "@sinclair/typebox/value"], typeboxValue);
  return alias;
}

let jiti;
try {
  const req = createRequire(join(piPkg, "package.json"));
  const { createJiti } = req("jiti");
  jiti = createJiti(pathToFileURL(join(piPkg, "dist", "index.js")).href, {
    moduleCache: false,
    alias: buildAliases(),
  });
} catch (e) {
  console.error(`pi-check: 无法初始化 jiti：${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}

/** 记录型 stub：任何方法都能调用，get* 返回空数组，避免工厂里读配置时炸掉 */
function makeStubApi() {
  const calls = [];
  const inner = {};
  const stub = new Proxy(inner, {
    get(_t, key) {
      if (key === "__calls") return calls;
      if (typeof key === "symbol") return undefined;
      if (key === "then") return undefined; // 防止 await 误判为 thenable
      return (...args) => {
        calls.push({ name: String(key), args });
        return String(key).startsWith("get") ? [] : undefined;
      };
    },
    has() {
      return true;
    },
  });
  return stub;
}

for (const raw of files) {
  const file = resolve(raw);
  const ext = extname(file).toLowerCase();
  try {
    if (ext === ".json") {
      JSON.parse(readFileSync(file, "utf8"));
      push(file, true, "JSON 解析通过");
      continue;
    }
    const mod = await jiti.import(file, { default: true });
    if (doExec && typeof mod === "function") {
      const stub = makeStubApi();
      await mod(stub);
      const names = [...new Set((stub.__calls ?? []).map((c) => c.name))];
      push(file, true, `导入通过；stub 试跑通过（registrations: ${names.join(",") || "无"}）`);
    } else {
      push(file, true, `导入通过（default export: ${typeof mod}）`);
    }
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message.split("\n")[0]}` : String(e);
    push(file, false, msg);
  }
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "✅" : "❌"} ${r.file}\n   ${r.msg}`);
}
process.exit(failed > 0 ? 1 : 0);
