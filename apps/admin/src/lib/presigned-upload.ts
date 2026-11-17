// 前端直传对象存储（ADR-0005 上传路径，2026-11-17）：
//   1. POST /api/admin/media/upload/init?filename=… → { id, uploadUrl, … }（服务端生成 ID 与预签名 PUT）
//   2. XHR PUT 预签名 URL：文件字节直接从浏览器到对象存储，管理端不经手
//   3. POST /api/admin/media/upload/complete { id } → 服务端确认对象并触发元数据生成
// 取消 / 失败 → POST /api/admin/media/upload/abort { id } 丢弃占位行与残留对象（best-effort）。
// 进度条来自 xhr.upload.onprogress；错误分类与流式上传一致（401 → 整队终止，abort → CANCELED）。
import { calcUploadPct, UploadCanceledError, UploadUnauthorizedError } from "./xhr-upload";

export interface DirectUploadHandle {
  promise: Promise<{ mediaId: string }>;
  abort(): void;
}

/** 发 JSON 请求并解包管理端信封（401 / 错误 message 优先） */
async function requestJson(
  url: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    cache: "no-store",
    signal,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) throw new UploadUnauthorizedError();
  const payload = (await res.json().catch(() => null)) as
    | { error?: { message?: string } }
    | null;
  if (!res.ok) {
    throw new Error(payload?.error?.message ?? `请求失败（HTTP ${res.status}）`);
  }
  return (payload ?? {}) as Record<string, unknown>;
}

/** 对象存储错误响应是 XML（<Error><Message>…），取可读原因；403 多为跨域规则未放行 PUT */
function storageErrorMessage(status: number, text: string): string {
  let detail = "";
  try {
    if (typeof DOMParser !== "undefined") {
      detail = new DOMParser()
        .parseFromString(text, "application/xml")
        .querySelector("Message")
        ?.textContent?.trim() ?? "";
    }
  } catch {
    // 非 XML 响应：忽略细节
  }
  if (status === 403) {
    return `上传被拒绝（403）${detail ? `：${detail}` : ""}——请检查对象存储的跨域规则是否允许本页域名 PUT`;
  }
  return `上传失败（HTTP ${status}）${detail ? `：${detail}` : ""}`;
}

/** XHR PUT 预签名 URL（需要上传进度，fetch 拿不到） */
function putToPresignedUrl(
  url: string,
  file: File,
  onProgress: (loadedBytes: number, pct: number) => void,
  registerAbort: (abort: () => void) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    registerAbort(() => xhr.abort());
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, calcUploadPct(e.loaded, e.total));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(file.size, 100);
        resolve();
        return;
      }
      reject(new Error(storageErrorMessage(xhr.status, xhr.responseText ?? "")));
    };
    xhr.onerror = () =>
      reject(
        new Error("无法连接对象存储（网络错误或被跨域阻断）——请检查跨域规则是否允许本页域名 PUT"),
      );
    xhr.onabort = () => reject(new UploadCanceledError());
    xhr.send(file);
  });
}

/** 直传一个文件：init → PUT → complete；abort() 中止请求并清理服务端占位 */
export function uploadToStorage(
  file: File,
  filename: string,
  onProgress: (loadedBytes: number, pct: number) => void,
): DirectUploadHandle {
  const controller = new AbortController();
  let mediaId: string | null = null;
  let settled = false;
  let abortXhr: (() => void) | null = null;
  let cleaned = false;

  /** 丢弃服务端占位（取消 / 失败 / 过期）；complete 已响应则跳过——此时媒资已成立 */
  const cleanup = (): void => {
    if (cleaned || !mediaId || settled) return;
    cleaned = true;
    void requestJson("/api/admin/media/upload/abort", { id: mediaId }).catch(() => {});
  };

  const promise = (async (): Promise<{ mediaId: string }> => {
    const init = await requestJson(
      `/api/admin/media/upload/init?filename=${encodeURIComponent(filename)}`,
      undefined,
      controller.signal,
    );
    const id = typeof init.id === "string" ? init.id : "";
    const uploadUrl = typeof init.uploadUrl === "string" ? init.uploadUrl : "";
    if (!id || !uploadUrl) throw new Error("上传初始化失败：响应缺少直传地址");
    mediaId = id;
    await putToPresignedUrl(uploadUrl, file, onProgress, (fn) => {
      abortXhr = fn;
    });
    const done = await requestJson(
      "/api/admin/media/upload/complete",
      { id },
      controller.signal,
    );
    settled = true;
    return { mediaId: typeof done.id === "string" ? done.id : id };
  })().catch((e: unknown) => {
    if (e instanceof UploadUnauthorizedError) throw e; // 会话失效：清理同样会 401，直接交给队列
    cleanup();
    if (controller.signal.aborted) throw new UploadCanceledError();
    throw e;
  });

  return {
    promise,
    abort() {
      // 只拆链路，清理交给上面的 catch：等 PUT / fetch 真正中断后再删，避免对象随后落盘成孤儿
      abortXhr?.();
      controller.abort();
    },
  };
}
