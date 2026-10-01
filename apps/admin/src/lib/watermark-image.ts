// 水印图片格式识别（spec.md §10.2：png / jpg / webp 白名单，**按内容识别**、与扩展名无关，
// 同字幕 §7.3 的内容识别思路）。纯函数、可单测，不依赖 DB / 存储。
// 透传给 ffmpeg 前必须确认真实格式——伪扩展名图片会让 ffprobe / ffmpeg 在转码期才暴露问题。

export type WatermarkImageFormat = "png" | "jpg" | "webp";

/** 上限内已读入内存的字节流 → 魔数识别格式；无法识别返回 null（400 拒绝） */
export function detectImageFormat(bytes: Uint8Array): WatermarkImageFormat | null {
  if (bytes.length < 12) return null;
  // PNG：89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "png";
  }
  // JPEG：FF D8 FF（SOI + 首个 marker 前三字节恒定）
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpg";
  }
  // WebP：RIFF ???? WEBP（RIFF 容器头 + 4 字节小端长度 + "WEBP"）
  const ascii = (offset: number, text: string): boolean => {
    for (let i = 0; i < text.length; i++) {
      if (bytes[offset + i] !== text.charCodeAt(i)) return false;
    }
    return true;
  };
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) {
    return "webp";
  }
  return null;
}

/** 格式 → 存储扩展名（jpeg 归一为 jpg，spec.md §10.1） */
export const WATERMARK_IMAGE_EXTS: Record<WatermarkImageFormat, string> = {
  png: "png",
  jpg: "jpg",
  webp: "webp",
};

/** 格式 → 对象 Content-Type（落存储与浏览器预览共用） */
export const WATERMARK_IMAGE_CONTENT_TYPES: Record<WatermarkImageFormat, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};
