#!/usr/bin/env bun
/**
 * 发布 `openvod-jssdk`（npm 官方 registry + CNB 制品库）。
 *
 * 为什么需要这个脚本（而不是直接 `npm publish`）：
 *   1. **版本号唯一真源**是根 `package.json` 的 `version`（仓库约定，SDK 包自身不声明 version——
 *      守卫见 `apps/admin/test/version-source.test.ts`）。脚本读取它并注入发布清单，与 CNB `auto_tag` 同源；
 *   2. 仓库内的 `exports` 指向 TS 源码（workspace 直引，`bun i` 后无需构建），发布产物必须指向 `dist/`，
 *      因此脚本在 `.run/sdk-publish/` 生成一份**发布专用清单**（含 main/module/types/exports → dist）；
 *   3. 发布前断言产物自包含（d.ts 不得残留 `@openvod/contracts` / `shared` 私有包引用，运行时零依赖）。
 *
 * 用法（在仓库根或包目录均可）：
 *   bun run --cwd packages/player-sdk publish:dry           # 双仓库 dry-run（不联网、无需令牌）
 *   bun run --cwd packages/player-sdk publish:npm           # 仅 npm 官方
 *   bun run --cwd packages/player-sdk publish:cnb           # 仅 CNB 制品库
 *   bun run --cwd packages/player-sdk publish:both          # 两个都发
 *   bun packages/player-sdk/scripts/publish.ts --help       # 全部参数
 *
 * 环境变量：
 *   NPM_TOKEN           npm 官方令牌（Access Token，需 automation / bypass-2FA 类型；--registry npm|both 必填）
 *   CNB_NPM_REGISTRY    CNB 制品库地址，形如 https://npm.cnb.cool/<组织>/<制品库>/-/packages/
 *   CNB_NPM_TOKEN       CNB 制品库令牌（流水线内可省略，自动回退内置 CNB_TOKEN）
 *   说明见 https://docs.cnb.cool/zh/artifact/npm.html
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const PKG_DIR = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(PKG_DIR, "..", "..");
const DIST_DIR = join(PKG_DIR, "dist");
const STAGE_DIR = join(REPO_ROOT, ".run", "sdk-publish");

type RegistryTarget = "npm" | "cnb";
type RegistryArg = RegistryTarget | "both";

interface Options {
  registry: RegistryArg;
  version?: string;
  tag: string;
  dryRun: boolean;
  skipBuild: boolean;
  keep: boolean;
  otp?: string;
}

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function log(message: string): void {
  console.log(message);
}

function parseArgs(argv: string[]): Options {
  const options: Options = { registry: "both", tag: "latest", dryRun: false, skipBuild: false, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (!value) fail(`${arg} 缺少参数值`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--registry": {
        const value = next();
        if (value !== "npm" && value !== "cnb" && value !== "both") {
          fail(`--registry 只接受 npm / cnb / both（当前：${value}）`);
        }
        options.registry = value;
        break;
      }
      case "--version":
        options.version = next();
        break;
      case "--tag":
        options.tag = next();
        break;
      case "--otp":
        options.otp = next();
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--skip-build":
        options.skipBuild = true;
        break;
      case "--keep":
        options.keep = true;
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      default:
        fail(`未知参数：${arg}（--help 查看用法）`);
    }
  }
  return options;
}

function printHelp(): void {
  log(`发布 openvod-jssdk 到 npm 官方 / CNB 制品库

用法：bun packages/player-sdk/scripts/publish.ts [options]

选项：
  --registry <npm|cnb|both>  发布目标（缺省 both）
  --version <semver>         覆盖版本号（缺省取根 package.json 的 version）
  --tag <dist-tag>           npm dist-tag（缺省 latest，如 beta / next）
  --otp <code>               两步验证码（npm 账号启用了 2FA 且非 automation 令牌时）
  --dry-run                  只打包并打印内容，不联网、不需要令牌
  --skip-build               复用已有 dist/（跳过 tsup 构建）
  --keep                     保留暂存目录 ${STAGE_DIR}
  -h, --help                 显示本帮助

环境变量：
  NPM_TOKEN                  npm 官方令牌（--registry npm|both 必填）
  CNB_NPM_REGISTRY           CNB 制品库地址：https://npm.cnb.cool/<组织>/<制品库>/-/packages/
  CNB_NPM_TOKEN              CNB 制品库令牌（缺省回退内置 CNB_TOKEN）`);
}

function run(cmd: string, args: string[], opts: { cwd: string; env?: Record<string, string | undefined> }): void {
  const result = Bun.spawnSync([cmd, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    fail(`命令失败（退出码 ${result.exitCode}）：${cmd} ${args.join(" ")}\n  暂存目录保留在 ${STAGE_DIR}，可手工检查或重试`);
  }
}

/** 取制品库地址（缺省报错并给出创建指引；dry-run 用占位地址，保证离线可演练） */
function resolveCnbRegistry(dryRun: boolean): string {
  const raw = (process.env.CNB_NPM_REGISTRY ?? "").trim();
  if (!raw) {
    if (dryRun) {
      log("  ! 未设置 CNB_NPM_REGISTRY，dry-run 使用占位地址演练");
      return "https://npm.cnb.cool/<组织>/<制品库>/-/packages/";
    }
    fail(
      "缺少 CNB 制品库地址：设置 CNB_NPM_REGISTRY=https://npm.cnb.cool/<组织>/<制品库>/-/packages/\n" +
        "  创建方式见 https://docs.cnb.cool/zh/artifact/npm.html（制品库 → 新建 npm 制品库 → 复制地址）",
    );
  }
  const url = raw.endsWith("/") ? raw : `${raw}/`;
  try {
    new URL(url);
  } catch {
    fail(`CNB_NPM_REGISTRY 不是合法 URL：${raw}`);
  }
  return url;
}

