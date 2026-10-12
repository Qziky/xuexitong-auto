import { describe, expect, it, vi } from 'vitest';
import { catalogMenu, openCatalogAction } from '../src/catalog-navigation';
import { inertDocument } from '../src/scan-parser';
const url = 'https://mooc2-ans.chaoxing.com/visit/interaction';
describe('动态课程分页和文件夹', () => {
  it('仅课程列表中已观察到的文件夹和下一页入口可被遍历', () => {
    const doc = inertDocument(
      '<div class="courseFolder" onclick="openFolder(1)">示例文件夹</div><a title="下一页" onclick="nextPage(2)">下一页</a><a class="courseFolder" onclick="deleteFolder(3)">删除文件夹</a>',
    );
    const menu = catalogMenu(doc, url);
    expect(menu.actions.map((a) => a.kind)).toEqual(['folder', 'next']);
    const node = doc.querySelector('.courseFolder') as HTMLElement;
    const click = vi.spyOn(node, 'click');
    openCatalogAction(
      doc,
      url,
      menu.actions[0]!.id,
      menu.fingerprint,
      () => true,
    );
    expect(click).toHaveBeenCalledOnce();
  });
  it('列表变化和答题页面都拒绝导航命令', () => {
    const doc = inertDocument(
      '<a title="下一页" onclick="nextPage(2)">下一页</a>',
    );
    const menu = catalogMenu(doc, url);
    doc.body.insertAdjacentHTML(
      'beforeend',
      '<a href="https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=100">新课程</a>',
    );
    expect(() =>
      openCatalogAction(
        doc,
        url,
        menu.actions[0]!.id,
        menu.fingerprint,
        () => true,
      ),
    ).toThrow('变化');
    expect(() =>
      catalogMenu(doc, 'https://mooc1.chaoxing.com/mooc-ans/api/work'),
    ).toThrow('不是课程列表');
  });
  it('惰性 HTML 保存播放器 URL 数据但不加载 iframe 资源', () => {
    const doc = inertDocument(
      '<iframe src="https://mooc1.chaoxing.com/ananas/modules/video/index.html"></iframe>',
    );
    expect(doc.querySelector('iframe')!.hasAttribute('src')).toBe(false);
    expect(doc.querySelector('iframe')!.getAttribute('data-cx-src')).toContain(
      '/modules/video/',
    );
  });
});
