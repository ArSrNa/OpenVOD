// 播放页路由（Server Component 薄壳；播放交互全部在客户端 PlayView，spec.md §11.4）
import { PlayView } from "@/components/PlayView";

export default async function PlayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PlayView mediaId={id} />;
}
