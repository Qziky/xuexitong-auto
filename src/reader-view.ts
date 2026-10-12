import type { VideoBinding } from './video-player';
export type ReaderMode = 'pages' | 'pagination' | 'pdfjs' | 'scroll';
export interface ReaderView {
  mode: ReaderMode;
  root: HTMLElement;
  pages: HTMLElement[];
  current?: number;
  total?: number;
  next?: HTMLElement;
  previous?: HTMLElement;
  pageInput?: HTMLInputElement;
  scroll?: HTMLElement;
}
/** Use the page's real scrolling ancestor, including embedded DOCX viewports. */
function pageScroll(doc: Document, page: HTMLElement): HTMLElement | undefined {
  for (
    let node = page.parentElement;
    node && node !== doc.body && node !== doc.documentElement;
    node = node.parentElement
  ) {
    const overflow = doc.defaultView?.getComputedStyle(node).overflowY;
    if (
      /auto|scroll/.test(overflow ?? '') &&
      node.clientHeight > 0 &&
      node.scrollHeight > node.clientHeight
    )
      return node;
  }
  const root = doc.scrollingElement;
  return root instanceof HTMLElement && root.clientHeight > 0
    ? root
    : undefined;
}
const PAGE_SELECTOR =
  'li[id^="anchor"],[data-document-page],.pdf-page,.document-page';
