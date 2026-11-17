// 客户端上传队列（spec.md §9，2026-10-01）：模块级单例、纯 TS、不依赖 React，依赖注入便于单测。
// 任务 = 一个文件；状态机单向流转（spec.md §9.2）：
//   QUEUED → UPLOADING → METADATA → DONE；异常 → FAILED / 用户取消 → CANCELED；
//   仅 FAILED / CANCELED 可重试（回 QUEUED，重新入队）。
// 并发上限 UPLOAD_CONCURRENCY = 2（前端常量，非服务端配置）：UPLOADING 占槽位，
// 上传结束（→ METADATA）即让出槽位接续下一个；元数据轮询独立进行，不占上传槽位。
// 切页不中断：单例存活于整个页面会话，组件卸载只解除订阅、不中止 XHR（spec.md §9.1 / §9.4）。
// 不做跨刷新持久化：刷新即丢（未完成的直传由 abort 端点清理占位，§2.1）。
// 2026-11-17：上传改为浏览器直传对象存储（lib/presigned-upload.ts，ADR-0005 上传路径），
// 管理端只发 init / complete / abort 三个小请求，文件字节不经过管理端。
import { pollMetadataReady } from "./metadata-poll";
import { uploadToStorage } from "./presigned-upload";
import { UploadCanceledError, UploadUnauthorizedError } from "./xhr-upload";

/** 上传并发槽位数（前端常量，spec.md §9.4：单请求流式上传独占出口带宽，2 路为折中） */
export const UPLOAD_CONCURRENCY = 2;

export type UploadTaskStatus =
  | "PENDING"
  | "QUEUED"
  | "UPLOADING"
  | "METADATA"
  | "DONE"
  | "FAILED"
  | "CANCELED";

/** 元数据阶段结果（spec.md §9.2：pending 生成中 / ready 就绪 / timeout 轮询序列耗尽） */
export type UploadMetadataState = "pending" | "ready" | "timeout";

/** 终态事件类型（管理端全局提示用，spec.md §9.3；unauthorized = 401 整队终止，单次提示） */
export type UploadTerminalKind = "ready" | "timeout" | "failed" | "unauthorized";

export interface UploadTask {
  /** 客户端生成的任务 ID（仅前端列表用，与服务端媒资 ID 无关） */
  readonly id: string;
  /** 原始文件对象（仅内存持有；重试复用同一对象，不重新读盘） */
  readonly file: File;
  readonly filename: string;
  readonly size: number;
  status: UploadTaskStatus;
  loadedBytes: number;
  /** 0–100（xhr.upload.onprogress 驱动） */
  pct: number;
  /** 成功后的媒资数字 ID（上传响应 `id`） */
  mediaId: string | null;
  error: string | null;
  readonly createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  metadata: UploadMetadataState;
}

export interface UploadHandle {
  promise: Promise<{ mediaId: string }>;
  abort(): void;
}

/** 上传执行器（依赖注入替身用于单测，spec.md §9.6） */
export type UploadExecutor = (
  file: File,
  filename: string,
  onProgress: (loadedBytes: number, pct: number) => void,
) => UploadHandle;

export interface UploadManagerDeps {
  /** 上传执行器（缺省：浏览器直传对象存储，lib/presigned-upload.ts） */
  upload?: UploadExecutor;
  /** 元数据就绪轮询（缺省：复用 pollMetadataReady 按递增间隔查详情，spec.md §2.1 / §9.4） */
  pollMetadata?: (mediaId: string) => Promise<boolean>;
  /** 401 回调（缺省：整页跳 /login；管理端用 Next router 覆盖为 SPA 跳转） */
  onUnauthorized?: () => void;
}

export function isActiveTask(task: UploadTask): boolean {
  return task.status === "QUEUED" || task.status === "UPLOADING" || task.status === "METADATA";
}

function isTerminal(status: UploadTaskStatus): boolean {
  return status === "DONE" || status === "FAILED" || status === "CANCELED";
}

