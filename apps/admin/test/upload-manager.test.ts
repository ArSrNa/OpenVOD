// 客户端上传队列单测（spec.md §9.6，2026-10-01）：
// 上传器与元数据轮询以依赖注入替身注入，不真实发请求。
// 覆盖：入列不自动开始（暂存 PENDING）、「开始上传」批量执行与并发上限（第 3 个排队，
// 前者结束自动开始）、运行中新入列不被拉起、进度换算、取消（中止 + CANCELED）、
// 失败重试（新请求且不拉动待上传）、移除（待上传 / 终态）/ 清空已完成、
// METADATA → DONE(ready) / 超时 → DONE(timeout)、401 → 队列终止、订阅退订。
import { describe, expect, it } from "bun:test";
import {
  UPLOAD_CONCURRENCY,
  UploadManager,
  type UploadExecutor,
  type UploadHandle,
  type UploadTask,
  type UploadTerminalKind,
} from "../src/lib/upload-manager";
import {
  calcUploadPct,
  UploadCanceledError,
  UploadUnauthorizedError,
} from "../src/lib/xhr-upload";

/** 等待微任务 / 宏任务清空（promise 回调在微任务里改写任务状态） */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function makeFile(name: string, size = 1024): File {
  return new File([new Uint8Array(Math.max(0, size))], name);
}

/** 可控上传器替身：记录每次调用；resolve / reject / abort 由用例驱动 */
function makeExecutor() {
  interface Call {
    file: File;
    filename: string;
    onProgress: (loaded: number, pct: number) => void;
    resolve: (r: { mediaId: string }) => void;
    reject: (e: unknown) => void;
    aborts: number;
  }
  const calls: Call[] = [];
  const executor: UploadExecutor = (file, filename, onProgress) => {
    const call = {} as Call;
    const promise = new Promise<{ mediaId: string }>((resolve, reject) => {
      call.resolve = resolve;
      call.reject = reject;
    });
    call.file = file;
    call.filename = filename;
    call.onProgress = onProgress;
    call.aborts = 0;
    calls.push(call);
    const handle: UploadHandle = {
      promise,
      abort: () => {
        call.aborts += 1;
      },
    };
    return handle;
  };
  return { calls, executor };
}

type PollResult = boolean | "hang";

/** 组装被测管理器：上传 / 轮询 / 401 回调全替身，终态事件留档 */
function makeManager() {
  const unauthorized: number[] = [];
  const upload = makeExecutor();
  const polls: string[] = [];
  const pollResults: PollResult[] = [];
  const terminalEvents: { task: UploadTask; kind: UploadTerminalKind }[] = [];
  const manager = new UploadManager({
    upload: upload.executor,
    pollMetadata: async (mediaId) => {
      polls.push(mediaId);
      const result = pollResults.shift();
      if (result === "hang") return new Promise<boolean>(() => {});
      return result ?? true;
    },
    onUnauthorized: () => {
      unauthorized.push(1);
    },
  });
  manager.onTerminal((task, kind) => terminalEvents.push({ task, kind }));
  return { manager, upload, polls, pollResults, unauthorized, terminalEvents };
}

describe("calcUploadPct（进度换算）", () => {
  it("loaded/total 四舍五入，封顶 100，total 为 0 返回 0", () => {
    expect(calcUploadPct(0, 100)).toBe(0);
    expect(calcUploadPct(50, 100)).toBe(50);
    expect(calcUploadPct(1, 3)).toBe(33);
    expect(calcUploadPct(2, 3)).toBe(67);
    expect(calcUploadPct(100, 100)).toBe(100);
    expect(calcUploadPct(150, 100)).toBe(100);
    expect(calcUploadPct(10, 0)).toBe(0);
  });
});

