import {
  ArrowRight,
  Bot,
  ChevronRight,
  FileText,
  FolderOpen,
  ImagePlus,
  Info,
  Paperclip,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Field } from '../components/ui/Field';
import { Segmented } from '../components/ui/Segmented';
import { createRun, fetchAgents, fetchRuntime, pickDirectory } from '../lib/api';
import { cn } from '../lib/cn';
import { formatFileSize } from '../lib/format';
import { useApiResource } from '../lib/use-api';
import { usePageTitle } from '../lib/use-page-title';
import type { AgentProfile } from '../types/agent';

type Granularity = 'coarse' | 'medium' | 'fine';
/**
 * 并行度：这次运行允许同时跑几个节点。
 *
 * 上限 32 与服务端 schema 对齐。这不再是「给 Planner 的建议」——它真的会被
 * 落进运行事实，并决定调度器一次派发几个节点。
 */
type Parallelism = '2' | '4' | '8' | '16' | '32';
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
  { value: '8', label: '8' },
  { value: '16', label: '16' },
  { value: '32', label: '32' },
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

/**
 * 判一个路径是不是绝对路径。
 *
 * 三种写法都要认：Windows 盘符（`C:\` 或 `C:/`）、UNC（`\\server\share`）、
 * POSIX 的 `/`。这里只是提交前的基本校验——真正的判据在后端（目录存在吗、
 * 是 git 仓库吗），前端拦的是明显填错的那种：相对路径、空格、空串。
 * 之所以要拦，是因为「目录不对」在后端是 400，等提交完再报太晚了。
 */
function isAbsolutePath(value: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/')
  );
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

