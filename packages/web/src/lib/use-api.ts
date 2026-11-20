import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribeRunEvents } from './api';
import { useDataSource } from './data-source';

export type DataSource = 'live' | 'seed';

export interface ApiResource<T> {
  data: T;
  /** live 表示数据来自后端，seed 表示回落到了静态示例 */
  source: DataSource;
  loading: boolean;
  reload: () => void;
}

/**
 * 从后端取数据，失败时回落到静态示例。
 *
 * 回落是有意的：没起后端时界面仍然完整可看，只是顶部会标「演示数据」。
 * 这样评审者 clone 下来只有 Node 也能点开每个页面。
 */
export function useApiResource<T>(
  loader: () => Promise<T | null>,
  fallback: T,
): ApiResource<T> {
  const [data, setData] = useState<T>(fallback);
  const [source, setSource] = useState<DataSource>('seed');
  const [loading, setLoading] = useState(true);
  const setLive = useDataSource((state) => state.setLive);

  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    const result = await loaderRef.current();
    if (current !== generation.current) return;
    if (result === null) {
      setData(fallbackRef.current);
      setSource('seed');
      setLive(false);
    } else {
      setData(result);
      setSource('live');
      setLive(true);
    }
    setLoading(false);
  }, [setLive]);

  useEffect(() => {
    void reload();
    return () => { generation.current++; };
  }, [reload]);

  return { data, source, loading, reload };
}

/**
 * 订阅后端事件流，命中条件时触发回调（用于增量刷新）。
 *
 * 只在拿到过真实数据之后才订阅，避免后端没起时浏览器反复重连。
 */
export function useLiveRefresh(
  enabled: boolean,
  onEvent: () => void,
  options: { runId?: string; refreshIntervalMs?: number } = {},
): void {
  const callbackRef = useRef(onEvent);
  callbackRef.current = onEvent;
  const { runId, refreshIntervalMs = 250 } = options;

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let timer: number | undefined;
    const unsubscribe = subscribeRunEvents((payload) => {
      if (runId && payload.runId !== runId) {
        return;
      }
      if (timer !== undefined) {
        return;
      }
      timer = window.setTimeout(() => {
        timer = undefined;
        callbackRef.current();
      }, refreshIntervalMs);
    });

    return () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
      unsubscribe();
    };
  }, [enabled, runId, refreshIntervalMs]);
}
