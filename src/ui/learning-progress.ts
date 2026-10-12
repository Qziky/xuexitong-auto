import type { LearningItem } from '../domain';
import { elapsed } from './Clock';
export const learningPhaseLabels: Record<LearningItem['phase'], string> = {
  waiting: '待处理',
  preparing: '正在启动',
  playing: '正在播放',
  reading: '正在阅读',
  executing: '正在处理题目',
  verifying: '核验平台状态',
  done: '平台确认完成',
  draft: '已保存草稿',
  failed: '执行失败',
  review: '需检查 / 待确认',
};
export function learningProgress(item: LearningItem): string | undefined {
  if (['video', 'audio'].includes(item.type))
    return item.position === undefined
      ? '正在获取播放位置'
      : `${elapsed(item.position * 1000)} / ${item.duration ? elapsed(item.duration * 1000) : '时长待获取'}${item.actualPlaybackRate ? ' · ' + item.actualPlaybackRate + ' 倍速' : ''}${item.speedStatus === 'unsupported' ? '（平台未支持 2 倍速）' : item.speedStatus === 'overridden' ? '（平台已调整速度）' : ''}`;
  if (!['document', 'image'].includes(item.type)) return undefined;
  if (item.totalPages) {
    const pages = `已阅读 ${item.currentPage ?? 0} / ${item.totalPages} 页`;
    return item.phase === 'reading' && item.scrollPosition !== undefined
      ? `${pages} · 滚动位置 ${Math.round(item.scrollPosition)} 像素`
      : pages;
  }
  if (item.readerMode === 'scroll' && item.scrollPosition !== undefined)
    return `滚动位置 ${Math.round(item.scrollPosition)} 像素 · 页数未知`;
  return item.phase === 'preparing'
    ? '正在加载阅读器，页数尚未获取'
    : '尚未读取到阅读器页数';
}
