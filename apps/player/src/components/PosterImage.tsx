"use client";

import { PictureOutlined } from "@ant-design/icons";
import { useState } from "react";

/** 封面（16:9）：加载失败或缺失时显示占位，不阻塞卡片 */
export function PosterImage({ src, alt }: { src: string | null | undefined; alt: string }) {
  const [failed, setFailed] = useState(false);
  const show = Boolean(src) && !failed;
  return (
    <div
      style={{
        aspectRatio: "16 / 9",
        background: "#14161a",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      {show ? (
        // 预签名直出 URL（可能带加速域名），原生 img 即可；占位走 onError
        <img
          src={src ?? ""}
          alt={alt}
          loading="lazy"
          onError={() => setFailed(true)}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      ) : (
        <PictureOutlined style={{ fontSize: 30, color: "rgba(255,255,255,0.35)" }} />
      )}
    </div>
  );
}