describe("UploadManager 入列与开始上传", () => {
  it("入列只加列表不发起请求（全部待上传）；「开始上传」批量转入执行（spec.md §9.3）", () => {
    const { manager, upload } = makeManager();
    manager.enqueue([makeFile("a.mp4"), makeFile("b.mp4"), makeFile("c.mp4")]);
    expect(upload.calls.length).toBe(0);
    expect(manager.getSnapshot().map((t) => t.status)).toEqual([
      "PENDING",
      "PENDING",
      "PENDING",
    ]);

    manager.startAll();
    expect(upload.calls.length).toBe(UPLOAD_CONCURRENCY);
    expect(upload.calls.map((c) => c.filename)).toEqual(["a.mp4", "b.mp4"]);
    expect(manager.getSnapshot().map((t) => t.status)).toEqual([
      "UPLOADING",
      "UPLOADING",
      "QUEUED",
    ]);
  });

  it("批次内自动接续：前者结束（→ METADATA）让出槽位，第 3 个自动开始（FIFO）", async () => {
    const { manager, upload } = makeManager();
    manager.enqueue([makeFile("a.mp4"), makeFile("b.mp4"), makeFile("c.mp4")]);
    manager.startAll();
    upload.calls[0].resolve({ mediaId: "00000001" });
    await flush();
    expect(upload.calls.map((c) => c.filename)).toEqual(["a.mp4", "b.mp4", "c.mp4"]);
    expect(manager.getSnapshot().find((t) => t.filename === "c.mp4")?.status).toBe("UPLOADING");
  });

  it("运行中新入列保持待上传，不被批次拉起；再次「开始上传」才执行", async () => {
    const { manager, upload } = makeManager();
    manager.enqueue([makeFile("a.mp4"), makeFile("b.mp4")]);
    manager.startAll();
    manager.enqueue([makeFile("c.mp4")]);
    expect(manager.getSnapshot().find((t) => t.filename === "c.mp4")?.status).toBe("PENDING");

    // 槽位释放只消费 QUEUED：c 不被拉起
    upload.calls[0].resolve({ mediaId: "00000001" });
    await flush();
    expect(upload.calls.length).toBe(2);
    expect(manager.getSnapshot().find((t) => t.filename === "c.mp4")?.status).toBe("PENDING");

    // 显式「开始上传」后 c 才执行
    manager.startAll();
    expect(upload.calls.length).toBe(3);
    expect(upload.calls[2].filename).toBe("c.mp4");
  });

  it("size = 0 的任务直接 FAILED，不发起请求（spec.md §9.3 预检）", () => {
    const { manager, upload } = makeManager();
    manager.enqueue([makeFile("empty.mp4", 0)]);
    expect(upload.calls.length).toBe(0);
    const task = manager.getSnapshot()[0];
    expect(task.status).toBe("FAILED");
    expect(task.error).toContain("0");
    expect(task.finishedAt).not.toBeNull();
  });

  it("上传进度写入任务（loadedBytes / pct）；成功后 pct=100、loadedBytes=size", async () => {
    const { manager, upload } = makeManager();
    manager.enqueue([makeFile("a.mp4", 1000)]);
    manager.startAll();
    upload.calls[0].onProgress(250, 25);
    let task = manager.getSnapshot()[0];
    expect(task.pct).toBe(25);
    expect(task.loadedBytes).toBe(250);
    upload.calls[0].resolve({ mediaId: "00000042" });
    await flush();
    task = manager.getSnapshot()[0];
    expect(task.pct).toBe(100);
    expect(task.loadedBytes).toBe(1000);
    expect(task.mediaId).toBe("00000042");
  });
});