function enabled(node: Element | null): HTMLElement | undefined {
  return node instanceof HTMLElement &&
    !(node instanceof HTMLButtonElement && node.disabled) &&
    node.getAttribute('aria-disabled') !== 'true'
    ? node
    : undefined;
}
/** Restrict controls and content to this task's own attachment, never a sibling. */
function roots(doc: Document, binding?: VideoBinding): HTMLElement[] {
  const containers = [
    ...doc.querySelectorAll<HTMLElement>('.ans-attach-ct'),
  ].filter((n) => !n.parentElement?.closest('.ans-attach-ct'));
  if (!containers.length) return [doc.body];
  if (!binding) return containers;
  const matched = containers.filter((root) =>
    [...root.querySelectorAll('[data], [data-jobid], [data-objectid]')].some(
      (n) => {
        if (n.closest('.ans-attach-ct') !== root) return false;
        let data: any = {};
        try {
          data = JSON.parse(n.getAttribute('data') ?? '{}');
        } catch {}
        return binding.jobId
          ? (data.jobid ?? n.getAttribute('data-jobid')) === binding.jobId
          : !!binding.objectId &&
              (data.objectid ??
                data.objectId ??
                n.getAttribute('data-objectid')) === binding.objectId;
      },
    ),
  );
  if (matched.length) return matched;
  if (containers.length !== 1) return [];
  const declared = [
    ...containers[0]!.querySelectorAll('[data], [data-jobid], [data-objectid]'),
  ].some((n) => {
    if (n.closest('.ans-attach-ct') !== containers[0]) return false;
    try {
      const data = JSON.parse(n.getAttribute('data') ?? '{}');
      return !!(
        data.jobid ||
        data.objectid ||
        data.objectId ||
        n.getAttribute('data-jobid') ||
        n.getAttribute('data-objectid')
      );
    } catch {
      return !!(
        n.getAttribute('data-jobid') || n.getAttribute('data-objectid')
      );
    }
  });
  return declared ? [] : containers;
}
export function readerView(
  doc: Document,
  binding?: VideoBinding,
): ReaderView | undefined {
  const candidates: ReaderView[] = [];
  for (const root of roots(doc, binding)) {
    const own = (n: Element) =>
      !n.closest('.ans-attach-ct') || n.closest('.ans-attach-ct') === root;
    const number = root.querySelector<HTMLInputElement>('#pageNumber');
    const viewport = root.querySelector<HTMLElement>(
      '#viewerContainer,.pdfViewer',
    );
    if (number && viewport && own(number) && own(viewport)) {
      const current = Number(number.value);
      const total = Number(
        root.querySelector('#numPages')?.textContent?.match(/\d+/)?.[0] ??
          number.max,
      );
      candidates.push({
        mode: 'pdfjs',
        root,
        pages: [...viewport.querySelectorAll<HTMLElement>('.page')],
        current: current > 0 ? current : undefined,
        total: total > 0 ? total : undefined,
        next: enabled(root.querySelector('#next,#nextPage')),
        previous: enabled(root.querySelector('#previous,#previousPage')),
        pageInput: number,
      });
      continue;
    }
    const pages = [...root.querySelectorAll<HTMLElement>(PAGE_SELECTOR)].filter(
      own,
    );
    if (!pages.length && /\/knowledge\/cards$/.test(new URL(doc.URL).pathname))
      pages.push(
        ...[
          ...root.querySelectorAll<HTMLImageElement>(
            '#pageDiv img,img[data-jobid]',
          ),
        ].filter(own),
      );
    const pager = root.querySelector<HTMLElement>(
      '[data-reader-pages],.reader-pagination,.page-control',
    );
    if (pager && pages.length) {
      const match = pager.textContent?.match(
        /(?:第\s*)?(\d+)\s*(?:页\s*)?(?:\/|共)\s*(\d+)\s*页?/,
      );
      const current = Number(
        pager.getAttribute('data-reader-page') ?? match?.[1],
      );
      const total = Number(
        pager.getAttribute('data-reader-pages') ?? match?.[2],
      );
      const controls = [
        ...pager.querySelectorAll<HTMLElement>('button,a,[role="button"]'),
      ].filter((n) => enabled(n));
      if (
        Number.isInteger(current) &&
        Number.isInteger(total) &&
        current >= 1 &&
        total >= current &&
        total > pages.length
      ) {
        const label = (n: HTMLElement) =>
          (n.getAttribute('aria-label') ?? n.textContent ?? '').trim();
        candidates.push({
          mode: 'pagination',
          root,
          pages,
          current,
          total,
          next: controls.find((n) => /^(下一页|Next page)$/i.test(label(n))),
          previous: controls.find((n) =>
            /^(上一页|Previous page)$/i.test(label(n)),
          ),
        });
        continue;
      }
    }
    if (pages.length) {
      candidates.push({
        mode: 'pages',
        root,
        pages,
        total: pages.length,
        scroll: pageScroll(doc, pages[0]!),
      });
      continue;
    }
    const explicit = [
      ...root.querySelectorAll<HTMLElement>(
        '[data-reader-scroll],#viewerContainer,.pdfViewer,#docContainer',
      ),
    ].filter(own);
    const module = /\/modules\/(?:pdf|ppt|document|doc)\/|\/reader\//.test(
      doc.URL,
    );
    if (
      module &&
      !explicit.length &&
      root.querySelector('[role="document"],article')
    ) {
      const scrolling = doc.scrollingElement;
      if (scrolling instanceof HTMLElement) explicit.push(scrolling);
    }
    const scroll = explicit.filter(
      (n) =>
        n.clientHeight > 0 &&
        n.scrollHeight >= n.clientHeight &&
        !n.querySelector('iframe[src]') &&
        (n.hasAttribute('data-reader-scroll') ||
          !!n.querySelector('canvas,.page,[role="document"],article') ||
          [...n.querySelectorAll('img')].some(
            (img) => img.naturalWidth >= 100 && img.getClientRects().length > 0,
          )),
    );
    // Nested viewport and viewer describe one reader; use the outer scrolling viewport.
    const outer = scroll.filter(
      (n) => !scroll.some((other) => other !== n && other.contains(n)),
    );
    if (outer.length === 1)
      candidates.push({ mode: 'scroll', root, pages: [], scroll: outer[0] });
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}
export function readerContentReady(
  page: HTMLElement,
  visibleOnly = false,
): boolean {
  if (
    page.getAttribute('aria-busy') === 'true' ||
    page.classList.contains('loading')
  )
    return false;
  const images =
    page instanceof HTMLImageElement
      ? [page]
      : [...page.querySelectorAll('img')];
  const region = page.getBoundingClientRect();
  return images.every((img) => {
    if (visibleOnly && region.height > 0) {
      const bounds = img.getBoundingClientRect();
      if (bounds.bottom < region.top || bounds.top > region.bottom) return true;
    }
    return img.complete && img.naturalWidth > 0;
  });
}
