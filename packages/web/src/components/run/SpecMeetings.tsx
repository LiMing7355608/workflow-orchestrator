import { ExternalLink, UsersRound } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { adoptMeeting, fetchMeetings } from '../../lib/api';
import { useApiResource, useLiveRefresh } from '../../lib/use-api';
import type { InterviewView } from '../../types/operations';
import { Button, buttonStyles } from '../ui/Button';

export function SpecMeetings({ session, onAdopt }: { session: InterviewView; onAdopt: (session: InterviewView) => void }) {
  const { data: rooms, source, reload } = useApiResource(() => fetchMeetings(undefined, session.id), []);
  useLiveRefresh(source === 'live', reload, { refreshIntervalMs: 800 });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function adopt(meetingId: string) {
    setPending(true);
    setError('');
    try { onAdopt(await adoptMeeting(session, meetingId)); }
    catch (failure) { setError((failure as Error).message); }
    finally { setPending(false); }
  }

  return <section className="space-y-2 rounded-xl border border-line px-3.5 py-3" aria-label="关联会议">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="flex items-center gap-2 text-xs font-semibold text-ink"><UsersRound className="size-4 text-accent" />关联会议</h3>
      <Link to={'/meetings?spec=' + session.id} className={buttonStyles({ variant: 'secondary', size: 'sm' })}>发起会议</Link>
    </div>
    {!rooms.length && <p className="text-xs leading-5 text-muted">围绕待确认的规格问题邀请多个角色讨论，可将会议方案纳入访谈。</p>}
    {rooms.map((room) => {
      const included = session.meetings?.some((entry) => entry.id === room.id);
      return <div key={room.id} className="flex flex-wrap items-center gap-2 border-t border-line pt-2">
        <Link to={'/meetings/' + room.id} className="inline-flex min-w-0 flex-1 items-center gap-1.5 text-xs font-medium text-accent hover:underline">
          <span className="truncate">{room.title}</span><ExternalLink className="size-3 shrink-0" />
        </Link>
        {room.status === 'complete' && <Button size="sm" variant="secondary" disabled={pending || session.status === 'thinking'}
          onClick={() => void adopt(room.id)}>{included ? '采纳更新方案' : '纳入当前规格'}</Button>}
      </div>;
    })}
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </section>;
}