describe("UploadManager 取消与重试", () => {
  it("取消上传中任务：状态先置 CANCELED、abort 被调用；拒绝到达后不改写状态", async () => {
    const { manager, upload } = makeManager();
    manager.enqueue([makeFile("a.mp4")]);
    manager.startAll();
    const id = manager.getSnapshot()[0].id;
    manager.cancel(id);
    expect(manager.getSnapshot()[0].status).toBe("CANCELED");
    expect(upload.calls[0].aborts).toBe(1);
    upload.calls[0].reject(new UploadCanceledError());
    await flush();
    expect(manager.getSnapshot()[0].status).toBe("CANCELED");
    expect(manager.activeCount()).toBe(0);
  });

  it("取消排队任务：直接 CANCELED，不发起请求，槽位不受影响", () => {
    const { manager, upload } = makeManager();
    manager.enqueue([makeFile("a.mp4"), makeFile("b.mp4"), makeFile("c.mp4")]);
    manager.startAll();
    const queued = manager.getSnapshot().find((t) => t.filename === "c.mp4")!;
    manager.cancel(queued.id);
    expect(upload.calls.length).toBe(2);
    expect(manager.getSnapshot().find((t) => t.filename === "c.mp4")?.status).toBe("CANCELED");
  });

  it("失败重试：新请求（第 2 次）、pct 归零、error 清空；成功后媒资 ID 落位", async () => {
    const { manager, upload } = makeManager();
    manager.enqueue([makeFile("a.mp4")]);
    manager.startAll();
    upload.calls[0].onProgress(800, 80);
    upload.calls[0].reject(new Error("存储写入失败"));
    await flush();
    let task = manager.getSnapshot()[0];
    expect(task.status).toBe("FAILED");
    expect(task.error).toBe("存储写入失败");

    manager.retry(task.id);
    task = manager.getSnapshot()[0];
    expect(task.status).toBe("UPLOADING"); // 重试即入列执行
    expect(task.pct).toBe(0);
    expect(task.error).toBeNull();
    expect(upload.calls.length).toBe(2);
    expect(upload.calls[1].file).toBe(upload.calls[0].file); // 复用同一 File，不重新读盘

    upload.calls[1].resolve({ mediaId: "00000042" });
    await flush();
    expect(manager.getSnapshot()[0].status).toBe("DONE");
    expect(manager.getSnapshot()[0].mediaId).toBe("00000042");
  });

  it("重试不拉动待上传任务：只有被重试的任务执行（spec.md §9.4）", async () => {
    const { manager, upload } = makeManager();
    manager.enqueue([makeFile("a.mp4"), makeFile("b.mp4")]);
    manager.startAll();
    upload.calls[0].resolve({ mediaId: "00000001" }); // a → METADATA（挂起）
    upload.calls[1].reject(new Error("网络错误")); // b → FAILED
    await flush();
    manager.enqueue([makeFile("c.mp4")]); // 待上传

    manager.retry(manager.getSnapshot().find((t) => t.filename === "b.mp4")!.id);
    await flush();
    expect(upload.calls.length).toBe(3); // 只有 b 重发
    expect(upload.calls[2].filename).toBe("b.mp4");
    expect(manager.getSnapshot().find((t) => t.filename === "c.mp4")?.status).toBe("PENDING");
  });
});

describe("UploadManager 移除与清空", () => {
  it("待上传可移除；METADATA 不可移除；清空已完成只清 DONE / FAILED / CANCELED", async () => {
    const { manager, upload, pollResults } = makeManager();
    pollResults.push("hang"); // a 的元数据轮询挂起 → 停在 METADATA
    manager.enqueue([makeFile("a.mp4"), makeFile("b.mp4"), makeFile("c.mp4")]);

    // 待上传（PENDING）可直接移除
    const c = manager.getSnapshot().find((t) => t.filename === "c.mp4")!;
    manager.remove(c.id);
    expect(manager.getSnapshot().length).toBe(2);

    manager.startAll();
    upload.calls[0].resolve({ mediaId: "00000001" });
    await flush();
    let snap = manager.getSnapshot();
    const a = snap.find((t) => t.filename === "a.mp4")!;
    expect(a.status).toBe("METADATA");

    // METADATA 非终态，移除无效
    manager.remove(a.id);
    expect(manager.getSnapshot().length).toBe(2);

    // b 失败 → 终态
    upload.calls[1].reject(new Error("网络错误"));
    await flush();
    expect(manager.getSnapshot().find((t) => t.filename === "b.mp4")?.status).toBe("FAILED");

    manager.clearFinished();
    snap = manager.getSnapshot();
    expect(snap.length).toBe(1);
    expect(snap[0].filename).toBe("a.mp4");
    expect(manager.activeCount()).toBe(1); // METADATA 计入进行中
  });
});