/** 写临时 .npmrc（0600；发布后立即删除——令牌绝不留在磁盘） */
function writeNpmrc(file: string, registryUrl: string, token: string): void {
  const parsed = new URL(registryUrl);
  const lines = [`registry=${registryUrl}`, "always-auth=true"];
  if (token) lines.push(`//${parsed.host}${parsed.pathname}:_authToken=${token}`);
  writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
}

function main(): void {
  const options = parseArgs(Bun.argv.slice(2));

  const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")) as {
    name: string;
    description?: string;
    keywords?: string[];
    license?: string;
    engines?: Record<string, string>;
    repository?: unknown;
    homepage?: string;
  };
  const rootPkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version?: string };

  // 版本：唯一真源 = 根 package.json（可用 --version 显式覆盖，用于补发历史版本）
  const version = options.version ?? rootPkg.version ?? "";
  if (!SEMVER.test(version)) {
    fail(`版本号非法：${version}（来源：${options.version ? "--version" : "根 package.json 的 version"}）`);
  }

  // tag 流水线守卫：CNB tag_push 时 CNB_BRANCH 即 tag 名（auto_tag 由根 package.json 的 version 生成），
  // 两者不一致说明 tag 与版本漂移——宁可不发，也不要发出错版本（分支流水线 CNB_BRANCH 非 semver，跳过校验）。
  const buildingTag = (process.env.CNB_BRANCH ?? "").trim();
  if (!options.version && SEMVER.test(buildingTag) && buildingTag !== version) {
    fail(
      `tag 名（${buildingTag}）与根 package.json 的 version（${version}）不一致：请先对齐版本再发布（auto_tag 同口径）`,
    );
  }

  log(`▶ ${pkg.name}@${version}${options.version ? "（--version 覆盖）" : "（版本取自根 package.json）"}${options.dryRun ? " [dry-run]" : ""}`);
  if (SEMVER.test(buildingTag)) log(`· tag 守卫通过：CNB_BRANCH=${buildingTag}`);

  // 1) 构建：tsup → dist/{index.js,index.cjs,index.d.ts}
  if (options.skipBuild) {
    log("· 跳过构建（--skip-build）");
  } else {
    log("· 构建（tsup：ESM + CJS + 单文件 d.ts）");
    run("bun", ["run", "build"], { cwd: PKG_DIR });
  }

  // 2) 产物校验：自包含（发布包零依赖，消费者无需 @openvod/*）
  for (const file of ["index.js", "index.cjs", "index.d.ts"]) {
    if (!existsSync(join(DIST_DIR, file))) fail(`缺少产物 dist/${file}：请先执行 bun run build`);
  }
  const privateImport = /(?:from|require\()\s*["']@openvod\//;
  for (const file of ["index.d.ts", "index.d.cts", "index.js", "index.cjs"]) {
    const target = join(DIST_DIR, file);
    if (!existsSync(target)) {
      if (file.startsWith("index.d")) continue; // d.cts 由 tsup 按需产出
      fail(`缺少产物 dist/${file}：请先执行 bun run build`);
    }
    if (privateImport.test(readFileSync(target, "utf8"))) {
      fail(
        `dist/${file} 仍 import workspace 私有包：发布包必须零依赖（公共类型需自包含镜像，见 src/types.ts）`,
      );
    }
  }

  // 3) 暂存发布清单（仓库内 exports 指向 src 供 workspace 直引，发布产物必须指向 dist）
  rmSync(STAGE_DIR, { recursive: true, force: true });
  mkdirSync(STAGE_DIR, { recursive: true });
  cpSync(DIST_DIR, join(STAGE_DIR, "dist"), { recursive: true });
  cpSync(join(PKG_DIR, "README.md"), join(STAGE_DIR, "README.md"));
  if (existsSync(join(REPO_ROOT, "LICENSE"))) cpSync(join(REPO_ROOT, "LICENSE"), join(STAGE_DIR, "LICENSE"));
  writeFileSync(
    join(STAGE_DIR, "package.json"),
    `${JSON.stringify(
      {
        name: pkg.name,
        version,
        description: pkg.description,
        keywords: pkg.keywords,
        license: pkg.license,
        type: "module",
        sideEffects: false,
        engines: pkg.engines,
        repository: pkg.repository,
        homepage: pkg.homepage,
        main: "./dist/index.cjs",
        module: "./dist/index.js",
        types: "./dist/index.d.ts",
        // 按条件分别给类型：CJS 消费者（node16 解析）必须拿到 .d.cts，否则报 TS1479（ESM 类型被 require 引用）
        exports: {
          ".": {
            import: { types: "./dist/index.d.ts", default: "./dist/index.js" },
            require: { types: "./dist/index.d.cts", default: "./dist/index.cjs" },
          },
        },
        files: ["dist", "README.md", "LICENSE"],
      },
      null,
      2,
    )}\n`,
  );

  // 4) 发布（逐个目标；令牌文件用后即删）
  const targets: RegistryTarget[] = options.registry === "both" ? ["npm", "cnb"] : [options.registry];
  const done: Array<{ target: RegistryTarget; url: string }> = [];

  for (const target of targets) {
    const registryUrl = target === "npm" ? "https://registry.npmjs.org/" : resolveCnbRegistry(options.dryRun);
    const token =
      target === "npm"
        ? (process.env.NPM_TOKEN ?? "").trim()
        : (process.env.CNB_NPM_TOKEN ?? process.env.CNB_TOKEN ?? "").trim();
    if (!options.dryRun && !token) {
      fail(
        target === "npm"
          ? "缺少 npm 令牌：设置 NPM_TOKEN（npmjs.com → Access Tokens，automation 类型可绕过 2FA）"
          : "缺少 CNB 制品库令牌：设置 CNB_NPM_TOKEN（流水线内缺省回退内置 CNB_TOKEN）",
      );
    }

    const npmrcFile = join(STAGE_DIR, `.npmrc-${target}`);
    writeNpmrc(npmrcFile, registryUrl, token);
    try {
      log(`· 发布 → ${registryUrl}${options.dryRun ? "（dry-run，不联网）" : ""}`);
      run(
        "npm",
        [
          "publish",
          "--registry",
          registryUrl,
          "--tag",
          options.tag,
          "--ignore-scripts",
          ...(options.dryRun ? ["--dry-run"] : []),
          ...(options.otp ? ["--otp", options.otp] : []),
        ],
        { cwd: STAGE_DIR, env: { NPM_CONFIG_USERCONFIG: npmrcFile } },
      );
      done.push({ target, url: registryUrl });
    } finally {
      if (existsSync(npmrcFile)) unlinkSync(npmrcFile); // 令牌文件绝不留在磁盘
    }
  }

  // 5) 收尾
  const cnbUrl = done.find((d) => d.target === "cnb")?.url;
  log(`\n✓ ${pkg.name}@${version} 处理完成${options.dryRun ? "（dry-run：未真正上传）" : ""}`);
  for (const item of done) log(`  - ${item.target}: ${item.url}`);
  log(`  安装：npm i ${pkg.name}${options.tag === "latest" ? "" : `@${options.tag}`}${cnbUrl ? `\n  从 CNB 安装：npm i ${pkg.name} --registry=${cnbUrl}` : ""}`);

  if (options.keep) {
    log(`  暂存目录：${STAGE_DIR}（--keep）`);
  } else {
    rmSync(STAGE_DIR, { recursive: true, force: true });
  }
}

main();
