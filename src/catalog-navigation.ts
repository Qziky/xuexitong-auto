import { hashText } from './security';
import { textOf } from './page-parser';
import { isCourseListUrl } from './scan-cache';
export interface CatalogAction {
  id: string;
  kind: 'folder' | 'next';
  label: string;
}
export interface CatalogMenu {
  fingerprint: string;
  actions: CatalogAction[];
}
function nodes(doc: Document): { node: HTMLElement; action: CatalogAction }[] {
  const result: { node: HTMLElement; action: CatalogAction }[] = [];
  const folders = doc.querySelectorAll<HTMLElement>(
    '.course-folder, .courseFolder, .folderItem, [data-folder-id], [onclick*="openFolder"], [onclick*="enterFolder"], [onclick*="showFolder"]',
  );
  const next = doc.querySelectorAll<HTMLElement>(
    '.nextPage, .pageNext, .pagination a, .paging a, [title="下一页"], [aria-label="下一页"], [onclick*="nextPage"]',
  );
  for (const [kind, collection] of [
    ['folder', folders],
    ['next', next],
  ] as const) {
    for (const node of collection) {
      const label =
        node.getAttribute('title') ||
        node.getAttribute('aria-label') ||
        textOf(node);
      if (!label || /退课|删除|移动到|设置|上一页|返回/.test(label)) continue;
      if (kind === 'next' && !/下一页|下页|next|^[›»>]$/i.test(label)) continue;
      const identity =
        node.getAttribute('onclick') ||
        node.getAttribute('href') ||
        node.getAttribute('data-folder-id') ||
        node.id;
      if (/delete|remove|quit|withdraw|move|rename/i.test(identity)) continue;
      if (!identity || result.some((entry) => entry.node === node)) continue;
      const href = node.getAttribute('href');
      if (href && !/^(?:#|javascript:)/i.test(href)) {
        try {
          if (
            !isCourseListUrl(
              new URL(href, 'https://mooc2-ans.chaoxing.com/visit/interaction')
                .href,
            )
          )
            continue;
        } catch {
          continue;
        }
      }
      result.push({
        node,
        action: {
          id: hashText(`${kind}:${identity}:${label}`),
          kind,
          label: label.slice(0, 100),
        },
      });
    }
  }
  return result;
}
export function catalogMenu(
  doc: Document,
  url: string,
  isVisible?: (el: Element) => boolean,
): CatalogMenu {
  if (
    !/\/visit\/(?:interaction|courselist[^/]*|courses[^/]*)(?:[/?]|$)/.test(url)
  )
    throw new Error('此页不是课程列表');
  const actions = nodes(doc)
    .filter((item) => !isVisible || isVisible(item.node))
    .map((item) => item.action);
  const courses = [...doc.querySelectorAll('a[href*="stucoursemiddle"]')].map(
    (n) => n.getAttribute('href'),
  );
  return {
    actions,
    fingerprint: hashText(JSON.stringify({ courses, actions })),
  };
}
export function openCatalogAction(
  doc: Document,
  url: string,
  id: string,
  fingerprint: string,
  isVisible: (el: Element) => boolean,
): void {
  const menu = catalogMenu(doc, url, isVisible);
  if (menu.fingerprint !== fingerprint) throw new Error('课程列表已变化');
  const item = nodes(doc).find(
    (item) => item.action.id === id && isVisible(item.node),
  );
  if (!item) throw new Error('目录导航入口已变化');
  item.node.click();
}
