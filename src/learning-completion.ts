import type { CompletionState } from './domain';
export function completionSignals(
  positive: boolean,
  negative: boolean,
): CompletionState {
  return positive && negative
    ? 'conflict'
    : positive
      ? 'confirmed'
      : negative
        ? 'incomplete'
        : 'unknown';
}
export function configurationCompletion(value: any): CompletionState {
  const explicit = value.isPassed ?? value.jobCompleted;
  if ([true, 1, 'true', '1'].includes(explicit)) return 'confirmed';
  if ([false, 0, 'false', '0'].includes(explicit)) return 'incomplete';
  if (/^(complete|completed|passed)$/.test(String(value.status ?? '')))
    return 'confirmed';
  if (/^(incomplete|pending|unpassed)$/.test(String(value.status ?? '')))
    return 'incomplete';
  return 'unknown';
}
export function resolveCompletion(
  config: CompletionState,
  marker: CompletionState,
  fresh = false,
): CompletionState {
  if (fresh && ['confirmed', 'incomplete'].includes(config)) return config;
  if (config === 'unknown') return marker;
  if (marker === 'unknown') return config;
  return config === marker ? config : 'conflict';
}
export function attachmentCompletion(
  root: Element | null | undefined,
): CompletionState {
  if (!root) return 'unknown';
  const icons = [...root.querySelectorAll('.ans-job-icon')].filter(
    (n) =>
      !root.matches('.ans-attach-ct') || n.closest('.ans-attach-ct') === root,
  );
  const labels = icons
    .map((n) => n.getAttribute('aria-label') ?? n.textContent ?? '')
    .join(' ');
  return completionSignals(
    root.classList.contains('ans-job-finished') ||
      icons.some((n) => n.classList.contains('ans-job-finished')) ||
      /任务点已完成/.test(labels),
    /未完成|待完成|未通过/.test(labels),
  );
}
export function catalogCompletion(row: Element): CompletionState {
  const selector = '.chapter_item,.chapter_unit,li,.posCatalog_select';
  const own = (n: Element) => n.closest(selector) === row || n === row;
  const icons = [
    ...row.querySelectorAll(
      '.icon_yiwanc,.icon_yiwancheng,.icon-complete,.icon_Completed,[data-completed="true"]',
    ),
  ].filter(own);
  const status =
    [
      ...row.querySelectorAll(
        '.status,.task-status,.ans-job-icon,.catalog_state',
      ),
    ]
      .filter(own)
      .map((n) => n.getAttribute('aria-label') ?? n.textContent ?? '')
      .join(' ') +
    ' ' +
    (row.getAttribute('aria-label') ?? '');
  const pending = [
    ...row.querySelectorAll(
      '.jobUnfinishCount,.orangeNew,[data-unfinished-count]',
    ),
  ]
    .filter(own)
    .some(
      (n) =>
        Number(
          n.getAttribute('data-unfinished-count') ?? n.textContent?.trim(),
        ) > 0,
    );
  return completionSignals(
    icons.length > 0 || /已完成|任务点全部完成/.test(status),
    pending || /未完成|待完成/.test(status),
  );
}
