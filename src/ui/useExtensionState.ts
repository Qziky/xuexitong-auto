import { useCallback, useEffect, useRef, useState } from 'react';
import { initialState, type AppState } from '../domain';
import { applyStateDelta } from '../state-sync';
import { command, preview } from './client';
export function useExtensionState() {
  const [state, setState] = useState(initialState);
  const [connectionError, setConnectionError] = useState('');
  const current = useRef(state);
  const syncing = useRef<Promise<void> | undefined>(undefined);
  const mounted = useRef(true);
  const adopt = useCallback((next: AppState) => {
    if (
      !mounted.current ||
      (next.revision ?? 0) < (current.current.revision ?? 0)
    )
      return;
    current.current = next;
    setState(next);
    setConnectionError('');
  }, []);
  const sync = useCallback((): Promise<void> => {
    if (syncing.current) return syncing.current;
    syncing.current = command<AppState>('state')
      .then(adopt)
      .catch((error) => {
        if (mounted.current)
          setConnectionError(
            error instanceof Error ? error.message : '后台连接暂不可用',
          );
      })
      .finally(() => {
        syncing.current = undefined;
      });
    return syncing.current;
  }, [adopt]);
  useEffect(() => {
    mounted.current = true;
    const receive = (message: any) => {
      if (message?.target !== 'ui') return;
      if (message.kind === 'state-snapshot') adopt(message.state);
      else if (message.kind === 'state-delta') {
        if (message.delta.version <= (current.current.revision ?? 0)) return;
        const next = applyStateDelta(current.current, message.delta);
        if (next) adopt(next);
        else void sync();
      } else if (message.kind === 'changed') void sync();
    };
    const onPreview = (event: Event) =>
      adopt((event as CustomEvent<AppState>).detail);
    const onFocus = () => void sync();
    if (!preview) chrome.runtime.onMessage.addListener(receive);
    window.addEventListener('preview-state', onPreview);
    window.addEventListener('focus', onFocus);
    void sync();
    return () => {
      mounted.current = false;
      if (!preview) chrome.runtime.onMessage.removeListener(receive);
      window.removeEventListener('preview-state', onPreview);
      window.removeEventListener('focus', onFocus);
    };
  }, [sync, adopt]);
  return { state, sync, connectionError };
}
