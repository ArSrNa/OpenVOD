// 管理端 Control Plane API（ADR-0002：Bun + Hono；ADR-0004 表清单）
// 骨架：/healthz + /v1/admin/* 占位（501），路由实现随 specification 展开。
import { Hono } from "hono";
import { dbHealth } from "@openvod/db";
import { createStorage } from "@openvod/storage";

const app = new Hono();

app.get("/healthz", async (c) => {
  const dbOk = await dbHealth().catch(() => false);
  return c.json({
    status: "ok",
    app: "admin",
    db: dbOk ? "ok" : "unavailable",
    time: new Date().toISOString(),
  });
});

// ---- 控制台 API（ADR-0007：短期 Bearer JWT；审计见 ADR-0004 audit_logs） ----
const v1 = app.basePath("/v1/admin");

v1.use("*", async (c, next) => {
  // TODO(specification)：管理端 JWT 鉴权中间件（独立密钥，ADR-0007）
  await next();
});

// 媒资管理（上传/探测/生命周期）、元数据与自定义数据、字幕管理、用户管理、
// 密钥管理（signing_keys 轮换，ADR-0007）、转码任务管理（ADR-0008）
v1.all("*", (c) =>
  c.json(
    { error: { code: "not_implemented" as const, message: "scaffold：路由随 specification 实现（ADR-0004/0008）" } },
    501,
  ),
);

const port = Number(process.env.ADMIN_PORT ?? 8787);
const storage = createStorage(
  process.env.STORAGE_DRIVER === "s3"
    ? {
        driver: "s3",
        endpoint: process.env.S3_ENDPOINT ?? "",
        region: process.env.S3_REGION ?? "",
        bucket: process.env.S3_BUCKET ?? "",
        accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
        publicBaseUrl: process.env.CDN_BASE_URL,
      }
    : {
        driver: "local",
        root: process.env.STORAGE_LOCAL_ROOT ?? "./data/storage",
        publicBaseUrl: process.env.STORAGE_PUBLIC_BASE_URL,
      },
);
console.log(`[admin] storage driver = ${process.env.STORAGE_DRIVER ?? "local"}`);

Bun.serve({ port, fetch: app.fetch, idleTimeout: 60 });
console.log(`[admin] listening on :${port}`);
export { app, storage };