describe("UploadManager 元数据阶段", () => {
  it("上传成功 → METADATA 轮询 → probe 就绪 → DONE(ready)，终态事件 ready", async () => {
    const { manager, upload, polls, terminalEvents } = makeManager();
    manager.enqueue([makeFile("a.mp4")]);
    manager.startAll();
    upload.calls[0].resolve({ mediaId: "00000042" });
    await flush();
    const task = manager.getSnapshot()[0];
    expect(task.status).toBe("DONE");
    expect(task.metadata).toBe("ready");
    expect(task.mediaId).toBe("00000042");
    expect(polls).toEqual(["00000042"]);
    expect(terminalEvents.at(-1)?.kind).toBe("ready");
  });

  it("轮询序列耗尽 → DONE(timeout)，终态事件 timeout", async () => {
    const { manager, upload, pollResults, terminalEvents } = makeManager();
    pollResults.push(false);
    manager.enqueue([makeFile("a.mp4")]);
    manager.startAll();
    upload.calls[0].resolve({ mediaId: "00000042" });
    await flush();
    const task = manager.getSnapshot()[0];
    expect(task.status).toBe("DONE");
    expect(task.metadata).toBe("timeout");
    expect(terminalEvents.at(-1)?.kind).toBe("timeout");
  });
});

describe("UploadManager 401 终止", () => {
  it("401：在途中止、已排队任务全部 FAILED（登录已过期）、待上传不受影响、跳登录回调触发", async () => {
    const { manager, upload, unauthorized, terminalEvents } = makeManager();
    manager.enqueue([makeFile("a.mp4"), makeFile("b.mp4"), makeFile("c.mp4")]);
    manager.startAll(); // a、b 上传中，c 排队
    manager.enqueue([makeFile("d.mp4")]); // 待上传
    upload.calls[0].reject(new UploadUnauthorizedError());
    await flush();
    const snap = manager.getSnapshot();
    // 已开始的任务全部 FAILED；待上传的 d 保持 PENDING
    expect(snap.find((t) => t.filename === "a.mp4")?.status).toBe("FAILED");
    expect(snap.find((t) => t.filename === "b.mp4")?.status).toBe("FAILED");
    expect(snap.find((t) => t.filename === "c.mp4")?.status).toBe("FAILED");
    expect(snap.find((t) => t.filename === "d.mp4")?.status).toBe("PENDING");
    expect(snap.filter((t) => t.status === "FAILED").every((t) => t.error === "登录已过期")).toBe(
      true,
    );
    expect(upload.calls[1].aborts).toBe(1); // 在途的 b 被中止
    expect(unauthorized.length).toBe(1);
    expect(terminalEvents.filter((e) => e.kind === "unauthorized").length).toBe(1);
    expect(manager.activeCount()).toBe(0);
  });
});

describe("UploadManager React 绑定约定", () => {
  it("subscribe 返回退订函数：退订后不再收到通知，但上传继续（切页不中断）", async () => {
    const { manager, upload } = makeManager();
    let calls = 0;
    const unsubscribe = manager.subscribe(() => {
      calls += 1;
    });
    manager.enqueue([makeFile("a.mp4")]);
    manager.startAll();
    const atStart = calls;
    expect(atStart).toBeGreaterThan(0);
    unsubscribe();
    upload.calls[0].resolve({ mediaId: "00000001" });
    await flush();
    expect(calls).toBe(atStart); // 不再收到通知
    expect(manager.getSnapshot()[0].status).toBe("DONE"); // 上传不受退订影响
  });

  it("getServerSnapshot 恒定同一空引用（SSR 稳定快照）；getSnapshot 变更时整体换新引用", () => {
    const { manager, upload } = makeManager();
    expect(manager.getServerSnapshot()).toBe(manager.getServerSnapshot());
    const before = manager.getSnapshot();
    manager.enqueue([makeFile("a.mp4")]);
    const after = manager.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.length).toBe(1);
    manager.startAll();
    upload.calls[0].resolve({ mediaId: "00000001" });
  });
});
