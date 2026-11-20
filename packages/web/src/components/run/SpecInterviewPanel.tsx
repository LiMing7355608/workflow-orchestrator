import { Check, Loader2, MessageSquare } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { modelLabel } from '../agents/AgentModelField';
import type { InterviewView } from '../../types/operations';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';

export function SpecInterviewPanel({
  session, busy, canStart, locating, settings, onStart, onAnswer, onReset, related,
}: {
  session: InterviewView | null;
  busy: boolean;
  locating: boolean;
  settings: ReactNode;
  related?: ReactNode;
  canStart: boolean;
  onStart: () => void;
  onAnswer: (answer?: string) => Promise<boolean>;
  onReset: () => void;
}) {
  const [answer, setAnswer] = useState('');

  async function send(text?: string) {
    if (await onAnswer(text)) setAnswer('');
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <MessageSquare className="h-4 w-4 text-accent" strokeWidth={1.8} />
        <h2 className="text-[13px] font-semibold text-ink">设计规格 Agent</h2>
        {session && <span className="text-[11px] text-muted">{session.agentId} · {session.model ? modelLabel(session.model) : '客户端默认模型'}</span>}
        {locating && (
          <Button className="ml-auto" variant="ghost" size="sm" onClick={onReset} disabled={busy}>
            新开访谈
          </Button>
        )}
      </div>
      <div className="space-y-3 p-4">
        {!session ? (
          locating ? <p role="status" className="text-[12px] text-muted">正在恢复访谈记录…</p> : (
            <>
              <p className="text-[12px] leading-5 text-muted">写下一句产品想法并选好目标目录。Agent 每轮提问并给出建议，答完再生成可以确认的规格。</p>
              {settings}
              <Button disabled={!canStart || busy} onClick={onStart}>
                {busy ? '正在启动…' : '开始规格访谈'}
              </Button>
            </>
          )
        ) : (
          <>
            {related}
            {session.rounds.map((round, roundIndex) => (
              <section key={roundIndex} className="rounded-xl border border-line bg-subtle/30 p-3.5">
                <h3 className="text-[12px] font-semibold text-ink">第 {roundIndex + 1} 轮</h3>
                <ol className="mt-2 space-y-3">
                  {round.questions.map((question, index) => (
                    <li key={index} className="text-[12px] leading-5 text-muted">
                      <strong className="text-ink">{index + 1}. {question.title}</strong>
                      <p className="whitespace-pre-wrap break-words">{question.question}</p>
                      <div className="mt-1 rounded-md bg-accent-soft/50 px-2 py-1 text-ink">
                        <span className="text-[10px] font-medium text-accent">推荐答复</span>
                        <p className="whitespace-pre-wrap break-words">{question.recommendation}</p>
                      </div>
                    </li>
                  ))}
                </ol>
                {round.answer && <p className="mt-3 whitespace-pre-wrap break-words border-t border-line pt-2 text-[12px] text-ink"><strong>你的答复</strong> {round.answer}</p>}
              </section>
            ))}
            {session.status === 'thinking' && (
              <p role="status" className="flex items-center gap-2 text-[12px] text-muted">
                <Loader2 className="h-4 w-4 animate-spin text-accent" />
                正在分析当前决策和目标工程…
              </p>
            )}
            {session.status === 'question' && (
              <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); if (answer.trim() && !busy) void send(answer.trim()); }}>
                <textarea
                  value={answer}
                  onChange={(event) => setAnswer(event.target.value)}
                  aria-label="回答规格问题"
                  placeholder="按题号回答，或告诉 Agent 哪些建议需要修改"
                  maxLength={12000}
                  className="min-h-20 w-full resize-y rounded-lg border border-line bg-surface p-2.5 text-[12px] leading-5 outline-none focus:ring-2 focus:ring-accent/20"
                />
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={busy || !answer.trim()}>发送回答</Button>
                  <Button variant="secondary" disabled={busy} onClick={() => void send('同意本轮所有题目的推荐答案。')}>接受本轮建议</Button>
                </div>
              </form>
            )}
            {session.status === 'error' && (
              <>
                <p role="alert" className="text-[12px] text-danger">{session.error}</p>
                <Button variant="secondary" disabled={busy} onClick={() => void send()}>重试这一轮</Button>
              </>
            )}
            {session.status === 'ready' && (
              <div>
                <h3 className="flex items-center gap-2 text-[12px] font-semibold text-ink">
                  <Check className="h-4 w-4 text-success" /> 待确认的设计规格
                </h3>
                <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-subtle/30 p-3 font-sans text-[12px] leading-6 text-ink">{session.spec}</pre>
                <form className="mt-2 flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (answer.trim() && !busy) void send(answer.trim()); }}>
                  <input value={answer} onChange={(event) => setAnswer(event.target.value)} aria-label="规格修订要求" maxLength={12000}
                    placeholder="填入要修改的范围或验收条件" className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 text-[12px] outline-offset-2" />
                  <Button size="sm" variant="secondary" type="submit" disabled={busy || !answer.trim()}>继续完善</Button>
                </form>
                <p className="mt-2 text-[11px] text-muted">检查规格后，点击右侧「确认规格并开始拆解」交给 PM Agent。</p>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
