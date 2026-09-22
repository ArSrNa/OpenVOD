/** 按配置指纹复用实例，并发构建合并；失败可重试，不缓存失败的 Promise。 */
export function reloadable<T>(build: (key: string) => Promise<T>) {
  let current: { key: string; value: T } | undefined;
  const pending = new Map<string, Promise<T>>();
  let latest: string;
  return (key: string): Promise<T> => {
    latest = key;
    if (current?.key === key) return Promise.resolve(current.value);
    const running = pending.get(key);
    if (running) return running;
    const task = Promise.resolve().then(() => build(key)).then((value) => {
      if (latest === key) current = { key, value };
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  };
}

/** 运行配置缓存：失败保留最后有效值，失效后旧在途查询不能写回缓存。 */
export function snapshotCache<T>(load: () => Promise<T>, ttlMs: number, now = Date.now) {
  let good: { value: T; until: number } | undefined;
  let generation = 0;
  let pending: { generation: number; promise: Promise<T> } | undefined;
  const read = (): Promise<T> => {
    if (good && good.until > now()) return Promise.resolve(good.value);
    if (pending?.generation === generation) return pending.promise;
    const version = generation;
    const promise: Promise<T> = Promise.resolve().then(load).then((value) => {
      if (version !== generation) return read();
      good = { value, until: now() + ttlMs };
      return value;
    }).catch((error) => {
      if (version !== generation) return read();
      if (!good) throw error;
      good.until = now() + Math.min(ttlMs, 5000);
      return good.value;
    }).finally(() => {
      if (pending?.promise === promise) pending = undefined;
    });
    pending = { generation: version, promise };
    return promise;
  };
  return { read, invalidate: () => { generation++; if (good) good.until = 0; } };
}
