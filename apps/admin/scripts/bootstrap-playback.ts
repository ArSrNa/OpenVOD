// 播放链路引导（开发 / 首次部署；ADR-0006 §3 / ADR-0007）
//   1) 生成 ES256(P-256) JWT 签名密钥：私钥以 MK(AES-256-GCM) 封装写入 signing_keys（kind=JWT, state=ACTIVE）
//      —— 分发端 login 用它签发 JWT；公钥 JWK 一并入库（便于外部验签）
//   2) 创建 / 重置播放端用户（bcrypt，管理端维护 users 表；分发给播放端登录）
// 用法：bun apps/admin/scripts/bootstrap-playback.ts <username> <password≥8位> [显示名] [--rotate-jwt-key]
// 幂等：已有 ACTIVE JWT 密钥时跳过生成（--rotate-jwt-key 则新增一把并把旧的置 RETIRING）。
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { parseMasterKeys, pickWrappingMasterKey, wrap } from "@openvod/crypto";
import { getDb } from "@openvod/db";

const args = process.argv.slice(2);
const rotate = args.includes("--rotate-jwt-key");
const [username, password, displayName] = args.filter((a) => !a.startsWith("--"));

if (!username || !password || password.length < 8) {
  console.error(
    "用法：bun apps/admin/scripts/bootstrap-playback.ts <username> <password≥8位> [显示名] [--rotate-jwt-key]",
  );
  process.exit(1);
}

const db = getDb<any>();
const mks = parseMasterKeys(process.env.MASTER_KEYS);
const activeMk = pickWrappingMasterKey(mks);

// ---- 1) JWT 签名密钥 ----
const existing = await db.signingKey.findFirst({ where: { kind: "JWT", state: "ACTIVE" } });
if (existing && !rotate) {
  console.log(`[bootstrap] 已有 ACTIVE JWT 密钥（kid=${existing.kid}），跳过生成（--rotate-jwt-key 强制新增）`);
} else {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicJwk = publicKey.export({ format: "jwk" });
  // 私钥材料用 32B P-256 标量（d）而不是 PKCS#8 DER：signing_keys.private_enc 是 VARCHAR(191)，
  // DER 的 hex 会超长（P2000）；标量 hex 120 字符足够，分发端自行推导公钥点。
  const scalar = Buffer.from((privateKey.export({ format: "jwk" }) as { d: string }).d, "base64url");
  if (scalar.length !== 32) {
    console.error(`[bootstrap] 私钥标量长度异常：${scalar.length}（应为 32B）`);
    process.exit(1);
  }
  const kid = `jwt_${randomBytes(8).toString("hex")}`;

  if (existing) {
    // 双 kid 宽限：旧密钥置 RETIRING，分发端启动仍会加载（在途 JWT 到期前可继续验签）
    await db.signingKey.update({ where: { kid: existing.kid }, data: { state: "RETIRING" } });
  }
  await db.signingKey.create({
    data: {
      kid,
      kind: "JWT",
      state: "ACTIVE",
      alg: "ES256",
      publicJwk: JSON.stringify(publicJwk),
      privateEnc: wrap(activeMk.key, scalar).toString("hex"),
    },
  });
  console.log(
    `[bootstrap] JWT 签名密钥已入库：kid=${kid}（MK 封装 v${activeMk.ver}）` +
      (existing ? `；旧 kid=${existing.kid} → RETIRING` : ""),
  );
}

// ---- 2) 播放端用户 ----
const passwordHash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 12 });
const user = await db.user.findUnique({ where: { username } });
if (user) {
  await db.user.update({ where: { username }, data: { passwordHash, status: "ACTIVE" } });
  console.log(`[bootstrap] 已重置播放端用户：${username}（id=${user.id}）`);
} else {
  const created = await db.user.create({
    data: { username, passwordHash, displayName: displayName ?? null, status: "ACTIVE" },
  });
  console.log(`[bootstrap] 已创建播放端用户：${username}（id=${created.id}）`);
}

console.log(
  "[bootstrap] 下一步：重启 delivery 后 login →\n" +
    `  curl -sX POST http://127.0.0.1:9000/v1/auth/login -H 'content-type: application/json' \\\n` +
    `    -d '{"username":"${username}","password":"<密码>"}'`,
);
process.exit(0);
