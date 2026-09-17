// 创建本地兜底管理员（ADR-0012 §3 双轨 / ADR-0013 better-auth）
// 用法：bun apps/admin/scripts/create-admin.ts <email> <password≥8位> [名称]
import { auth } from "../src/lib/auth";

const [email, password, name] = process.argv.slice(2);
if (!email || !password || password.length < 8) {
  console.error("用法：bun apps/admin/scripts/create-admin.ts <email> <password≥8位> [名称]");
  process.exit(1);
}

const res = await auth.api.signUpEmail({
  body: { email, password, name: name ?? email.split("@")[0] },
});
if ("token" in res && res.token) {
  console.log(`[create-admin] 已创建本地管理员：${email}`);
} else {
  console.error("[create-admin] 创建失败：", JSON.stringify(res).slice(0, 300));
  process.exit(1);
}
process.exit(0);
