import { Download, MessagesSquare } from 'lucide-react';
import { useState } from 'react';
import { fetchBlackboard, postBlackboard } from '../../lib/api';
import { useApiResource, useLiveRefresh } from '../../lib/use-api';
import { Button } from '../ui/Button';

export function RunBlackboard({ runId }: { runId: string }) {
  const { data, source, reload } = useApiResource(() => fetchBlackboard(runId), null);
  useLiveRefresh(source === 'live', reload, { runId, refreshIntervalMs: 600 });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!data?.directory) return null;

  async function publish() {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await postBlackboard(runId, text.trim());
      setText('');
      reload();
    } catch (error) {
      setError(error instanceof Error ? error.message : '共享失败。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="shrink-0 border-b border-line px-3 py-2.5">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-1 text-[12px] font-medium text-ink outline-offset-4">
        <MessagesSquare className="h-4 w-4 text-accent" />
        协作黑板
        <span className="ml-auto text-[11px] text-muted">{data.entries.length}</span>
      </summary>
      <div className="mt-2 space-y-2">
        <div className="break-all text-[10px] text-muted" title={data.directory}>{data.directory}</div>
        {data.hasOutput && (
          <a className="inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:underline" href={'/api/runs/' + encodeURIComponent(runId) + '/output'}>
            <Download className="h-3.5 w-3.5" />
            下载集成产物
          </a>
        )}
        <ul className="max-h-48 space-y-1.5 overflow-y-auto" aria-label="共享消息">
          {data.entries.map((entry) => (
            <li key={entry.id} className="rounded-md bg-subtle/50 px-2 py-1.5 text-[11px]">
              <div className="flex flex-wrap items-center gap-1.5 font-medium text-muted">
                {entry.author}
                {entry.nodeId && <span className="break-all font-mono text-[10px]">{entry.nodeId}</span>}
                <time className="ml-auto text-passive" dateTime={entry.at}>{new Date(entry.at).toLocaleTimeString('zh-CN')}</time>
              </div>
              <p className="mt-1 whitespace-pre-wrap break-words leading-4 text-ink">{entry.text}</p>
            </li>
          ))}
          {!data.entries.length && <li className="text-[11px] text-muted">尚无共享消息。</li>}
        </ul>
        <form onSubmit={(event) => { event.preventDefault(); void publish(); }}>
          <label className="sr-only" htmlFor="blackboard-text">写给本次运行的所有 Agent</label>
          <textarea
            id="blackboard-text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={1500}
            placeholder="共享决定、问题或验收结果"
            className="w-full rounded-md border border-line bg-surface p-2 text-[11px] outline-offset-2"
          />
          <Button size="sm" type="submit" disabled={busy || !text.trim()}>发到黑板</Button>
        </form>
        {error && <p role="alert" className="text-[11px] text-danger">{error}</p>}
      </div>
    </details>
  );
}
