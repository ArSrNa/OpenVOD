// 版本号唯一真源的静态守卫（仓库约定，见 AGENTS.md §仓库约定 / dev-workflow.md §8）。
//
// 约束内容：
//   ① 根 package.json 的 version 是全仓库唯一版本号，管理端展示只经
//      apps/admin/src/lib/version.ts（APP_VERSION）读取，页面以 prop 下传；
//   ② workspace 子包（apps/*、packages/*）不得再声明 version —— 历史上 admin 曾
//      `import pkg from "../../package.json"` 取本包版本，于是「UI 显示 0.1.0、CNB auto_tag
//      按根 0.2.0 打 tag」，同一仓库两个版本号；
//   ③ 任何源码不得 import / require 非根的 package.json。
//
// 本文件只做**静态扫描**（不连库、不起服务、不依赖 Next），随 `bun test` 一并执行；
// 语义化版本正则与 .cnb.yml auto_tag 阶段的校验保持一致。
import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 本文件位于 apps/admin/test/，仓库根即上溯三级
const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const SELF = relative(REPO_ROOT, fileURLToPath(import.meta.url));
/** 唯一允许读 package.json 的模块（服务端读取后以 prop 下传，避免整份 JSON 进客户端 bundle） */
const VERSION_MODULE = "apps/admin/src/lib/version.ts";
const ROOT_PACKAGE_JSON = "package.json";

/** 需扫描的源码目录；目录内的生成物 / 依赖 / 构建产物一律跳过 */
const SCAN_DIRS = ["apps", "packages", "scripts"];
const SKIP_DIRS = new Set(["node_modules", ".next", "generated", "dist", ".run", "coverage", "openvod"]);

const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;

/** 形如 import x from "…/package.json" / import "…/package.json" / require("…/package.json") */
const PKG_JSON_IMPORTS = [
  /\bfrom\s+["']([^"']*package\.json)["']/g,
  /\bimport\s+["']([^"']*package\.json)["']/g,
  /\brequire\(\s*["']([^"']*package\.json)["']\s*\)/g,
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if ([".ts", ".tsx", ".mts", ".cts"].includes(extname(name))) out.push(full);
  }
  return out;
}

function sourceFiles(): string[] {
  return SCAN_DIRS.flatMap((dir) => walk(join(REPO_ROOT, dir)));
}

/** apps/* 与 packages/* 下的 package.json（Go 应用 apps/delivery 没有，跳过） */
function workspacePackageJsons(): string[] {
  return ["apps", "packages"].flatMap((dir) => {
    const base = join(REPO_ROOT, dir);
    return readdirSync(base)
      .filter((name) => statSync(join(base, name)).isDirectory())
      .map((name) => join(base, name, ROOT_PACKAGE_JSON))
      .filter(existsSync);
  });
}

/** 只扫真正的 import / require 语句行，注释里的示例代码不计 */
function packageJsonImports(file: string): string[] {
  const specifiers: string[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    for (const re of PKG_JSON_IMPORTS) {
      for (const m of line.matchAll(re)) specifiers.push(m[1]);
    }
  }
  return specifiers;
}

test("根 package.json 的 version 是合法语义化版本", () => {
  const root = JSON.parse(readFileSync(join(REPO_ROOT, ROOT_PACKAGE_JSON), "utf8"));
  expect(typeof root.version).toBe("string");
  expect(root.version).toMatch(SEMVER);
});

test("workspace 子包不得再声明 version（版本唯一真源在根 package.json）", () => {
  const offenders = workspacePackageJsons()
    .filter((file) => "version" in JSON.parse(readFileSync(file, "utf8")))
    .map((file) => relative(REPO_ROOT, file));
  expect(offenders).toEqual([]);
});

test("只有 apps/admin/src/lib/version.ts 可以读 package.json，且必须指向根", () => {
  const found = sourceFiles()
    .filter((file) => relative(REPO_ROOT, file) !== SELF)
    .flatMap((file) => packageJsonImports(file).map((specifier) => ({ file: relative(REPO_ROOT, file), specifier })));

  expect(found.map((f) => `${f.file} => ${f.specifier}`)).toEqual([`${VERSION_MODULE} => @root/package.json`]);

  const { specifier } = found[0];
  // 相对写法按导入文件所在目录解析；@root/* 由 apps/admin/tsconfig.json 映射到仓库根
  const resolved = specifier.startsWith(".")
    ? resolve(REPO_ROOT, VERSION_MODULE, "..", specifier)
    : specifier === "@root/package.json"
      ? join(REPO_ROOT, ROOT_PACKAGE_JSON)
      : null;
  expect(resolved).toBe(join(REPO_ROOT, ROOT_PACKAGE_JSON));
});