function newTaskId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultDeps(): Required<UploadManagerDeps> {
  return {
    // 缺省执行器：浏览器直传对象存储（init → PUT → complete），字节不经过管理端（ADR-0005）
    upload: (file, filename, onProgress) => uploadToStorage(file, filename, onProgress),
    pollMetadata: (mediaId) =>
      pollMetadataReady(mediaId, {
        fetchDetail: async (id) => {
          const res = await fetch(`/api/admin/media/${id}`, { cache: "no-store" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = (await res.json().catch(() => null)) as { probe?: unknown } | null;
          return { probe: body?.probe ?? null };
        },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      }),
    onUnauthorized: () => {
      if (typeof window !== "undefined") window.location.assign("/login");
    },
  };
}

/** 稳定的 SSR 空快照（getServerSnapshot 必须恒定同一引用，避免无限重渲染，spec.md §9.4） */
const EMPTY_SNAPSHOT: UploadTask[] = [];

export class UploadManager {
  private deps: Required<UploadManagerDeps>;
  private tasks: UploadTask[] = [];
  private snapshot: UploadTask[] = EMPTY_SNAPSHOT;
  private listeners = new Set<() => void>();
  private terminalListeners = new Set<(task: UploadTask, kind: UploadTerminalKind) => void>();
  private handles = new Map<string, UploadHandle>();
  /** 401 后暂停自动调度；重新入队 / 重试（新会话）即解锁 */
  private queueLocked = false;

  constructor(deps: UploadManagerDeps = {}) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  setDeps(deps: UploadManagerDeps): void {
    this.deps = { ...this.deps, ...deps };
  }

  // 箭头函数字段：useSyncExternalStore 以裸引用传入，须绑定 this
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): UploadTask[] => this.snapshot;

  getServerSnapshot = (): UploadTask[] => EMPTY_SNAPSHOT;

  /** 终态事件订阅（管理端全局提示，spec.md §9.3）；unauthorized 只发一次 */
  onTerminal(listener: (task: UploadTask, kind: UploadTerminalKind) => void): () => void {
    this.terminalListeners.add(listener);
    return () => {
      this.terminalListeners.delete(listener);
    };
  }

  /** 进行中任务数（QUEUED / UPLOADING / METADATA，spec.md §9.1 全局入口与离开确认用） */
  activeCount(): number {
    let n = 0;
    for (const task of this.tasks) if (isActiveTask(task)) n++;
    return n;
  }

  /**
   * 入列（spec.md §9.3，2026-10-01 用户定）：一次拖入 N 个文件 = N 条任务，**只加入列表
   * （PENDING）不发起请求**——统一由「开始上传」（startAll）触发；同一文件重复拖入允许
   * （服务端不去重）；预检 size = 0 直接判 FAILED 不发起请求。
   */
  enqueue(files: File[]): void {
    if (!files.length) return;
    const now = Date.now();
    for (const file of files) {
      const empty = file.size <= 0;
      const task: UploadTask = {
        id: newTaskId(),
        file,
        filename: file.name,
        size: file.size,
        status: empty ? "FAILED" : "PENDING",
        loadedBytes: 0,
        pct: 0,
        mediaId: null,
        error: empty ? "文件大小为 0，无法上传" : null,
        createdAt: now,
        startedAt: null,
        finishedAt: empty ? now : null,
        metadata: "pending",
      };
      this.tasks.push(task);
      if (empty) this.emitTerminal(task, "failed");
    }
    this.notify();
  }

  /**
   * 开始上传（spec.md §9.3，2026-10-01 用户定「点击上传再一起上传」）：
   * 把全部待上传（PENDING）任务批量转入排队（QUEUED）并按并发上限执行；
   * 之后批次内自动接续（槽位释放即取下一个 QUEUED），但**不会**拉起此后新入列的 PENDING 任务。
   */
  startAll(): void {
    const pending = this.tasks.filter((t) => t.status === "PENDING");
    if (!pending.length) return;
    this.queueLocked = false; // 401 终止后重新开始 = 已有新会话，恢复调度
    for (const task of pending) task.status = "QUEUED";
    this.notify();
    this.pump();
  }

  /** 取消（spec.md §9.2）：仅 QUEUED / UPLOADING；中止 XHR → CANCELED（服务端按中断回滚占位行） */
  cancel(id: string): void {
    const task = this.find(id);
    if (!task) return;
    if (task.status === "QUEUED") {
      task.status = "CANCELED";
      task.finishedAt = Date.now();
      this.notify();
      return;
    }
    if (task.status === "UPLOADING") {
      task.status = "CANCELED";
      task.finishedAt = Date.now();
      this.notify();
      // 拒绝回调负责清理 handle 并让出槽位（存在「存储已写完、响应未返回」窗口：媒资可能已入库，§9.2）
      this.handles.get(id)?.abort();
    }
  }

  /** 重试（spec.md §9.2）：仅 FAILED / CANCELED → 重新入队（新请求、pct 归零、清 error），复用同一 File */
  retry(id: string): void {
    const task = this.find(id);
    if (!task || (task.status !== "FAILED" && task.status !== "CANCELED")) return;
    this.resetForRetry(task);
    this.notify();
    this.pump();
  }

  /** 批量重试全部 FAILED（spec.md §9.3「重试全部失败」） */
  retryAllFailed(): void {
    const failed = this.tasks.filter((t) => t.status === "FAILED");
    if (!failed.length) return;
    for (const task of failed) this.resetForRetry(task);
    this.notify();
    this.pump();
  }

  /** 移除（spec.md §9.2）：待上传（未发起过请求）与终态可移除；任务内存保留至移除 / 清空（§9.1） */
  remove(id: string): void {
    const task = this.find(id);
    if (!task) return;
    if (task.status !== "PENDING" && !isTerminal(task.status)) return;
    this.tasks = this.tasks.filter((t) => t.id !== id);
    this.notify();
  }

  /** 清空已完成（spec.md §9.2：批量移除 DONE / FAILED / CANCELED） */
  clearFinished(): void {
    if (!this.tasks.some((t) => isTerminal(t.status))) return;
    this.tasks = this.tasks.filter((t) => !isTerminal(t.status));
    this.notify();
  }

  // ---- 内部调度 ----

  private find(id: string): UploadTask | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  private resetForRetry(task: UploadTask): void {
    this.queueLocked = false;
    task.status = "QUEUED";
    task.pct = 0;
    task.loadedBytes = 0;
    task.mediaId = null;
    task.error = null;
    task.metadata = "pending";
    task.startedAt = null;
    task.finishedAt = null;
  }

  /** 填满并发槽位（FIFO）；queueLocked（401）时不再接续排队任务 */
  private pump(): void {
    if (this.queueLocked) return;
    let active = 0;
    for (const t of this.tasks) if (t.status === "UPLOADING") active++;
    for (const t of this.tasks) {
      if (active >= UPLOAD_CONCURRENCY) break;
      if (t.status === "QUEUED") {
        this.start(t);
        active++;
      }
    }
  }

  private start(task: UploadTask): void {
    task.status = "UPLOADING";
    task.startedAt = Date.now();
    task.pct = 0;
    task.loadedBytes = 0;
    task.error = null;
    this.notify();
    let handle: UploadHandle;
    try {
      handle = this.deps.upload(task.file, task.filename, (loadedBytes, pct) => {
        if (task.status !== "UPLOADING") return;
        task.loadedBytes = loadedBytes;
        task.pct = pct;
        this.notify();
      });
    } catch (err) {
      task.status = "FAILED";
      task.error = err instanceof Error ? err.message : String(err);
      task.finishedAt = Date.now();
      this.notify();
      this.emitTerminal(task, "failed");
      return;
    }
    this.handles.set(task.id, handle);
    handle.promise.then(
      (result) => this.onUploadSuccess(task, result.mediaId),
      (err) => this.onUploadError(task, err),
    );
  }

  private onUploadSuccess(task: UploadTask, mediaId: string): void {
    this.handles.delete(task.id);
    if (task.status !== "UPLOADING") {
      this.pump(); // 上传期间被取消 / 终止：槽位照常让出
      return;
    }
    task.mediaId = mediaId;
    task.status = "METADATA";
    task.pct = 100;
    task.loadedBytes = task.size;
    this.notify();
    this.pump();
    void this.awaitMetadata(task);
  }

  /** 元数据阶段（spec.md §9.4）：轮询详情直至 probe 就绪（→ DONE(ready)）或序列耗尽（→ DONE(timeout)） */
  private async awaitMetadata(task: UploadTask): Promise<void> {
    const mediaId = task.mediaId;
    if (!mediaId) return;
    let ready = false;
    try {
      ready = await this.deps.pollMetadata(mediaId);
    } catch {
      ready = false;
    }
    if (task.status !== "METADATA") return; // 期间 401 整队终止等
    task.metadata = ready ? "ready" : "timeout";
    task.status = "DONE";
    task.finishedAt = Date.now();
    this.notify();
    this.emitTerminal(task, ready ? "ready" : "timeout");
  }

  private onUploadError(task: UploadTask, err: unknown): void {
    this.handles.delete(task.id);
    if (err instanceof UploadUnauthorizedError) {
      this.terminateForUnauthorized(task);
      return;
    }
    if (task.status !== "UPLOADING") {
      this.pump(); // 已取消（abort）/ 已终止：只让出槽位，不改写状态
      return;
    }
    task.status = "FAILED";
    task.error =
      err instanceof UploadCanceledError
        ? "已取消"
        : err instanceof Error
          ? err.message
          : String(err);
    task.finishedAt = Date.now();
    this.notify();
    this.emitTerminal(task, "failed");
    this.pump();
  }

  /** 401（spec.md §9.4）：终止队列——在途请求中止、全部未终结任务置 FAILED（「登录已过期」），跳登录页 */
  private terminateForUnauthorized(trigger: UploadTask): void {
    this.queueLocked = true;
    for (const handle of this.handles.values()) {
      try {
        handle.abort();
      } catch {
        // 中止异常忽略
      }
    }
    this.handles.clear();
    const now = Date.now();
    for (const t of this.tasks) {
      if (isActiveTask(t)) {
        t.status = "FAILED";
        t.error = "登录已过期";
        t.finishedAt = now;
      }
    }
    this.notify();
    this.emitTerminal(trigger, "unauthorized");
    this.deps.onUnauthorized();
  }

  private emitTerminal(task: UploadTask, kind: UploadTerminalKind): void {
    for (const listener of this.terminalListeners) {
      try {
        listener(task, kind);
      } catch {
        // 提示失败不影响队列
      }
    }
  }

  /** 快照不可变替换（变更时整体换新引用；任务对象字段就地更新由渲染层按新数组重读） */
  private notify(): void {
    this.snapshot = [...this.tasks];
    for (const listener of this.listeners) listener();
  }
}

/** 页面会话级单例（spec.md §9.4）：任务存内存，切页不丢，刷新 / 关闭即清空 */
export const uploadManager = new UploadManager();

/** 注入 / 覆盖依赖（管理端用 Next router 跳登录页；测试替身同此入口） */
export function configureUploadManager(deps: UploadManagerDeps): void {
  uploadManager.setDeps(deps);
}
