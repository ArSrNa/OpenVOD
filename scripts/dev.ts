#!/usr/bin/env bun
/**
 * scripts/dev.ts — OpenVOD 开发启动器（TS 版，取代原 start.sh / start-admin.sh /
 * start-delivery.sh / start-worker.sh，工作方式见用法）。
 *
 * 用法：
 *   bun scripts/dev.ts                                交互式：勾选服务 + 运行方式
 *   bun scripts/dev.ts admin                          前台管理端（自动后台带起 Worker）
 *   bun scripts/dev.ts delivery                       前台分发端（自动增量编译）
 *   bun scripts/dev.ts worker                         前台 Worker（观察认领 / 转码日志）
 *   bun scripts/dev.ts admin delivery worker          后台启动所选（多选即后台）
 *   bun scripts/dev.ts admin --background             后台单起管理端（--no-worker 可不带 Worker）
 *   bun scripts/dev.ts stop [admin|delivery|worker]   停止（缺省全部；worker → delivery → admin）
 *   bun scripts/dev.ts status                         运行状态（探测健康检查 / pid）
 *   bun scripts/dev.ts logs <服务|all> [-n 行数] [--no-follow]   跟踪日志（默认 tail -f；all 三个一起跟）
 *
 * 组件与端口（跟随根 .env 的 ADMIN_PORT / DELIVERY_LISTEN，缺省 8787 / :9000）：
 *   admin     管理端 UI + API（apps/admin，Next.js 全栈，ADR-0013）    GET /healthz
 *   delivery  分发端（apps/delivery，Go + Chi）                        GET /healthz
 *   worker    转码 Worker（apps/worker，Bun 常驻，ADR-0008）           无端口，pid 判存活
 *
 * 纪律：**worker 必须一起跑**——否则管理端发起的转码任务会一直停在「排队中」
 * （transcode_jobs 无消费者认领）。因此启动 admin 时会自动带上 Worker，`--no-worker` 关闭。
 *
 * 后台进程约定（与旧脚本一致，兼容 .run/ 下既有 pid）：
 *   日志 .run/<服务>.log；pid .run/<服务>.pid；setsid 独立进程组，停止时整组收掉
 *   （`bun --watch` 会吞 SIGTERM，故 TERM 宽限后 SIGKILL 兜底）。
 *
 * 管辖范围：start / stop / status 只认 `.run/*.pid` 记录的进程组。docker compose 起的
 *   admin / worker 容器不在其中：端口被容器占用时 status 会标注「非本启动器」，stop 会
 *   直接给出 `docker compose stop <服务>` 的提示（分布式容器需自行收尾，见 docs/vod/deploy-apps.md）。
 */

import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isInteractive, multiselect, select, unwrap } from "./lib/tui";

// ---------------------------------------------------------------------------
// 基础：路径 / 输出
// ---------------------------------------------------------------------------
const ROOT = resolve(import.meta.dir, "..");
const RUN_DIR = join(ROOT, ".run");
mkdirSync(RUN_DIR, { recursive: true });

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string) => paint("1", s);
const dim = (s: string) => paint("2", s);
const red = (s: string) => paint("31", s);
const green = (s: string) => paint("32", s);
const yellow = (s: string) => paint("33", s);

const println = (s = "") => process.stdout.write(`${s}\n`);
const rel = (p: string) => (p.startsWith(ROOT) ? p.slice(ROOT.length + 1) : p);
const renderCmd = (cmd: string[]) => cmd.map((c) => (c.includes(" ") ? JSON.stringify(c) : c)).join(" ");
const sleep = (ms: number) => Bun.sleep(ms);

type ServiceName = "admin" | "delivery" | "worker";
type Env = Record<string, string>;
const ALL: ServiceName[] = ["admin", "delivery", "worker"];

const pidFile = (s: ServiceName) => join(RUN_DIR, `${s}.pid`);
const logFile = (s: ServiceName) => join(RUN_DIR, `${s}.log`);

const SERVICE_TITLE: Record<ServiceName, string> = {
  admin: "管理端 UI + API（Next.js 全栈）",
  delivery: "分发端（Go + Chi）",
  worker: "转码 Worker（队列消费，无 HTTP 端口）",
};

