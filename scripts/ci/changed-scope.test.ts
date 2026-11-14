// scripts/ci/changed-scope.sh 的行为测试：在临时仓库里造 tag 与提交，验证「这次发版该建哪几个镜像」。
// 这里锁的是 .cnb.yml tag_push 的构建门控口径——判断错了要么白建镜像，要么该建的不建。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCRIPT = join(import.meta.dir, "changed-scope.sh");
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function run(cmd: string[], cwd: string): string {
  const proc = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} 失败：${proc.stderr.toString()}`);
  }
  return proc.stdout.toString();
}

// 关掉全局签名与身份依赖：临时仓库不该受开发机 / CI 的 git 配置影响
function git(repo: string, ...args: string[]): string {
  return run(["git", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], repo);
}

/** 新建临时仓库并提交一批文件（git 身份用 -c 临时指定，不动任何全局配置） */
function initRepo(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), "openvod-scope-"));
  dirs.push(repo);
  git(repo, "init", "-q", "-b", "main");
  writeAll(repo, files);
  git(repo, "add", "-A");
  git(repo, "-c", "user.email=ci@example.com", "-c", "user.name=ci", "commit", "--no-gpg-sign", "-q", "-m", "init");
  return repo;
}

function writeAll(repo: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), content);
  }
}

function commit(repo: string, files: Record<string, string>): void {
  writeAll(repo, files);
  git(repo, "add", "-A");
  git(repo, "-c", "user.email=ci@example.com", "-c", "user.name=ci", "commit", "--no-gpg-sign", "-q", "-m", "change");
}

/** 跑脚本并解析 ##[set-output ...] 行 */
function scope(repo: string, ...refs: string[]) {
  const out = run(["sh", SCRIPT, ...refs], repo);
  const value = (key: string): string =>
    (out.match(new RegExp(`##\\[set-output ${key}=(.*)\\]`))?.[1] ?? "").trim();
  return {
    worker: value("scope_worker"),
    admin: value("scope_admin"),
    delivery: value("scope_delivery"),
    player: value("scope_player"),
    sdk: value("scope_sdk"),
    retag: value("retag_targets"),
    prev: value("prev_tag"),
  };
}

const BASE_FILES = {
  "package.json": '{\n  "name": "openvod",\n  "version": "1.0.0"\n}\n',
  "bun.lock": "# lock\n",
  "apps/delivery/main.go": "package main\n",
  "apps/worker/src/index.ts": "export {};\n",
  "apps/admin/src/page.tsx": "export {};\n",
  "apps/player/src/page.tsx": "export {};\n",
  "packages/shared/src/index.ts": "export const version = 1;\n",
};

describe("changed-scope", () => {
  test("只改 delivery：只建 delivery，其余补 tag", () => {
    const repo = initRepo(BASE_FILES);
    git(repo, "tag", "1.0.0");
    commit(repo, { "apps/delivery/main.go": "package main // v2\n" });
    git(repo, "tag", "1.1.0");

    const got = scope(repo, "1.0.0", "1.1.0");
    expect(got).toMatchObject({
      worker: "0",
      admin: "0",
      delivery: "1",
      player: "0",
      sdk: "0",
      retag: "worker,admin,player",
      prev: "1.0.0",
    });
  });

  test("改共享包：admin 与 worker 一起重建（两者都引用 workspace 源码）", () => {
    const repo = initRepo(BASE_FILES);
    git(repo, "tag", "1.0.0");
    commit(repo, { "packages/shared/src/index.ts": "export const version = 2;\n" });
    git(repo, "tag", "1.1.0");

    const got = scope(repo, "1.0.0", "1.1.0");
    expect(got).toMatchObject({
      worker: "1",
      admin: "1",
      delivery: "0",
      player: "0",
      sdk: "0",
      retag: "delivery,player",
    });
  });

  test("只改版本号：admin 与 delivery 重建（版本号烘焙进产物），worker / player 跳过", () => {
    const repo = initRepo(BASE_FILES);
    git(repo, "tag", "1.0.0");
    commit(repo, { "package.json": '{\n  "name": "openvod",\n  "version": "1.1.0"\n}\n' });
    git(repo, "tag", "1.1.0");

    const got = scope(repo, "1.0.0", "1.1.0");
    expect(got).toMatchObject({
      worker: "0",
      admin: "1",
      delivery: "1",
      player: "0",
      sdk: "0",
      retag: "worker,player",
    });
  });

  test("只改 SDK：重建 player（引用 workspace 的 SDK）与发 SDK，worker 不受牵连", () => {
    const repo = initRepo({ ...BASE_FILES, "packages/player-sdk/src/index.ts": "export {};\n" });
    git(repo, "tag", "1.0.0");
    commit(repo, { "packages/player-sdk/src/index.ts": "export const a = 1;\n" });
    git(repo, "tag", "1.1.0");

    const got = scope(repo, "1.0.0", "1.1.0");
    expect(got).toMatchObject({
      worker: "0",
      admin: "1", // admin 也依赖 openvod-jssdk
      delivery: "0",
      player: "1",
      sdk: "1",
      retag: "worker,delivery",
    });
  });

  test("没有上一个 tag：退化为全量构建，不静默跳过", () => {
    const repo = initRepo(BASE_FILES);
    commit(repo, { "apps/delivery/main.go": "package main // v2\n" });

    const got = scope(repo);
    expect(got).toMatchObject({
      worker: "1",
      admin: "1",
      delivery: "1",
      player: "1",
      sdk: "1",
      retag: "",
      prev: "",
    });
  });
});
