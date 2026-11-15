import {
  ArrowRight,
  ChevronRight,
  FileText,
  ImagePlus,
  Info,
  Paperclip,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
} from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Field } from '../components/ui/Field';
import { Segmented } from '../components/ui/Segmented';
import { cn } from '../lib/cn';
import { formatFileSize } from '../lib/format';
import { usePageTitle } from '../lib/use-page-title';

type Granularity = 'coarse' | 'medium' | 'fine';
type Parallelism = '2' | '4' | '6';
type ReviewRounds = '1' | '2' | '3';

interface Attachment {
  id: string;
  file: File;
  previewUrl?: string;
}

const MAX_FILES = 6;
const MAX_FILE_SIZE = 10 * 1024 * 1024;

const granularityOptions: Array<{ value: Granularity; label: string }> = [
  { value: 'coarse', label: '粗' },
  { value: 'medium', label: '中' },
  { value: 'fine', label: '细' },
];

const parallelismOptions: Array<{ value: Parallelism; label: string }> = [
  { value: '2', label: '2' },
  { value: '4', label: '4' },
  { value: '6', label: '6' },
];

const reviewOptions: Array<{ value: ReviewRounds; label: string }> = [
  { value: '1', label: '1 轮' },
  { value: '2', label: '2 轮' },
  { value: '3', label: '3 轮' },
];

function createId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

function AttachmentCard({
  item,
  onRemove,
}: {
  item: Attachment;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-subtle/40 p-2">
      {item.previewUrl ? (
        <img
          src={item.previewUrl}
          alt={item.file.name}
          className="h-9 w-9 shrink-0 rounded-md object-cover"
        />
      ) : (
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-line bg-surface text-muted">
          <FileText className="h-4 w-4" strokeWidth={1.8} />
        </span>
      )}

      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] font-medium text-ink">
          {item.file.name}
        </p>
        <p className="text-[10px] text-passive">
          {formatFileSize(item.file.size)}
        </p>
      </div>

      <button
        type="button"
        aria-label={`移除 ${item.file.name}`}
        onClick={() => onRemove(item.id)}
        className="grid h-7 w-7 place-items-center rounded-md text-passive transition-colors hover:bg-surface hover:text-ink"
      >
        <X className="h-3.5 w-3.5" strokeWidth={1.8} />
      </button>
    </div>
  );
}