const isService = (v: string): v is ServiceName => (ALL as string[]).includes(v);

// ---------------------------------------------------------------------------
// .env 加载（镜像 bash `set -a; . .env`：.env 覆盖既有环境变量；支持 $VAR 引用）
// ---------------------------------------------------------------------------
function expandVars(s: string, lookup: (k: string) => string): string {
  return s
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, k: string) => lookup(k))
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, k: string) => lookup(k));
}

function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lookup = (k: string) => out[k] ?? process.env[k] ?? "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const rest = m[2];
    let value: string;
    if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      value = end === -1 ? rest.slice(1) : rest.slice(1, end);
    } else if (rest.startsWith('"')) {
      const end = rest.indexOf('"', 1);
      const body = end === -1 ? rest.slice(1) : rest.slice(1, end);
      value = expandVars(body, lookup);
    } else {
      const hash = rest.search(/\s#/);
      value = expandVars((hash === -1 ? rest : rest.slice(0, hash)).trim(), lookup);
    }
    out[key] = value;
  }
  return out;
}

function ensureEnvFile(): void {
  const file = join(ROOT, ".env");
  if (existsSync(file)) return;
  println("[env] .env 不存在，尝试 scripts/gen-env.sh 生成...");
  const generated = Bun.spawnSync({
    cmd: ["sh", join(ROOT, "scripts", "gen-env.sh")],
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (generated.exitCode === 0 && existsSync(file)) return;
  const example = join(ROOT, ".env.example");
  if (existsSync(example)) {
    writeFileSync(file, readFileSync(example));
    println("[env] 已从 .env.example 生成 .env（开发建议 DB_PROVIDER=sqlite + DATABASE_URL=file:./dev.db）");
  } else {
    println(yellow("[env] 警告：.env 与 .env.example 均不存在，将只用当前环境变量"));
  }
}

let envCache: Env | null = null;
function loadEnv(): Env {
  if (envCache) return envCache;
  ensureEnvFile();
  const env: Env = {};
  for (const [k, v] of Object.entries(process.env)) if (v != null) env[k] = v;
  const file = join(ROOT, ".env");
  if (existsSync(file)) {
    for (const [k, v] of Object.entries(parseDotEnv(readFileSync(file, "utf8")))) {
      env[k] = v;
      process.env[k] = v; // 同步给自身与后续 spawn
    }
  }
  envCache = env;
  return env;
}

const adminPort = (env: Env) => env.ADMIN_PORT || env.PORT || "8787";
const deliveryPort = (env: Env) => (env.DELIVERY_LISTEN || ":9000").replace(/^:/, "");
const serviceUrl = (name: "admin" | "delivery", env: Env) =>
  `http://localhost:${name === "admin" ? adminPort(env) : deliveryPort(env)}/healthz`;
const serviceBase = (name: "admin" | "delivery", env: Env) => serviceUrl(name, env).replace(/\/healthz$/, "");

let deliveryDbFallbackDone = false;
function applyDeliveryDbFallback(env: Env): void {
  if (deliveryDbFallbackDone) return;
  deliveryDbFallbackDone = true;
  const current = env.DELIVERY_DATABASE_URL ?? "";
  const isLocal = current === "" || current.includes("127.0.0.1") || current.includes("localhost");
  if (!isLocal || !env.DATABASE_URL) return;
  println(
    `[env] DELIVERY_DATABASE_URL=${current || "未设置"} → 本地调试回退用 DATABASE_URL（生产请配置受限账号 DSN，ADR-0011）`,
  );
  env.DELIVERY_DATABASE_URL = env.DATABASE_URL;
  process.env.DELIVERY_DATABASE_URL = env.DATABASE_URL;
}

// ---------------------------------------------------------------------------
// 进程 / 探测工具
// ---------------------------------------------------------------------------
function pidAlive(pid: number | null): boolean {
  if (pid == null || Number.isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function readPid(name: ServiceName): number | null {
  try {
    const pid = Number.parseInt(readFileSync(pidFile(name), "utf8").trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

// 4s：Next dev 冷启动按需编译 /healthz 可达 ~2s（Turbopack），2s 会误判「未运行」
async function probeHttp(url: string, timeoutMs = 4000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

const workerAlive = () => pidAlive(readPid("worker"));

async function serviceAlive(name: ServiceName, env: Env): Promise<boolean> {
  return name === "worker" ? workerAlive() : probeHttp(serviceUrl(name, env));
}

/**
 * 端口可达、但不是本启动器起的（无 pid 文件 / pid 已死）——典型：compose 的 openvod-admin 容器。
 * 只提示不拦截：本启动器的管辖范围仅限 `.run/*.pid` 记录的进程组。
 */
async function foreignOwnerHint(name: ServiceName, env: Env): Promise<void> {
  if (name === "worker") return;
  if (pidAlive(readPid(name))) return;
  if (!(await serviceAlive(name, env))) return;
  const portVar = name === "admin" ? "ADMIN_PORT" : "DELIVERY_LISTEN";
  println(yellow(`[${name}] ${serviceUrl(name, env)} 被本启动器之外的进程占用（.run/${name}.pid 不存在）`));
  println(dim(`        compose 部署：docker compose ps 查看 → docker compose stop ${name}（或 down）`));
  println(dim(`        或改 .env 的 ${portVar} 换端口后再起（compose 的端口映射跟随该变量）`));
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal); // setsid 起的进程组：整组收（bun run + bun --watch / next dev）
    return;
  } catch {
    /* 回退到单进程 */
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* 已退出 */
  }
}

function killChildren(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  if (!Bun.which("pkill")) return;
  Bun.spawnSync({
    cmd: ["pkill", signal === "SIGKILL" ? "-9" : "-15", "-P", String(pid)],
    stdout: "ignore",
    stderr: "ignore",
  });
}

function tailLog(name: ServiceName, lines = 12): void {
  const file = logFile(name);
  if (!existsSync(file)) {
    println(dim(`[${name}] 暂无日志（${rel(file)}）`));
    return;
  }
  Bun.spawnSync({ cmd: ["tail", "-n", String(lines), file], stdout: "inherit", stderr: "inherit" });
  println(dim(`（完整日志：${rel(file)}；跟踪：bun scripts/dev.ts logs ${name}）`));
}

function runInheritSync(cmd: string[], env: Env, cwd = ROOT): number {
  return Bun.spawnSync({ cmd, cwd, env, stdout: "inherit", stderr: "inherit" }).exitCode ?? 1;
}

function requireCmd(cmd: string, hint = ""): void {
  if (!Bun.which(cmd)) {
    println(red(`错误：未找到 ${cmd}${hint ? `（${hint}）` : ""}`));
    process.exit(1);
  }
}

function warnFfmpeg(): void {
  if (!Bun.which("ffmpeg") || !Bun.which("ffprobe")) {
    println(yellow("[worker] 警告：未找到 ffmpeg/ffprobe，转码任务会失败（镜像应含，见 .ide/Dockerfile）"));
  }
}

// ---------------------------------------------------------------------------
// 依赖准备 / 编译
// ---------------------------------------------------------------------------
function ensureNodeModules(env: Env): void {
  requireCmd("bun");
  if (existsSync(join(ROOT, "node_modules"))) return;
  println("[deps] 安装 workspace 依赖（bun i）...");
  if (runInheritSync(["bun", "i"], env) !== 0) {
    println(red("[deps] bun i 失败"));
    process.exit(1);
  }
}

function ensureDeps(env: Env): void {
  ensureNodeModules(env);
  // 注意：packages/db/src/index.ts 静态导入两份客户端（Next 打包时需同时可解析），
  // mysql 与 sqlite 生成物必须都存在，与 DB_PROVIDER 取值无关。
  const generated = join(ROOT, "packages", "db", "generated");
  const missing = (["mysql", "sqlite"] as const).filter((kind) => !existsSync(join(generated, kind)));
  if (missing.length === 0) return;
  println(`[deps] 生成 Prisma 客户端（${missing.join(" + ")}）...`);
  for (const kind of missing) {
    if (runInheritSync(["bun", "run", "--cwd", "packages/db", `generate:${kind}`], env) !== 0) {
      println(red(`[deps] generate:${kind} 失败`));
      process.exit(1);
    }
  }
}

function buildDelivery(env: Env): void {
  requireCmd("go", "分发端需要");
  println("[delivery] 编译（go build）...");
  const bin = join(RUN_DIR, "delivery");
  if (runInheritSync(["go", "build", "-o", bin, "."], env, join(ROOT, "apps", "delivery")) !== 0) {
    println(red("[delivery] 编译失败"));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// 后台启动 / 就绪等待
// ---------------------------------------------------------------------------
function spawnBackground(name: ServiceName, cmd: string[], env: Env): number {
  const logFd = openSync(logFile(name), "a");
  const launcher = Bun.which("setsid") ? ["setsid"] : [];
  const proc = Bun.spawn({
    cmd: [...launcher, ...cmd],
    cwd: ROOT,
    env,
    stdin: "ignore",
    stdout: logFd,
    stderr: logFd,
  });
  writeFileSync(pidFile(name), `${proc.pid}\n`);
  proc.unref();
  println(dim(`[${name}] pid ${proc.pid}，日志 ${rel(logFile(name))}`));
  return proc.pid;
}

async function waitReady(name: ServiceName, env: Env, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await serviceAlive(name, env)) return true;
    await sleep(500);
  }
  return serviceAlive(name, env);
}

async function startBackground(name: ServiceName, env: Env): Promise<boolean> {
  if (await serviceAlive(name, env)) {
    const where = name === "worker" ? `pid ${readPid(name)}` : serviceUrl(name, env);
    println(`[${name}] 已在运行，跳过（${where}）`);
    await foreignOwnerHint(name, env);
    return true;
  }
  if (name === "delivery") {
    applyDeliveryDbFallback(env);
    buildDelivery(env);
  }
  if (name === "worker") warnFfmpeg();

  let cmd: string[];
  if (name === "admin") {
    ensureDeps(env);
    cmd = ["bun", "run", "--cwd", "apps/admin", "dev"];
  } else if (name === "worker") {
    cmd = ["bun", "run", "--cwd", "apps/worker", "dev"];
  } else {
    cmd = [join(RUN_DIR, "delivery")];
  }

  println(`[${name}] 启动（后台）：${renderCmd(cmd)}`);
  spawnBackground(name, cmd, env);
  // admin 首编译较慢，给足时间；delivery/worker 秒级
  const timeout = name === "admin" ? 45_000 : 20_000;
  if (await waitReady(name, env, timeout)) {
    println(green(`[${name}] 就绪`) + (name === "worker" ? `（pid ${readPid(name)}）` : `：${serviceUrl(name, env)}`));
    return true;
  }
  println(red(`[${name}] 启动超时/失败（${(timeout / 1000).toFixed(0)}s），最近日志：`));
  tailLog(name, 20);
  return false;
}

function stopService(name: ServiceName): boolean {
  const pid = readPid(name);
  if (pid == null) {
    println(`[${name}] 无 pid 文件，跳过`);
    return true;
  }
  if (!pidAlive(pid)) {
    println(`[${name}] 未在运行（清理残留 pid ${pid}）`);
    rmSync(pidFile(name), { force: true });
    return true;
  }
  signalGroup(pid, "SIGTERM");
  killChildren(pid, "SIGTERM");
  const grace = name === "worker" ? 500 : 1500; // bun --watch 吞 SIGTERM，宽限更短
  const deadline = Date.now() + grace;
  while (Date.now() < deadline && pidAlive(pid)) Bun.sleepSync(100);
  if (pidAlive(pid)) {
    signalGroup(pid, "SIGKILL");
    killChildren(pid, "SIGKILL");
    const killDeadline = Date.now() + 1000;
    while (Date.now() < killDeadline && pidAlive(pid)) Bun.sleepSync(100);
  }
  if (pidAlive(pid)) {
    println(red(`[${name}] 警告：pid ${pid} 在 SIGKILL 后仍存活，请手动处理：kill -9 -- -${pid}`));
    rmSync(pidFile(name), { force: true });
    return false;
  }
  println(`[${name}] 已停止（pid ${pid}）`);
  rmSync(pidFile(name), { force: true });
  return true;
}

// ---------------------------------------------------------------------------
// 前台运行
// ---------------------------------------------------------------------------
async function runForeground(name: ServiceName, cmd: string[], env: Env): Promise<number> {
  println(`[${name}] 启动（前台，Ctrl-C 退出）：${renderCmd(cmd)}`);
  const proc = Bun.spawn({ cmd, cwd: ROOT, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const forward = () => {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* 已退出 */
    }
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  try {
    return await proc.exited;
  } finally {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
  }
}

// ---------------------------------------------------------------------------
// 交互式选择
// ---------------------------------------------------------------------------
/**
 * 交互选择服务与运行方式（@clack/prompts：自带显示宽度处理 / 多行重绘 / Ctrl-C 取消语义，
 * 不再手写 ANSI 重绘——手写版在窄终端 + CJK 宽字符下会因折行错位而残留旧行）。
 * 非 TTY（CI / 管道）由调用方兜底为「全部 + 后台」，不会走到这里。
 */
async function interactiveSelection(env: Env): Promise<{ services: ServiceName[]; mode: "foreground" | "background" } | null> {
  const services = unwrap(
    await multiselect<ServiceName>({
      message: "选择要启动的服务",
      options: ALL.map((name) => ({
        value: name,
        label: name,
        hint:
          name === "worker"
            ? `${SERVICE_TITLE[name]}（无端口，pid 判存活）`
            : `${SERVICE_TITLE[name]} ${serviceBase(name, env)}${name === "admin" ? "（自动带 Worker）" : ""}`,
      })),
      initialValues: [...ALL],
      required: false,
    }),
  );

  if (services.length === 0) return null;
  if (services.length > 1) return { services, mode: "background" };

  const mode = unwrap(
    await select({
      message: "运行方式",
      options: [
        { value: "foreground" as const, label: "前台调试", hint: "日志直接输出，Ctrl-C 退出" },
        {
          value: "background" as const,
          label: "后台常驻",
          hint: `日志 ${rel(logFile(services[0]))}，可 stop / logs`,
        },
      ],
      initialValue: "foreground" as const,
    }),
  );
  return { services, mode };
}

// ---------------------------------------------------------------------------
// 子命令
// ---------------------------------------------------------------------------
async function runBackgroundFlow(services: ServiceName[], env: Env, noWorker: boolean): Promise<number> {
  let ok = true;
  for (const name of services) {
    if (!(await startBackground(name, env))) ok = false;
  }

  // 纪律：只起管理端会让转码任务停在「排队中」，自动补上 Worker
  if (services.includes("admin") && !services.includes("worker") && !noWorker) {
    if (!workerAlive()) {
      println(dim("[worker] 管理端依赖转码队列消费者，自动一并启动（--no-worker 可关闭）"));
      if (!(await startBackground("worker", env))) ok = false;
    }
  }

  println();
  println(bold("OpenVOD 运行状态："));
  for (const name of ALL) {
    if (!(await serviceAlive(name, env))) continue;
    if (name === "worker") println(`  ${green("●")} worker    后台常驻（无端口；bun scripts/dev.ts logs worker）`);
    else println(`  ${green("●")} ${name.padEnd(9)} ${serviceBase(name, env)}`);
  }
  println(dim("停止：bun scripts/dev.ts stop    状态：bun scripts/dev.ts status    日志：bun scripts/dev.ts logs <admin|delivery|worker|all>"));
  return ok ? 0 : 1;
}

async function runForegroundFlow(name: ServiceName, env: Env): Promise<number> {
  if (name === "admin") {
    ensureDeps(env);
    if (await probeHttp(serviceUrl("admin", env))) {
      if (pidAlive(readPid("admin"))) {
        println(`[admin] 已在运行（${serviceBase("admin", env)}）；如需重启：bun scripts/dev.ts stop admin`);
      } else {
        println(`[admin] ${serviceBase("admin", env)} 已被占用，本次不重复启动`);
        await foreignOwnerHint("admin", env);
      }
      return 0;
    }

    let startedWorker = false;
    if (workerAlive()) {
      println("[worker] 已在运行，沿用现有实例（退出时不停止它）");
    } else {
      println("[worker] 启动（后台）：转码队列消费者，日志 .run/worker.log");
      startedWorker = await startBackground("worker", env);
    }

    println(
      `[admin] ${serviceBase("admin", env)}（Ctrl-C 退出${
        startedWorker ? "，本次启动的 worker 一并收掉" : "；worker 沿用已有实例，不动它"
      }）`,
    );
    const code = await runForeground("admin", ["bun", "run", "--cwd", "apps/admin", "dev"], env);
    if (startedWorker) {
      println("[admin] 退出：一并停止本次启动的 worker（要独立常驻请用：bun scripts/dev.ts worker）");
      stopService("worker");
    }
    return code;
  }

  if (name === "delivery") {
    applyDeliveryDbFallback(env);
    if (await probeHttp(serviceUrl("delivery", env))) {
      println(`[delivery] 已在运行，无需重复启动（${serviceUrl("delivery", env)}）`);
      if (pidAlive(readPid("delivery"))) {
        println(`如需重启：bun scripts/dev.ts stop delivery && bun scripts/dev.ts delivery`);
      } else {
        await foreignOwnerHint("delivery", env);
      }
      return 0;
    }
    buildDelivery(env);
    return runForeground("delivery", [join(RUN_DIR, "delivery")], env);
  }

  ensureNodeModules(env);
  warnFfmpeg();
  return runForeground("worker", ["bun", "run", "--cwd", "apps/worker", "dev"], env);
}

async function cmdStatus(env: Env): Promise<number> {
  println("OpenVOD 运行状态：");
  for (const name of ALL) {
    const alive = await serviceAlive(name, env);
    const pid = readPid(name);
    const state = (alive ? "running" : "stopped").padEnd(9);
    const pidText = pidAlive(pid) ? String(pid) : "-";
    const info = name === "worker" ? "转码队列消费（无 HTTP 端口）" : serviceUrl(name, env);
    // running 但无 pid = 端口被别人（典型：compose 容器）占着，不是本启动器起的
    const note = alive && !pidAlive(pid) ? dim("  ← 非本启动器（可能是 compose 容器；stop 不管它）") : "";
    println(`  ${name.padEnd(9)} ${alive ? green(state) : state} (pid ${pidText})  ${info}${note}`);
  }
  return 0;
}

async function cmdStop(services: ServiceName[], env: Env): Promise<number> {
  const targets = services.length ? services : [...ALL].reverse(); // worker → delivery → admin
  let ok = true;
  for (const name of targets) if (!stopService(name)) ok = false;
  // 停完仍可达 = 占用者是本启动器之外的进程（可能是 compose 容器），必须说清楚，否则会误以为 stop 没生效
  for (const name of targets) await foreignOwnerHint(name, env);
  return ok ? 0 : 1;
}

async function cmdLogs(rest: string[], follow: boolean, lines: number): Promise<number> {
  // 支持多服务与 all（all → 三个服务一起跟，等价后台 `all --background` 后最常用的命令）
  const names = ALL.filter((n) => rest.includes(n));
  if (!names.length) {
    println(red("用法：bun scripts/dev.ts logs <admin|delivery|worker|all> [-n 行数] [--no-follow]"));
    println(dim("   all = 同时跟踪三个服务的日志；-n 20 = 只看最后 20 行；--no-follow = 不跟随，打印后退出"));
    return 1;
  }
  const files = names.map((n) => logFile(n));
  const present = files.filter((f) => existsSync(f));
  for (const [i, f] of files.entries()) {
    if (!existsSync(f)) println(dim(`[${names[i]}] 暂无日志（${rel(f)}）——该服务还没起过？`));
  }
  if (!present.length) return 0;

  if (names.length > 1) println(dim(`跟踪 ${present.map(rel).join("  ")}（Ctrl-C 退出）`));
  // 多文件交给同一条 tail：GNU tail 会打「==> 文件 <==」分隔头，避免分不清哪行来自哪个服务
  const cmd = ["tail", "-n", String(lines), ...(follow ? ["-f"] : []), ...present];
  if (!follow) {
    Bun.spawnSync({ cmd, stdout: "inherit", stderr: "inherit" });
    return 0;
  }
  const proc = Bun.spawn({ cmd, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  return await proc.exited;
}

function printHelp(): void {
  println(
    [
      bold("OpenVOD 开发启动器（scripts/dev.ts）"),
      "",
      `${bold("用法")}`,
      "  bun scripts/dev.ts                                交互式：勾选服务 + 运行方式",
      "  bun scripts/dev.ts admin                          前台管理端（自动后台带起 Worker）",
      "  bun scripts/dev.ts delivery                       前台分发端（自动增量编译）",
      "  bun scripts/dev.ts worker                         前台 Worker（观察认领 / 转码日志）",
      "  bun scripts/dev.ts admin delivery worker          后台启动所选（多选即后台）",
      "  bun scripts/dev.ts all --background               后台启动全部（等价旧 ./start.sh）",
      "  bun scripts/dev.ts stop [服务...]                 停止（缺省全部：worker → delivery → admin）",
      "  bun scripts/dev.ts status                         运行状态",
      "  bun scripts/dev.ts logs <服务|all> [-n 行数] [--no-follow]   看日志（默认 tail -f）",
      "",
      `${bold("服务")}    admin（:${adminPort(loadEnv())}）/ delivery（:${deliveryPort(loadEnv())}）/ worker（无端口）`,
      `${bold("选项")}    -d, --background 后台运行；--no-worker 启动 admin 时不自动带 Worker`,
      "",
      dim("纪律：worker 是 transcode_jobs 的唯一消费者，只起 admin 会让转码任务停在「排队中」。"),
      dim("管辖范围：start / stop / status 只管本启动器用 .run/*.pid 起的进程组；"),
      dim("          docker compose 起的 admin / worker 容器用 docker compose ps / stop / down。"),
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// 参数解析 / 入口
// ---------------------------------------------------------------------------
type Command = "run" | "stop" | "status" | "logs" | "help";

function parseArgs(argv: string[]): {
  command: Command;
  services: ServiceName[];
  mode?: "foreground" | "background";
  noWorker: boolean;
  follow: boolean;
  lines: number;
  rest: string[];
} {
  let command: Command = "run";
  let mode: "foreground" | "background" | undefined;
  let noWorker = false;
  let follow = true;
  let lines = 50;
  const services: ServiceName[] = [];
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "stop" || arg === "status" || arg === "logs" || arg === "help") {
      if (command === "run") command = arg;
      else rest.push(arg);
    } else if (arg === "all") {
      services.push(...ALL);
    } else if (isService(arg)) {
      services.push(arg);
    } else if (arg === "-d" || arg === "--background" || arg === "--bg") {
      mode = "background";
    } else if (arg === "-f" || arg === "--foreground" || arg === "--fg") {
      mode = "foreground";
    } else if (arg === "--no-worker") {
      noWorker = true;
    } else if (arg === "--no-follow") {
      follow = false;
    } else if (arg === "-n" || arg === "--lines") {
      const value = Number.parseInt(argv[++i] ?? "", 10);
      if (!Number.isNaN(value)) lines = value;
    } else if (arg === "-h" || arg === "--help") {
      command = "help";
    } else {
      rest.push(arg);
    }
  }
  // 去重（all + 具体服务混写）
  return { command, services: [...new Set(services)], mode, noWorker, follow, lines, rest };
}

async function main(): Promise<number> {
  const cli = parseArgs(process.argv.slice(2));

  if (cli.command === "help") {
    printHelp();
    return 0;
  }
  if (cli.command === "logs") {
    loadEnv();
    return cmdLogs([...cli.services, ...cli.rest], cli.follow, cli.lines);
  }

  const env = loadEnv();
  if (cli.command === "status") return cmdStatus(env);
  if (cli.command === "stop") return cmdStop(cli.services, env);

  let services = cli.services;
  let mode = cli.mode;

  if (services.length === 0 && !mode) {
    if (isInteractive()) {
      const picked = await interactiveSelection(env);
      if (!picked) {
        println("未选择任何服务，退出");
        return 0;
      }
      services = picked.services;
      mode = picked.mode;
    } else {
      services = [...ALL]; // 非 TTY（CI / 管道）：等价旧 ./start.sh
      mode = "background";
    }
  }
  if (services.length === 0) services = [...ALL];

  if (mode === "foreground" && services.length > 1) {
    println(yellow("前台模式一次只能运行一个服务，已切换为后台"));
    mode = "background";
  }
  mode ??= services.length === 1 ? "foreground" : "background";

  return mode === "foreground"
    ? runForegroundFlow(services[0], env)
    : runBackgroundFlow(services, env, cli.noWorker);
}

process.exit(await main());
