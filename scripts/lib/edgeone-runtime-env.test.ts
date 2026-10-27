import { describe, expect, it } from "bun:test";
import { fetchRuntimeEnv, selectRuntimeEnv } from "./edgeone-runtime-env";

const values = { DATABASE_URL: "delivery:p#'$\\word@tcp(db.example.com:3306)/vod?tls=true", MASTER_KEYS: `1:${"ab".repeat(32)}` };
const rows = Object.entries(values).map(([Key, Value]) => ({ Key, Value }));
const ok = (payload: object) => Response.json({ Code: 0, Data: { Response: payload } });

describe("Makers 生产引导配置", () => {
  it("绑定确切项目并只读 Production，保留特殊字符且排除其他凭据", async () => {
    const requests: Record<string, unknown>[] = [];
    const result = await fetchRuntimeEnv("deploy-token", "openvod-delivery", "china", async (url, init) => {
      expect(url).toBe("https://pages-api.cloud.tencent.com/v1");
      expect(init.redirect).toBe("error");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer deploy-token");
      const body = JSON.parse(init.body as string);
      requests.push(body);
      return body.Action === "DescribePagesProjects"
        ? ok({ Projects: [{ Name: "openvod-delivery", ProjectId: "makers-test" }] })
        : ok({ EnvVars: [...rows, { Key: "BETTER_AUTH_SECRET", Value: "admin-secret" }, { Key: "EO_SECRET", Value: "deploy-token" }] });
    });
    expect(requests.map((r) => r.Action)).toEqual(["DescribePagesProjects", "DescribePagesProjectEnvs"]);
    expect(requests[1]).toEqual({ Action: "DescribePagesProjectEnvs", ProjectId: "makers-test", Env: "Production" });
    expect(result).toEqual(values);
    expect(JSON.parse(JSON.stringify(result))).toEqual(values);
  });

  it("缺失、空值、重复变量及无效 MK 均阻止发布", () => {
    for (const invalid of [undefined, [], [rows[1]], [...rows, rows[0]], [rows[0], { Key: "MASTER_KEYS", Value: "private-secret" }], [rows[0], { Key: "MASTER_KEYS", Value: "" }]]) {
      expect(() => selectRuntimeEnv(invalid)).toThrow();
      try { selectRuntimeEnv(invalid); } catch (error) { expect(String(error)).not.toContain("private-secret"); }
    }
  });

  it("不选用 Preview 专属变量，接受全环境与 Production 配置", () => {
    expect(() => selectRuntimeEnv(rows.map((row) => ({ ...row, Env: ["Preview"] })))).toThrow("缺失");
    expect(selectRuntimeEnv([{ ...rows[0], Env: [] }, { ...rows[1], Env: ["Production"] }])).toEqual(values);
  });

  it("读取失败时脱敏，并拒绝 HTTP 成功但 API 错误的响应", async () => {
    for (const response of [
      () => Response.json({ Message: "private-secret" }, { status: 403 }),
      () => Response.json({ Code: 105, Message: "private-secret" }),
      () => ok({ Error: { Message: "private-secret" } }),
      () => { throw new Error("private-secret"); },
    ]) {
      const promise = fetchRuntimeEnv("token", "openvod-delivery", "china", async () => response());
      await expect(promise).rejects.toThrow("DescribePagesProjects 失败");
      try { await promise; } catch (error) { expect(String(error)).not.toContain("private-secret"); }
    }
  });

  it("模糊名称搜索不能选中另一个项目，也不能自动创建项目", async () => {
    let calls = 0;
    await expect(fetchRuntimeEnv("token", "openvod-delivery", "china", async () => {
      calls++;
      return ok({ Projects: [{ Name: "openvod-delivery-other", ProjectId: "wrong-project" }] });
    })).rejects.toThrow("唯一的目标项目");
    expect(calls).toBe(1);
  });
});
