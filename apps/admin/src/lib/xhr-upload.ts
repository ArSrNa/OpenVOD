// XHR 流式上传公共实现（spec.md §2 上传协议；§9.4 客户端队列复用）：
// File / Blob 直接作请求体（服务端按 application/octet-stream 流式接收，不经 multipart 缓冲），
// 原实现抽自 MediaList.tsx 的 uploadTo，扩展 abort() 与错误分类（401 / 用户取消）。
// 使用方：封面手动上传（components/MediaList.tsx，服务端中转）；上传队列改走直传（lib/presigned-upload.ts），
// 但继续复用这里的错误类型与进度换算，保证取消 / 401 语义一致。

/** 401（未登录 / 会话过期）：上传队列据此终止整条队列并跳登录页（spec.md §9.4） */
export class UploadUnauthorizedError extends Error {
  constructor() {
    super("登录已过期");
    this.name = "UploadUnauthorizedError";
  }
}

/** 用户主动取消（xhr.abort()）：队列置 CANCELED，不算失败（spec.md §9.2） */
export class UploadCanceledError extends Error {
  constructor() {
    super("已取消");
    this.name = "UploadCanceledError";
  }
}

export interface XhrUploadHandle {
  /** 2xx → resolve 响应 JSON；失败 / 取消 → reject（错误信封 message 优先） */
  promise: Promise<unknown>;
  /** 中止底层请求（已结束的请求为 no-op） */
  abort(): void;
}

/** 进度百分比（0–100 四舍五入封顶；total 未知或为 0 时返回 0） */
export function calcUploadPct(loaded: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.min(100, Math.round((loaded / total) * 100));
}

/** XHR 流式上传：POST 原始字节流，带进度回调（uploaded / total 字节），可中止 */
export function uploadViaXhr(
  url: string,
  file: File | Blob,
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
): XhrUploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<unknown>((resolve, reject) => {
    xhr.open("POST", url);
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded, e.total);
    };
    xhr.onload = () => {
      const body = (xhr.response ?? null) as { error?: { message?: string } } | null;
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body);
      } else if (xhr.status === 401) {
        reject(new UploadUnauthorizedError());
      } else {
        reject(new Error(body?.error?.message ?? `上传失败（HTTP ${xhr.status}）`));
      }
    };
    xhr.onerror = () => reject(new Error("网络错误"));
    xhr.onabort = () => reject(new UploadCanceledError());
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}
