import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { deleteInterview } from '../../lib/api';
import type { SessionCleanup } from '../../types/operations';
import { Button } from '../ui/Button';

export function cleanupNotice(cleanup?: SessionCleanup): string {
  return [
    cleanup?.deleted ? '已清理 ' + cleanup.deleted + ' 个本地会话' : '',
    cleanup?.archived ? '旧版 Codex 已归档 ' + cleanup.archived + ' 个会话' : '',
    cleanup?.unmanaged ? cleanup.unmanaged + ' 个会话由其客户端管理' : '',
  ].filter(Boolean).join('，');
}

export function DeleteInterviewButton({ id, title, iconOnly, onDeleted, onError, disabled }: {
  id: string;
  title: string;
  iconOnly?: boolean;
  disabled?: boolean;
  onDeleted: (notice: string) => void;
  onError: (message: string) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  async function remove() {
    if (deleting || !window.confirm('删除「' + title + '」的访谈聊天？当前轮会停止，并清理可同步的 CLI 会话。已确认的规格和运行会保留。')) return;
    setDeleting(true);
    onError('');
    try {
      const result = await deleteInterview(id);
      onDeleted(cleanupNotice(result.cleanup));
    } catch (error) {
      onError(error instanceof Error ? error.message : '删除访谈失败。');
    } finally {
      setDeleting(false);
    }
  }
  return <Button size="sm" variant="ghost" disabled={deleting || disabled} onClick={() => void remove()}
    title="删除访谈" aria-label="删除访谈" className="shrink-0 text-muted hover:text-danger">
    <Trash2 className="size-3.5" />{!iconOnly && (deleting ? '正在删除…' : '删除访谈')}
  </Button>;
}