function AgentSelect({
  label,
  hint,
  value,
  onChange,
  agents,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  agents: AgentProfile[];
}) {
  return (
    <Field label={label} hint={hint}>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        className="h-8 w-full rounded-lg border border-line bg-surface px-2.5 text-[11px] text-ink transition-colors focus:border-line-strong focus:outline-none focus:ring-2 focus:ring-accent/20"
      >
        {agents.length === 0 ? <option value="">没有可用的 Agent</option> : null}
        {agents.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.label}
            {agent.availability === 'ready' ? '' : '（已安装）'}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function NewRunPage() {
  usePageTitle('新建运行');
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const navigate = useNavigate();
  const [granularity, setGranularity] = useState<Granularity>('medium');
  const [parallelism, setParallelism] = useState<Parallelism>('4');
  const [reviewRounds, setReviewRounds] = useState<ReviewRounds>('2');

  // 三个角色的 Agent 在这里就定下来，而不是等 Planner 自己挑
  const [chosenPlanner, setPlannerAgentId] = useState('');
  const [chosenImplementer, setImplementAgentId] = useState('');
  const [chosenReviewer, setReviewAgentId] = useState('');
  /**
   * 目标目录：Agent 干活的地方，成果会落在这里。
   *
   * 初始为空，等 /api/runtime 给了默认值再填。不在前端猜默认值——它取决于
   * 服务进程的启动目录与 AGENT_TARGET_DIR，前端一概不知道。
   */
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  /** 原生目录选择框正在弹（它会阻塞到用户点确定或取消） */
  const [picking, setPicking] = useState(false);

  const { data: agents, loading: loadingAgents } = useApiResource(fetchAgents, []);
  const { data: runtime } = useApiResource(fetchRuntime, null);

  useEffect(() => {
    // 服务级配了默认目录才预填（运维用 AGENT_TARGET_DIR 指定）。
    // 没配就是 null——此时输入框保持空，让「选目录」这件事无法被跳过：
    // 猜一个目录会让成果落在用户没打算动的地方。
    if (runtime?.defaultWorkspaceRoot) {
      setWorkspaceRoot((prev) => prev || runtime.defaultWorkspaceRoot || '');
    }
  }, [runtime]);

  const usableAgents = useMemo(() => {
    const rank = (agent: AgentProfile): number =>
      agent.availability === 'ready' ? 2 : 1;
    return agents
      .filter((agent) => agent.enabled && agent.availability !== 'missing')
      .slice()
      .sort((left, right) => rank(right) - rank(left));
  }, [agents]);

  const primary = usableAgents.find((agent) => agent.capabilities.structured)?.id
    ?? usableAgents[0]?.id;
  const selectedAgent = (chosen: string, fallback?: string) =>
    usableAgents.some((agent) => agent.id === chosen) ? chosen : fallback ?? '';
  const plannerAgentId = selectedAgent(chosenPlanner, primary);
  const implementAgentId = selectedAgent(chosenImplementer, primary);
  const reviewerDefault = usableAgents.find((agent) => agent.id !== implementAgentId)?.id
    ?? implementAgentId;
  const reviewAgentId = selectedAgent(chosenReviewer, reviewerDefault);

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

    setSubmitError(null);

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
    setSubmitError(null);
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

  const canSubmit = Boolean(text.trim() && runtime && plannerAgentId && implementAgentId && reviewAgentId);

  /**
   * 目标目录的就地校验结果。
   *
   * 空串单独说一句：这是必填项，不是可选项。留空提交等于让后端猜一个目录跑，
   * 而用户以为自己指定了地方——成果落在错的地方，他很久之后才会发现。
   */
  const trimmedWorkspaceRoot = workspaceRoot.trim();
  const workspaceRootError =
    trimmedWorkspaceRoot.length === 0
      ? '请选择目标目录：这是 Agent 干活的地方，成果会落在这里'
      : !isAbsolutePath(trimmedWorkspaceRoot)
        ? '需要绝对路径，例如 D:\\projects\\calculator'
        : null;

  async function handleSubmit() {
    if (!canSubmit || submitting || workspaceRootError) {
      return;
    }
    setSubmitting(true);
    setSubmitError(null);

    // 分解粒度和审查轮次仍然只是给 Planner 的参考（后端没有对应参数），
    // 并行度不同：它会被落成运行事实、真的决定调度器一次派发几个节点，
    // 所以下面单独传 `concurrency`，不再只靠这段文字。
    const granularityLabel =
      granularityOptions.find((option) => option.value === granularity)?.label ??
      granularity;
    const settings = [
      `分解粒度：${granularityLabel}`,
      `并行度：${parallelism}`,
      `审查轮次：${reviewRounds} 轮`,
    ].join('；');

    const goal = `${text.trim()}\n\n补充要求：${settings}`;
    const title = text.trim().split('\n')[0]?.slice(0, 24) || '未命名运行';

    const outcome = await createRun({
      title,
      goal,
      // 目录必须随创建请求带走：运行一旦建好，目标仓库就是它的事实了
      workspaceRoot: trimmedWorkspaceRoot,
      // 并行度是这次运行的属性，不是服务的属性
      concurrency: Number(parallelism),
      plannerAgentId: plannerAgentId || undefined,
      implementAgentId: implementAgentId || undefined,
      reviewAgentId: reviewAgentId || undefined,
    });
    setSubmitting(false);

    if (!outcome.ok) {
      const { failure } = outcome;
      // plan_rejected / planner_failed 只可能来自旧后端：拆解挪到后台之后，
      // 创建请求本身只会因为 body 不合法（400）失败，那两种情况的下场是
      // 详情页里的 failed 状态，不是这里的一句话。
      //
      // workspace_not_found / workspace_not_git 是这次新增的两个 400：后端把
      // 具体路径与原因写在 message 里，原样显示即可，不要在界面上改成一句
      // 笼统的「创建失败」——用户需要知道自己填的哪个路径不能用。
      const detail =
        failure.error === 'plan_rejected'
          ? `规划没通过校验：${failure.message ?? '未知原因'}`
          : failure.error === 'planner_failed'
            ? `规划 Agent 执行失败：${failure.message ?? '未知原因'}`
            : (failure.message ?? failure.error);
      setSubmitError(detail);
      return;
    }

    // 拿到 id 就跳转，不等拆解完成：后端已经把「这次创建」落成事实，
    // 任务图由它在后台生成，详情页通过事件流收到后自己长出来。留在这里等
    // 的唯一结果是用户对着按钮转圈几十秒——之前那版正是这么做的。
    navigate(`/runs/${outcome.run.id}`);
  }

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
                setSubmitError(null);
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

            {submitError ? (
              <div className="mt-3 flex items-start gap-2 rounded-lg border border-danger/20 bg-danger-soft px-3 py-2 text-[11px] leading-5 text-danger">
                <Info
                  className="mt-0.5 h-3.5 w-3.5 shrink-0"
                  strokeWidth={1.8}
                />
                <span>{submitError}</span>
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
              <FolderOpen className="h-4 w-4 text-muted" strokeWidth={1.8} />
              目标目录
            </div>
            <p className="mt-1 text-[10px] leading-4 text-passive">
              这是 Agent 干活的地方，成果会落在这里——不是编排器自己的仓库。
              目录还不存在会自动创建并 git init；已存在但不是 git 仓库的也会就地
              初始化（删掉 .git 即可回到原样）。
            </p>

            <div className="mt-3">
              <Field label="执行目录" hint="绝对路径">
                <div className="flex gap-1.5">
                  <input
                    value={workspaceRoot}
                    onChange={(event) => {
                      setWorkspaceRoot(event.target.value);
                      setSubmitError(null);
                    }}
                    placeholder="D:\projects\calculator"
                    aria-label="目标目录"
                    spellCheck={false}
                    autoComplete="off"
                    className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2.5 font-mono text-[11px] text-ink transition-colors placeholder:text-passive focus:border-line-strong focus:outline-none focus:ring-2 focus:ring-accent/20"
                  />
                  {/*
                    原生选择框只能由后端弹：浏览器的 showDirectoryPicker()
                    拿不到绝对路径，而编排器要的正是能交给 git 的路径。
                  */}
                  {runtime?.canPickDirectory ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={picking}
                      onClick={() => {
                        setPicking(true);
                        setSubmitError(null);
                        void pickDirectory()
                          .then((result) => {
                            // picked 由后端给，成功时一定有绝对路径
                            if (result?.picked && result.path) {
                              setWorkspaceRoot(result.path);
                              return;
                            }
                            // 取消是用户的正常操作，不要弹提示；
                            // 其它失败（平台不支持、弹窗起不来）要说清原因，
                            // 否则用户只知道「点了没反应」
                            if (result?.reason && result.reason !== 'cancelled') {
                              setSubmitError(
                                result.message ?? '目录选择框没有打开，请直接粘贴路径',
                              );
                            }
                          })
                          .finally(() => setPicking(false));
                      }}
                    >
                      {picking ? '选择中…' : '浏览…'}
                    </Button>
                  ) : null}
                </div>
              </Field>
              {workspaceRootError ? (
                <p className="mt-1.5 text-[10px] leading-4 text-danger">
                  {workspaceRootError}
                </p>
              ) : (
                <p className="mt-1.5 text-[10px] leading-4 text-passive">
                  worktree 落在编排器的 data/worktrees 下，不会写进你的仓库。
                </p>
              )}
            </div>
          </Card>

          <Card className="p-4">
            <div className="flex items-center gap-2 text-[12px] font-medium text-ink">
              <Bot className="h-4 w-4 text-muted" strokeWidth={1.8} />
              执行 Agent
            </div>
            <p className="mt-1 text-[10px] leading-4 text-passive">
              {!runtime || loadingAgents
                ? '等待本地后端和 Agent 列表。'
                : runtime.runner === 'mock'
                  ? '当前是回放模式，不会真的调用 Agent。'
                  : usableAgents.length === 0
                    ? '后端未检测到受支持的本地 CLI。请安装并登录 Agent 后重新打开此页。'
                    : '真实执行模式。所选 Agent 将在各自的 Git worktree 中拆图、写代码和审查。'}
            </p>

            <div className="mt-3 space-y-3">
              <AgentSelect
                label="编排器"
                hint="拆解任务图"
                value={plannerAgentId}
                onChange={setPlannerAgentId}
                agents={usableAgents}
              />
              <AgentSelect
                label="实现"
                hint="写代码"
                value={implementAgentId}
                onChange={setImplementAgentId}
                agents={usableAgents}
              />
              <AgentSelect
                label="审查"
                hint="独立核对"
                value={reviewAgentId}
                onChange={setReviewAgentId}
                agents={usableAgents}
              />
            </div>
          </Card>

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
              disabled={!canSubmit || submitting || Boolean(workspaceRootError)}
              onClick={() => void handleSubmit()}
            >
              {submitting ? '正在创建…' : '开始拆解'}
              <ArrowRight className="h-4 w-4" strokeWidth={1.8} />
            </Button>

            <p className="mt-2 text-[10px] leading-4 text-passive">
              点下就跳到运行详情：编排器在后台挑一个已安装的 CLI Agent 拆任务图，
              拆完自动进入执行。拆图本身要几十秒，进度在详情页里看。
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
