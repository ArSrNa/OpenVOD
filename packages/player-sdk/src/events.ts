// 事件模型（player-sdk-spec.md §9：最小集；监听器异常隔离、同步调用）
import type { DeliveryError, PlayerSdkError } from "./errors";

/** 事件类型全表（payload 字段与契约 / api.md 逐字一致，零映射） */
export type PlayerSdkEvent =
  | { type: "auth:changed"; reason: "login" | "refresh" | "switched" | "expired" }
  | {
      type: "playback:refreshed";
      media_id: string;
      manifest_url: string;
      expires_at: string;
      reason: "auto" | "manual" | "retry";
    }
  | { type: "playback:template_changed"; media_id: string; template_id: string; manifest_url: string }
  | {
      type: "error";
      operation: SdkOperation;
      error: DeliveryError | PlayerSdkError;
    };

/** error 事件的 operation 取值（SDK 的对外操作面） */
export type SdkOperation =
  | "login"
  | "list_media"
  | "get_media"
  | "play"
  | "refresh"
  | "switch_template"
  | "subtitle"
  | "auto_refresh";

export type PlayerSdkEventListener = (event: PlayerSdkEvent) => void;

export interface PlayerSdkEmitter {
  /** type = null 表示全量订阅；返回取消函数 */
  on(type: PlayerSdkEvent["type"] | null, listener: PlayerSdkEventListener): () => void;
  emit(event: PlayerSdkEvent): void;
}

/** 极简事件发射器：监听器同步调用，异常被捕获隔离（不得影响 SDK 内部流程） */
export function createEmitter(): PlayerSdkEmitter {
  const typed = new Map<PlayerSdkEvent["type"], Set<PlayerSdkEventListener>>();
  const all = new Set<PlayerSdkEventListener>();

  return {
    on(type, listener) {
      if (type === null) {
        all.add(listener);
        return () => {
          all.delete(listener);
        };
      }
      let set = typed.get(type);
      if (!set) {
        set = new Set();
        typed.set(type, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
    emit(event) {
      // 快照遍历：监听器内取消订阅 / 新增订阅不影响本次分发
      const targets = [...all, ...(typed.get(event.type) ?? [])];
      for (const listener of targets) {
        try {
          listener(event);
        } catch {
          // 监听器异常隔离（spec §9）
        }
      }
    },
  };
}
