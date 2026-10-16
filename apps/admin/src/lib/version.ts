// 版本号唯一真相源：**仓库根 package.json 的 version**（仓库约定，见 AGENTS.md §仓库约定）。
//
// 历史包袱：管理端各页面曾 `import pkg from "../../package.json"` 取本包版本，于是同一个仓库
// 出现两个版本号（根 0.2.0 / apps/admin 0.1.0），UI 上显示的与 CNB auto_tag 用来发版 tag 的
// 不是同一个值。现已收敛：子包 package.json 一律不再声明 version，展示只走本模块。
//
// 为什么用「构建期内联」而不是运行时 fs 读根 package.json：
// `next start` 的 cwd 是 apps/admin，且 Docker / EdgeOne / SCF 各部署形态下根 package.json
// 的存在性与路径都不一致；静态 import 由打包器在构建期求值并内联字符串，任何形态都拿到同一份版本。
//
// 纪律：只允许**服务端**（页面 / API route）引用本模块，再以 prop 下传给客户端组件——
// 避免整份 JSON 进入客户端 bundle。
import rootPkg from "@root/package.json";

/** 展示用版本号（如 "0.2.0"），全仓库唯一来源 */
export const APP_VERSION: string = rootPkg.version;
