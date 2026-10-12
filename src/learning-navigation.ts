import { isChaoxingUrl } from './security';

/** Native course entry redirects rotate signatures, but never the course owner. */
export function matchesLearningNavigation(
  actual: string,
  requested: string,
): boolean {
  if (!isChaoxingUrl(actual) || !isChaoxingUrl(requested)) return false;
  if (actual === requested) return true;
  const target = new URL(actual),
    source = new URL(requested);
  const coursePath =
    /(?:\/visit\/stucoursemiddle|\/mycourse\/(?:stu|studentcourse))$/;
  if (!coursePath.test(source.pathname) || !coursePath.test(target.pathname))
    return false;
  return ['courseid', 'clazzid', 'cpi'].every(
    (key) =>
      !!source.searchParams.get(key) &&
      target.searchParams.get(key) === source.searchParams.get(key),
  );
}

/** Only a newly committed top-level target page can confirm a learning tab's identity. */
export function isFreshLearningDocumentFrame(
  frame: { top?: boolean; url: string; documentId?: string },
  requested: string,
  previousDocumentId?: string,
): boolean {
  return Boolean(
    frame.top &&
      matchesLearningNavigation(frame.url, requested) &&
      frame.documentId &&
      frame.documentId !== previousDocumentId,
  );
}
