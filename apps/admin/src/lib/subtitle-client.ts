// 字幕文本读写（浏览器侧，供字幕预览与字幕编辑共用）：
//   GET /api/admin/media/{id}/subtitles/{trackId}/content → WebVTT 文本（no-store）
//   PUT 同上（原始字节流，服务端就地覆盖同一对象并推进 content_version，spec.md §7.2）
// 错误信封与其它管理端端点一致：{ error: { code, message } }。

interface ApiErrorBody {
  error?: { message?: string };
}

async function readError(res: Response, fallback: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
  return new Error(body?.error?.message ?? `${fallback}（HTTP ${res.status}）`);
}

/** 读取某条轨道的 WebVTT 文本 */
export async function fetchSubtitleVtt(mediaId: string, trackId: string): Promise<string> {
  const res = await fetch(`/api/admin/media/${mediaId}/subtitles/${trackId}/content`, {
    cache: "no-store",
  });
  if (!res.ok) throw await readError(res, "字幕文本读取失败");
  return res.text();
}

/** 覆盖某条轨道的 WebVTT 文本 */
export async function putSubtitleVtt(
  mediaId: string,
  trackId: string,
  vtt: string,
): Promise<void> {
  const res = await fetch(`/api/admin/media/${mediaId}/subtitles/${trackId}/content`, {
    method: "PUT",
    cache: "no-store",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Blob([vtt], { type: "text/vtt" }),
  });
  if (!res.ok) throw await readError(res, "字幕文本保存失败");
}
