/**
 * env 值规范化（服务端 / 客户端共用）。
 *
 * 背景：`docker run --env-file .env` **不剥**取值里的外层引号（`KEY="v"` → 值是 `"v"` 含引号），
 * 而 compose 的 `env_file` 与 shell 的 `set -a; . .env` 都会剥——两种容器注入路径取值不一致，
 * 带引号的 URL / 账号会直接让 fetch 失败。这里统一剥掉，保证任何注入路径都拿到净值。
 */

/** 剥外层成对引号（单双引号均可，含前后空白） */
export function stripQuotes(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/** URL / 账号类 env：trim + 剥引号（口令等敏感值如需保留空白请直接用 stripQuotes） */
export function envValue(raw: string | undefined): string {
  return stripQuotes(raw ?? "");
}