export function NewRunPage() {
  usePageTitle('新建运行');

  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [granularity, setGranularity] = useState<Granularity>('medium');
  const [parallelism, setParallelism] = useState<Parallelism>('4');
  const [reviewRounds, setReviewRounds] = useState<ReviewRounds>('2');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef<Attachment[]>([]);
  attachmentsRef.current = attachments;

  useEffect(
    () => () => {
      attachmentsRef.current.forEach((item) => {
        if (item.previewUrl) {
          URL.revokeObjectURL(item.previewUrl);
        }
      });
    },
    [],
  );

  function addFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) {
      return;
    }

    setSubmitted(false);

    const incoming = Array.from(fileList);
    const accepted: Attachment[] = [];
    let nextError: string | null = null;

    for (const file of incoming) {
      if (attachments.length + accepted.length >= MAX_FILES) {
        nextError = `最多添加 ${MAX_FILES} 个附件`;
        break;
      }
      if (file.size > MAX_FILE_SIZE) {
        nextError = `「${file.name}」超过 10MB`;
        continue;
      }

      accepted.push({
        id: createId(),
        file,
        previewUrl: file.type.startsWith('image/')
          ? URL.createObjectURL(file)
          : undefined,
      });
    }

    if (accepted.length > 0) {
      setAttachments((prev) => [...prev, ...accepted]);
    }
    setError(nextError);
  }

  function removeAttachment(id: string) {
    setSubmitted(false);
    setAttachments((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return prev.filter((item) => item.id !== id);
    });
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer.files);
  }

  const canSubmit = text.trim().length > 0 || attachments.length > 0;

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-7 max-[900px]:px-4">
      <div className="flex items-center gap-1.5 text-[11px] text-muted">
        <Link to="/" className="transition-colors hover:text-ink">
          工作台
        </Link>
        <ChevronRight className="h-3 w-3 text-passive" strokeWidth={1.8} />
        <span>新建运行</span>
      </div>

      <div className="mt-3">
        <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-ink">
          新建运行
        </h1>
        <p className="mt-1.5 text-[13px] text-muted">
          用自然语言描述产品目标，也可以附上设计规格、草图或界面截图。
        </p>
      </div>

      <div className="mt-6 grid grid-cols-[minmax(0,1fr)_320px] items-start gap-4 max-[1050px]:grid-cols-1">
        <Card className="overflow-hidden">
          <div className="flex items-center gap-2 border-b border-line px-5 py-3">
            <Sparkles className="h-4 w-4 text-accent" strokeWidth={1.8} />
            <span className="text-[12px] font-medium text-ink">
              描述你的产品与本期目标
            </span>
            <span className="ml-auto text-[10px] text-passive">
              自然语言 · 文件 · 图片
            </span>
          </div>

          <div className="p-5">
            <textarea
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setSubmitted(false);
              }}
              placeholder="例如：做一个面向大学生的二手交易平台，本期需要商品发布、搜索、站内沟通和举报处理；支持微信登录，先覆盖校内交易。"
              aria-label="产品设计规格"
              className="min-h-[230px] w-full resize-y border-0 bg-transparent p-0 text-[13px] leading-6 text-ink placeholder:text-passive focus:outline-none"
            />

            {attachments.length > 0 ? (
              <div className="mt-3 grid grid-cols-2 gap-2 max-[700px]:grid-cols-1">
                {attachments.map((item) => (
                  <AttachmentCard
                    key={item.id}
                    item={item}
                    onRemove={removeAttachment}
                  />
                ))}
              </div>
            ) : null}

            <div
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              className={cn(
                'mt-4 rounded-lg border border-dashed px-4 py-3 transition-colors duration-150',
                dragging
                  ? 'border-accent bg-accent-soft'
                  : 'border-line bg-subtle/30',
              )}
            >
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                <ImagePlus
                  className="h-4 w-4 text-passive"
                  strokeWidth={1.8}
                />
                <span>拖拽设计规格、草图或截图到这里</span>
                <span className="text-passive">
                  · 支持 .md / .txt / .pdf / .docx / 图片
                </span>
              </div>
            </div>

            {error ? (
              <p className="mt-2 text-[11px] text-danger">{error}</p>
            ) : null}

            {submitted ? (
              <div className="mt-3 flex items-start gap-2 rounded-lg border border-accent/20 bg-accent-soft px-3 py-2 text-[11px] leading-5 text-accent">
                <Info
                  className="mt-0.5 h-3.5 w-3.5 shrink-0"
                  strokeWidth={1.8}
                />
                <span>
                  输入已就绪。PM Agent 的任务分解与编排生成将在下一步接入。
                </span>
              </div>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".md,.txt,.pdf,.docx,image/*"
                className="hidden"
                onChange={(event) => {
                  addFiles(event.target.files);
                  event.target.value = '';
                }}
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip className="h-3.5 w-3.5" strokeWidth={1.8} />
                添加文件或图片
              </Button>
              <span className="text-[10px] text-passive max-[700px]:hidden">
                最多 6 个，单个不超过 10MB
              </span>
            </div>
            <span className="text-[10px] tabular-nums text-passive">
              {text.length} 字符
            </span>
          </div>
        </Card>

        <div className="space-y-3">
          <Card className="p-4">
            <div className="flex items-center gap-2 text-[12px] font-medium text-ink">
              <SlidersHorizontal
                className="h-4 w-4 text-muted"
                strokeWidth={1.8}
              />
              分解设置
            </div>

            <div className="mt-4 space-y-4">
              <Field label="分解粒度" hint="影响任务数量">
                <Segmented
                  options={granularityOptions}
                  value={granularity}
                  onChange={setGranularity}
                  ariaLabel="分解粒度"
                  fill
                />
              </Field>

              <Field label="并行上限" hint="同时执行的节点">
                <Segmented
                  options={parallelismOptions}
                  value={parallelism}
                  onChange={setParallelism}
                  ariaLabel="并行上限"
                  fill
                />
              </Field>

              <Field label="审查轮次" hint="超出后转人工">
                <Segmented
                  options={reviewOptions}
                  value={reviewRounds}
                  onChange={setReviewRounds}
                  ariaLabel="审查轮次"
                  fill
                />
              </Field>
            </div>

            <Button
              className="mt-4 w-full"
              disabled={!canSubmit}
              onClick={() => setSubmitted(true)}
            >
              开始分解
              <ArrowRight className="h-4 w-4" strokeWidth={1.8} />
            </Button>

            <p className="mt-2 text-[10px] leading-4 text-passive">
              PM Agent 会先复述目标与约束，再生成任务和依赖关系。
            </p>
          </Card>

          <Card className="p-4">
            <div className="flex items-center gap-2 text-[11px] font-medium text-muted">
              <FileText
                className="h-3.5 w-3.5 text-passive"
                strokeWidth={1.8}
              />
              输入建议
            </div>
            <ul className="mt-2 space-y-1.5 text-[11px] leading-5 text-muted">
              <li>写清楚目标用户、核心场景和本期不做什么。</li>
              <li>有设计稿或需求文档时直接作为附件补充。</li>
              <li>约束越具体，任务拆分和依赖越稳定。</li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
