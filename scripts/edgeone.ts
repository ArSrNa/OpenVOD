/** EdgeOne Makers Go 构建/发布；ADR-0003。Node 生态命令统一由 Bun 执行。 */
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fetchRuntimeEnv, runtimeEnvFilename } from "./lib/edgeone-runtime-env";

const root = resolve(import.meta.dir, "..");
export const projectDir = resolve(root, ".run/edgeone-delivery");
export const cliVersion = "1.6.41";

export async function prepare() {
  await rm(projectDir, { recursive: true, force: true });
  await mkdir(resolve(projectDir, "cloud-functions"), { recursive: true });
  await mkdir(resolve(projectDir, "public"));
  // 只复制 Go 源码与模块文件，避免把 .env、bin、测试 fixture 或整个 monorepo 发布出去。
  for (const name of ["go.mod", "go.sum", "app", "internal"]) {
    await cp(resolve(root, "apps/delivery", name), resolve(projectDir, name), {
      recursive: true,
      filter: (source) => !source.endsWith("_test.go"),
    });
  }
  await cp(resolve(root, "cloud-functions/index.go"), resolve(projectDir, "cloud-functions/index.go"));
  await cp(resolve(root, "edgeone.json"), resolve(projectDir, "edgeone.json"));
  await Bun.write(resolve(projectDir, "package.json"), JSON.stringify({ name: "openvod-delivery", private: true }));
  console.log(`EdgeOne 构建目录已准备：${projectDir}`);
}

export function assertGoRoutes(config: { version?: number; framework?: string; routes?: { src?: string }[] }) {
  // CLI 会把扫描到的第一个框架文件名变成 URL 前缀；必须锁住整个根路径。
  if (config.version !== 3 || config.framework !== "chi" || config.routes?.length !== 1 || config.routes[0]?.src !== "^/(.*)$") {
    throw new Error("EdgeOne Go 产物必须为 Chi 根路径 catch-all ^/(.*)$；请检查 cloud-functions 是否混入业务包或入口被改名");
  }
}

export async function checkArtifact() {
  const output = resolve(projectDir, ".edgeone");
  const functionsDir = resolve(output, "cloud-functions");
  const functions = await readdir(functionsDir);
  if (functions.length !== 1 || functions[0] !== "api-go") {
    throw new Error("EdgeOne 产物必须仅包含 api-go 云函数");
  }
  assertGoRoutes(await Bun.file(resolve(functionsDir, "api-go/config.json")).json());
  const binary = new Uint8Array(await Bun.file(resolve(functionsDir, "api-go/server")).slice(0, 20).arrayBuffer());
  // ELF64 little-endian，e_machine=EM_X86_64。避免把本机 macOS/arm64 产物上传。
  if (binary.length < 20 || binary[0] !== 0x7f || binary[1] !== 0x45 || binary[2] !== 0x4c || binary[3] !== 0x46 || binary[4] !== 2 || binary[5] !== 1 || binary[18] !== 62 || binary[19] !== 0) {
    throw new Error("EdgeOne server 不是 Linux amd64 ELF 二进制");
  }
  console.log("EdgeOne 产物校验通过：Chi ^/(.*)$，Linux amd64 server");
}

function run(command: string[], env = process.env) {
  const result = Bun.spawnSync(command, { cwd: projectDir, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${command[0]} 执行失败（exit ${result.exitCode}）`);
}

if (import.meta.main) {
  try {
    const command = process.argv[2];
    if (command === "prepare") {
      await prepare();
    } else if (command === "build") {
      await prepare();
      run(["go", "build", "-o", "/dev/null", "./cloud-functions/"], { ...process.env, GOOS: "linux", GOARCH: "amd64", CGO_ENABLED: "0" });
      run(["bunx", "--bun", `edgeone@${cliVersion}`, "makers", "build"]);
      await checkArtifact();
    } else if (command === "check") {
      await checkArtifact();
    } else if (command === "deploy") {
      await checkArtifact();
      const token = process.env.EO_SECRET;
      if (!token) throw new Error("EO_SECRET 未配置，请通过 CNB stage imports 提供");
      const region = process.env.EO_API_REGION ?? "china";
      if (region !== "china" && region !== "global") throw new Error("EO_API_REGION 只能为 china 或 global（账号站点，不是加速区域）");
      const runtimePath = resolve(projectDir, ".edgeone/cloud-functions/api-go", runtimeEnvFilename);
      // 每次发布重新取 Production 的原始值；不解析 .env，保留密码中的 #、$、引号等字符。
      // 即使读取失败也清除上一次中断留下的文件，绝不复用旧密钥。
      await rm(runtimePath, { force: true });
      try {
        const runtimeEnv = await fetchRuntimeEnv(token, "openvod-delivery", region);
        await writeFile(runtimePath, JSON.stringify(runtimeEnv), { mode: 0o600, flag: "wx" });
        console.log("Makers Production 引导变量已校验并写入私有 Go 函数包（不输出值）");
        // 显式上传已检查的产物；省略目录会触发另一轮自动构建。
        run(["bunx", "--bun", `edgeone@${cliVersion}`, "makers", "deploy", ".edgeone", "-n", "openvod-delivery", "-e", "production", "-t", token], { ...process.env, EDGEONE_PAGES_API_REGION: region });
      } finally {
        await rm(runtimePath, { force: true });
      }
    } else {
      throw new Error("用法：bun scripts/edgeone.ts <prepare|build|check|deploy>");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "EdgeOne 操作失败");
    process.exitCode = 1;
  }
}
