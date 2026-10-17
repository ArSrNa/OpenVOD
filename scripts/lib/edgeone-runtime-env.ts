// Makers API 的请求与响应格式依据官方 @edgeone/makers-sdk 0.1.0；Production
// 过滤参数与 edgeone CLI 1.6.41 的 `makers env pull -e production` 保持一致。
const endpoints = {
  china: "https://pages-api.cloud.tencent.com/v1",
  global: "https://pages-api.edgeone.ai/v1",
};
export const runtimeEnvFilename = "openvod-runtime-env.json";
const requiredKeys = ["DATABASE_URL", "MASTER_KEYS"] as const;
export type RuntimeEnv = Record<(typeof requiredKeys)[number], string>;
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function selectRuntimeEnv(rows: unknown): RuntimeEnv {
  if (!Array.isArray(rows)) throw new Error("Makers 未返回生产环境变量列表");
  const selected: Partial<RuntimeEnv> = {};
  for (const key of requiredKeys) {
    const matches = rows.map(record).filter((row) => row.Key === key &&
      (row.Env === undefined || (Array.isArray(row.Env) && (row.Env.length === 0 || row.Env.includes("Production")))));
    if (matches.length !== 1 || typeof matches[0]?.Value !== "string" || !matches[0].Value.trim()) {
      throw new Error(`Makers 生产环境 ${key} 缺失、为空或存在重复配置`);
    }
    selected[key] = matches[0].Value;
  }
  if (!/^[1-9]\d*:[a-fA-F0-9]{64}(?:\s*,\s*[1-9]\d*:[a-fA-F0-9]{64})*$/.test(selected.MASTER_KEYS!.trim())) {
    throw new Error("Makers 生产环境 MASTER_KEYS 格式非法（应为 版本:64位hex，可用逗号分隔多版本）");
  }
  // 只带入函数运行必需的数据库与 MK；其余变量（认证密钥 / EO_SECRET 等）一律不进函数包。
  // EdgeOne 项目的 DATABASE_URL 应使用分发端受限账号（ADR-0011），它与 admin 的进程环境相互独立。
  return selected as RuntimeEnv;
}

export async function fetchRuntimeEnv(
  token: string,
  projectName: string,
  region: "china" | "global",
  fetcher: Fetcher = fetch,
): Promise<RuntimeEnv> {
  async function query(action: string, body: Record<string, unknown>) {
    try {
      const response = await fetcher(endpoints[region], {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ Action: action, ...body }),
      });
      const result = record(await response.json());
      const payload = record(record(result.Data).Response);
      if (!response.ok || (result.Code !== 0 && result.Code !== "0") || payload.Error) throw new Error();
      return payload;
    } catch {
      // API 错误、网络错误或响应体可能包含凭据，禁止将原始内容写入 CI 日志。
      throw new Error(`Makers ${action} 失败，请检查 EO_SECRET、EO_API_REGION 与项目访问权限`);
    }
  }
  const result = await query("DescribePagesProjects", {
    Filters: [{ Name: "Name", Values: [projectName] }], Offset: 0, Limit: 100,
  });
  const projects = Array.isArray(result.Projects) ? result.Projects.map(record).filter((p) => p.Name === projectName) : [];
  if (projects.length !== 1 || typeof projects[0]?.ProjectId !== "string") {
    throw new Error("Makers 未找到唯一的目标项目，拒绝发布未绑定的运行配置");
  }
  const env = await query("DescribePagesProjectEnvs", { ProjectId: projects[0].ProjectId, Env: "Production" });
  return selectRuntimeEnv(env.EnvVars);
}
