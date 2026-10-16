// 契约镜像的**编译期**门禁：`bun run typecheck` 执行（文件名非 *.test.ts，bun test 不收集）。
//
// 公共 DTO 在 src/types.ts 是自包含镜像（发布包零依赖，声明文件不得出现 @openvod/*）；
// 这里对镜像与 `packages/contracts`（唯一真相源）做双向可赋值断言——任一侧漂移（字段名 / 可空性 /
// 可选性 / 错误码增删）都会让 `bun run typecheck` 失败，从而在 CI 拦住「契约改了、SDK 没跟」。
import type {
  ErrorCode as ContractErrorCode,
  MediaDetail as ContractMediaDetail,
  MediaListItem as ContractMediaListItem,
  PageResponse as ContractPageResponse,
  PlaybackRequest as ContractPlaybackRequest,
  PlaybackSubtitleDTO as ContractPlaybackSubtitleDTO,
  PlaybackTemplateDTO as ContractPlaybackTemplateDTO,
  z,
} from "@openvod/contracts";

import type {
  DeliveryErrorCode,
  MediaDetail,
  MediaListItem,
  MediaPage,
  PlaybackRequest,
  PlaybackSubtitle,
  PlaybackTemplate,
} from "../src";

/** A 与 B 双向可赋值（结构等价） */
type SameShape<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;

type _ErrorCode = Expect<SameShape<DeliveryErrorCode, z.infer<typeof ContractErrorCode>>>;
type _MediaListItem = Expect<SameShape<MediaListItem, z.infer<typeof ContractMediaListItem>>>;
type _MediaDetail = Expect<SameShape<MediaDetail, z.infer<typeof ContractMediaDetail>>>;
type _MediaPage = Expect<SameShape<MediaPage, z.infer<typeof ContractPageResponse>>>;
type _PlaybackSubtitle = Expect<SameShape<PlaybackSubtitle, z.infer<typeof ContractPlaybackSubtitleDTO>>>;
type _PlaybackTemplate = Expect<SameShape<PlaybackTemplate, z.infer<typeof ContractPlaybackTemplateDTO>>>;
type _PlaybackRequest = Expect<SameShape<PlaybackRequest, z.infer<typeof ContractPlaybackRequest>>>;
