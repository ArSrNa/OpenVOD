// 12 位随机口令生成（管理端「新建用户 / 重置密码」表单辅助）：
//   - 仅生成后填入表单明文展示，供管理员复制交付；不落库、不写日志；
//   - 字符集为大小写字母 + 数字，剔除易混淆字符（0/O、1/I/l），且保证至少各含 1 位；
//   - 默认 12 位，满足 contracts UserPassword（8–72 位）约束。
// 依赖 Web Crypto（浏览器 / Node 22 的 globalThis.crypto 均可用），无第三方依赖。

const LOWER = "abcdefghijkmnpqrstuvwxyz"; // 去掉易混淆的 l / o
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // 去掉易混淆的 I / O
const DIGITS = "23456789"; // 去掉易混淆的 0 / 1
const ALL = LOWER + UPPER + DIGITS;

/** 无偏随机下标 [0, bound)：拒绝采样消除取模偏差 */
function randomIndex(bound: number): number {
  const limit = Math.floor(0x1_0000_0000 / bound) * bound;
  const buf = new Uint32Array(1);
  let value = 0;
  do {
    crypto.getRandomValues(buf);
    value = buf[0] ?? 0;
  } while (value >= limit);
  return value % bound;
}

/** 生成 `length` 位随机口令（默认 12 位，最少 3 位） */
export function generatePassword(length = 12): string {
  const size = Math.max(3, Math.floor(length));
  const chars = [
    LOWER[randomIndex(LOWER.length)],
    UPPER[randomIndex(UPPER.length)],
    DIGITS[randomIndex(DIGITS.length)],
  ];
  while (chars.length < size) chars.push(ALL[randomIndex(ALL.length)]);
  // Fisher–Yates 洗牌：避免前 3 位固定为「小写 / 大写 / 数字」的类别顺序
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
