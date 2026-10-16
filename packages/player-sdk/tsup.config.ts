// 发布构建（npm 官方 / CNB 制品库）：ESM + CJS + **单文件** .d.ts。
//
// 为什么用 tsup（而不是 `bun build`）：Bun 不产出 .d.ts；而声明文件必须**打包成单文件**——
// SDK 的公共 DTO 类型以 type-only 引用 workspace 私有包 `@openvod/contracts`（唯一真相源），
// tsup 的 dts（rollup-plugin-dts）会把 `z.infer<...>` 展开内联，发布包因此**零依赖**：
// 消费者无需安装 @openvod/* 也能获得完整类型（scripts/publish.ts 会断言产物中不残留私有包引用）。
//
// platform: "neutral" —— 只用 fetch / AbortController / setTimeout，浏览器、Node 18+、RN 通用。
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm", "cjs"],
  outExtension: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  platform: "neutral",
  treeshake: true,
});
