import { BookOpen, Code2, Download } from 'lucide-react';
import { useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../../lib/cn';
import { Button, buttonStyles } from './Button';

export function MarkdownText({ text, className }: { text: string; className?: string }) {
  const document = /^\s*```(?:markdown|md)[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(text)?.[1] ?? text;
  return <div className={cn('markdown-body', className)}>
    <Markdown skipHtml remarkPlugins={[remarkGfm]} components={{
      a: ({ href, children }) => href && /^(https?:|mailto:)/i.test(href)
        ? <a href={href} target="_blank" rel="noreferrer">{children}</a>
        : <span>{children}</span>,
      img: ({ alt }) => <span>{alt}</span>,
      table: ({ children }) => <div className="markdown-table"><table>{children}</table></div>,
    }}>{document}</Markdown>
  </div>;
}

export function MarkdownDocument({ text, title, filename, downloadHref }: {
  text: string; title: string; filename: string; downloadHref?: string;
}) {
  const [source, setSource] = useState(false);

  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <section aria-label={title} className="min-w-0 overflow-hidden rounded-xl border border-line bg-surface">
    <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-subtle/30 px-3 py-2">
      <div className="flex gap-1" aria-label="Markdown 查看方式">
        <Button type="button" size="sm" variant={source ? 'ghost' : 'secondary'} aria-pressed={!source} onClick={() => setSource(false)}>
          <BookOpen className="size-3.5" />阅读
        </Button>
        <Button type="button" size="sm" variant={source ? 'secondary' : 'ghost'} aria-pressed={source} onClick={() => setSource(true)}>
          <Code2 className="size-3.5" />源文
        </Button>
      </div>
      {downloadHref ? <a className={buttonStyles({ size: 'sm', variant: 'ghost' })} href={downloadHref} download={filename}>
        <Download className="size-3.5" />下载 Markdown
      </a> : <Button type="button" size="sm" variant="ghost" onClick={download}><Download className="size-3.5" />下载 Markdown</Button>}
    </header>
    <div className="workspace-scroll max-h-[min(60dvh,540px)] overflow-auto px-4 py-3" tabIndex={0}>
      {source ? <pre className="whitespace-pre-wrap text-xs leading-6 text-ink [overflow-wrap:anywhere]">{text}</pre>
        : <MarkdownText text={text} />}
    </div>
  </section>;
}
