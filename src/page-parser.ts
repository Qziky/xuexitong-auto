import {
  PAGE_TEXT_PROCESSING_VERSION,
  type BlankRecord,
  type PageSnapshot,
  type QuestionRecord,
  type QuestionType,
  type QuestionImage,
  type TaskStatus,
} from './domain';
import { hashText, safePageUrl } from './security';
import { taskIdentifiers } from './task-context';
import { assertPlatformPage } from './platform-access';
import { extractImageContent } from './image-content';
import { summaryText } from './dom-summary';
import {
  CHOICE_LABEL_SELECTOR,
  CHOICE_KEY_SELECTOR,
  editableChoiceElements,
} from './choice-elements';
import {
  readPublishedAnswer,
  readOwnAnswer,
  displayedBlanks,
} from './published-answer';

/** Normalize text from elements or inert template fragments. */
export function textOf(node: Node | null | undefined): string {
  return (node?.textContent ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\t\r\n ]+/g, ' ')
    .trim();
}
export function extractAccount(doc: Document, cookie = ''): string | undefined {
  const match = cookie.match(/(?:^|;\s*)(?:_uid|UID|uid)=(\d+)/);
  const input = doc.querySelector<HTMLInputElement>(
    'input[name="uid"], input[name="userId"], input#userId, input[name="puid"]',
  );
  const value =
    match?.[1] ||
    input?.value ||
    [...doc.querySelectorAll('a[href]')]
      .map((a) => a.getAttribute('href')?.match(/[?&](?:uid|puid)=(\d+)/)?.[1])
      .find(Boolean);
  return value && /^\d+$/.test(value) ? `cx:${value}` : undefined;
}
export function parseDate(value: string): number | undefined {
  const m = value.match(
    /(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:\s*(\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
  );
  if (!m) return undefined;
  if (
    Number(m[2]) < 1 ||
    Number(m[2]) > 12 ||
    Number(m[3]) < 1 ||
    Number(m[3]) >
      new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate() ||
    Number(m[4] ?? 23) > 23 ||
    Number(m[5] ?? 59) > 59 ||
    Number(m[6] ?? 59) > 59
  )
    return undefined;
  const result =
    Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4] ?? 23),
      Number(m[5] ?? 59),
      Number(m[6] ?? (m[4] ? 0 : 59)),
    ) -
    8 * 3600000;
  return Number.isFinite(result) ? result : undefined;
}
export function taskKeyFromUrl(url: string, doc?: Document): string {
  const { course, clazz, work } = taskIdentifiers(url, doc);
  return work ? `${course}:${clazz}:work:${work}` : '';
}
function questionType(el: Element): QuestionType {
  const type =
    el.getAttribute('typename') ??
    textOf(el.querySelector('.newZy_TItle, .colorShallow'));
  if (/多选/.test(type)) return 'multiple';
  if (/单选/.test(type)) return 'single';
  if (/判断/.test(type)) return 'boolean';
  if (/填空/.test(type)) return 'blank';
  const code =
    el.querySelector('[qtype]')?.getAttribute('qtype') ??
    (el.classList.contains('TiMu') ? el.getAttribute('data') : undefined);
  return (
    ({ '0': 'single', '1': 'multiple', '2': 'blank', '3': 'boolean' } as const)[
      code ?? ''
    ] ?? 'unsupported'
  );
}
function inputValue(doc: Document, id: string): string {
  return (doc.getElementById(id) as HTMLInputElement | null)?.value ?? '';
}
function isLocalQuoteFallback(
  marked: Element[],
  doc: Document,
  view: Window,
): boolean {
  if (doc.readyState !== 'complete' || doc.fonts?.status !== 'loaded')
    return false;
  const faces = new Map<string, Array<{ src: string; range: string }>>();
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      // CSSFontFaceRule is CSSRule type 5 in the browser DOM.
      if (rule.type !== 5) continue;
      const face = rule as CSSFontFaceRule;
      const family = face.style
        .getPropertyValue('font-family')
        .replace(/["']/g, '')
        .trim()
        .toLowerCase();
      if (!/^cxchinesequote\d*$/.test(family)) continue;
      const entries = faces.get(family) ?? [];
      entries.push({
        src: face.style.getPropertyValue('src').trim(),
        range: face.style.getPropertyValue('unicode-range').trim(),
      });
      faces.set(family, entries);
    }
  }
  const privateGlyph =
    /[\uE000-\uF8FF\uFFFD\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u;
  return marked.every((node) => {
    const text = node.textContent ?? '';
    if (
      !node.isConnected ||
      privateGlyph.test(text) ||
      !/[A-Za-z\u00C0-\u024F\u4e00-\u9fff]/.test(text)
    )
      return false;
    const family = view
      .getComputedStyle(node)
      .fontFamily.split(',')[0]
      ?.replace(/["']/g, '')
      .trim()
      .toLowerCase();
    if (!family || !/^cxchinesequote\d*$/.test(family)) return false;
    const rules = faces.get(family);
    return Boolean(
      rules?.length &&
        rules.every(({ src, range }) => {
          const ranges = range
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean);
          return (
            /^local\(/i.test(src) &&
            ranges.length > 0 &&
            ranges.every((part) => /^u\+201[89cd]$/i.test(part))
          );
        }),
    );
  });
}
function isEncoded(el: Element | null, url: string): boolean {
  if (!el) return false;
  const marked = [
    ...(el.matches('.font-cxsecret') ? [el] : []),
    ...el.querySelectorAll('.font-cxsecret'),
  ];
  if (!marked.length) return false;
  const doc = el.ownerDocument,
    view = doc.defaultView;
  // Chaoxing's local CXChineseQuote face only covers curly punctuation. On
  // some editable quizzes the generic font-cxsecret class remains on readable
  // text even though no glyph-mapping font is present.
  if (view && isLocalQuoteFallback(marked, doc, view)) return false;
  // Reviewed pages can retain the old class after removing their secret font.
  // Absence of inline CSS alone is not proof (external fonts / pending loads).
  const reviewed =
    /\/work\/(?:view|review|selectWorkQuestionYiPiYue|selectWorkQuestionWeiPiYue)$/.test(
      new URL(url).pathname,
    );
  if (
    reviewed &&
    view &&
    doc.URL === url &&
    doc.readyState === 'complete' &&
    doc.fonts?.status === 'loaded'
  ) {
    const normalize = (family: string) =>
      family.replace(/["']/g, '').trim().toLowerCase();
    const system = new Set([
      'microsoft yahei',
      'microsoft yahei ui',
      'arial',
      'helvetica',
      'sans-serif',
      'serif',
      'times new roman',
      'simsun',
      '宋体',
      'segoe ui',
    ]);
    const webFonts = new Set([...doc.fonts].map((f) => normalize(f.family)));
    const plain = marked.every((node) => {
      if (
        !node.isConnected ||
        /[\uE000-\uF8FF\uFFFD\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u.test(
          node.textContent ?? '',
        )
      )
        return false;
      const families = view
        .getComputedStyle(node)
        .fontFamily.split(',')
        .map(normalize)
        .filter(Boolean);
      return (
        families.length > 0 &&
        families.every((f) => system.has(f) && !webFonts.has(f))
      );
    });
    if (plain) return false;
  }
  return true;
}

/** Read saved HTML before UEditor has created its iframe, without activating markup. */
function serverEditorText(node: HTMLElement): string {
  if (node.tagName === 'SCRIPT' || node.tagName === 'TEXTAREA') {
    const template = node.ownerDocument.createElement('template');
    template.innerHTML =
      (node as HTMLTextAreaElement).value ?? node.textContent ?? '';
    return textOf(template.content);
  }
  return textOf(
    node.querySelector('.edui-editor-iframeholder iframe')?.parentElement,
  );
}

/** Extract a question, including initialized and server-rendered editor values. */
export function readQuestion(
  el: Element,
  index: number,
  doc: Document,
  url = doc.URL,
): QuestionRecord {
  const id =
    el.getAttribute('id')?.replace(/^question/, '') ||
    el.querySelector('[qid]')?.getAttribute('qid') ||
    el
      .querySelector('[name^="answertype"]')
      ?.getAttribute('name')
      ?.replace('answertype', '') ||
    el.getAttribute('data') ||
    '';
  const type = questionType(el);
  const readonly =
    /\/work\/(?:preview|view|review)$/.test(new URL(url).pathname) ||
    (!!el.querySelector('.newAnswerBx,.myAnswerBx,.correctAnswerBx') &&
      !el.querySelector(
        `[onclick*="addChoice"],[onclick*="addMultipleChoice"],${CHOICE_KEY_SELECTOR},textarea,input[type="text"],[id^="answerEditor"]`,
      ));
  const stemNode =
    el.querySelector('.Zy_TItle .fontLabel') ??
    el.querySelector('.mark_name, .Zy_TItle');
  const copy = stemNode?.cloneNode(true) as Element | undefined;
  copy
    ?.querySelectorAll('.newZy_TItle, .colorShallow')
    .forEach((n) => n.remove());
  const images: QuestionImage[] = [];
  extractImageContent(copy, images, id, url, 'stem');
  const stem = textOf(copy)
    .replace(/^\s*\d+\s*[.、．]\s*/, '')
    .replace(/^【[^】]+】/, '')
    .trim();
  let optionEls = editableChoiceElements(el);
  if (readonly && !optionEls.length)
    optionEls = [
      ...el.querySelectorAll<HTMLElement>(
        '.Zy_ulTop li,.Zy_ulBottom li,.answerBg li,.mark_letter > li',
      ),
    ].filter(
      (n) =>
        n.querySelector(`${CHOICE_LABEL_SELECTOR},.answer_p,i,a`) ||
        (n.parentElement?.matches('.mark_letter') &&
          /^[A-Z][.、．]\s*/.test(textOf(n))),
    );
  const options = optionEls.map((option, i) => {
    const label = option.querySelector(`${CHOICE_LABEL_SELECTOR},i`) ?? option;
    const content = option.querySelector('.answer_p, a.after,a') ?? option;
    const contentCopy = content.cloneNode(true) as Element;
    const optionId = `q${id}:o${i + 1}`;
    extractImageContent(contentCopy, images, id, url, 'option', optionId);
    const plainLabel =
      readonly && option.parentElement?.matches('.mark_letter')
        ? textOf(contentCopy).match(/^([A-Z])[.、．]\s*/)
        : undefined;
    return {
      id: optionId,
      key: label.getAttribute('data') ?? (readonly ? 'readonly:' + i : ''),
      label:
        plainLabel?.[1] ?? textOf(label).replace(/^([A-Z])[.、．]\s*$/, '$1'),
      text: plainLabel
        ? textOf(contentCopy).slice(plainLabel[0].length)
        : textOf(contentCopy),
      obfuscated: isEncoded(option, url),
    };
  });
  if (readonly && type === 'boolean' && !options.length)
    options.push(
      {
        id: 'q' + id + ':o1',
        key: 'readonly:true',
        label: 'A',
        text: '对',
        obfuscated: false,
      },
      {
        id: 'q' + id + ':o2',
        key: 'readonly:false',
        label: 'B',
        text: '错',
        obfuscated: false,
      },
    );
  const raw = inputValue(doc, `answer${id}`);
  let existing = options
    .filter((o) => {
      if (!o.key) return false;
      const idx = options.indexOf(o);
      const node = optionEls[idx];
      const checked = node?.getAttribute('aria-checked');
      if (checked === 'true') return true;
      if (checked === 'false' && !raw) return false;
      return (
        raw === o.key ||
        (type === 'multiple' &&
          (raw.split(/[,;\s]+/).includes(o.key) ||
            (/^[A-Z]+$/.test(raw) && raw.includes(o.key))))
      );
    })
    .map((o) => o.id);
  const blanks: BlankRecord[] = [];
  if (type === 'blank') {
    const editors = [
      ...el.querySelectorAll<HTMLElement>(
        '[id^="answerEditor"], [id^="textarea"], textarea, input[type="text"], input:not([type])',
      ),
    ].filter(
      (n) => !n.closest('.edui-editor-toolbarbox') && !n.id?.startsWith('edui'),
    );
    for (const node of editors) {
      const editor =
        node.tagName !== 'INPUT' &&
        (node.id.startsWith('answerEditor') ||
          (node.tagName === 'DIV' && /textarea/.test(node.id)));
      if (blanks.some((b) => b.id === node.id) || !node.id) continue;
      const value = editor
        ? serverEditorText(node)
        : ((node as HTMLInputElement).value ?? '');
      blanks.push({
        id: node.id,
        kind: editor
          ? 'ueditor'
          : node.tagName === 'TEXTAREA'
            ? 'textarea'
            : 'input',
        value,
      });
    }
    existing = blanks.map((b) => b.value);
    if (readonly && !blanks.length) {
      const displayed =
        displayedBlanks(el, 'own') ?? displayedBlanks(el, 'platform');
      const count =
        displayed?.length ??
        stem.match(/_{2,}|＿{2,}|（\s*）|\(\s*\)/g)?.length ??
        0;
      for (let n = 0; n < count; n++)
        blanks.push({
          id: 'readonly:' + id + ':' + n,
          kind: 'input',
          value: '',
        });
    }
  }
  if (readonly) {
    const own = readOwnAnswer(el, { id, type, options, blanks });
    if (type === 'blank' && own?.blanks) {
      blanks.forEach((blank, i) => {
        blank.value = own.blanks![i] ?? '';
      });
      existing = blanks.map((b) => b.value);
    } else if (own?.optionIds) existing = own.optionIds;
  }
  const issues: string[] = [];
  if (!id || !/^\d+$/.test(id)) issues.push('题目 ID 无法确认');
  if (!stem) issues.push('题干缺失');
  if (type === 'unsupported') issues.push('不支持的题型，需人工处理');
  if (
    el.querySelector('audio, video, [type="file"]') ||
    /附件题/.test(el.getAttribute('typename') ?? '')
  )
    issues.push('含图片、媒体或附件，需人工处理');
  if (images.length) issues.push('题目文字识别需检查（图片待识别）');
  if (
    ['single', 'multiple', 'boolean'].includes(type) &&
    (options.length < 2 ||
      new Set(options.map((o) => o.key)).size !== options.length ||
      options.some((o) => !o.text || !o.key))
  )
    issues.push('选项内容或答案键不完整');
  if (type === 'blank' && blanks.length === 0)
    issues.push('未识别到填空输入位置');
  return {
    id,
    number: index + 1,
    type,
    stem,
    obfuscated: isEncoded(stemNode, url),
    options,
    blanks,
    existing,
    required: true,
    issues,
    ...(images.length ? { images } : {}),
    publishedAnswer: readPublishedAnswer(el, { id, type, options, blanks }),
  };
}
export function readPageStatus(
  doc: Document,
  url: string,
): { status: TaskStatus; grade?: string; deadline?: number } {
  assertPlatformPage(url, doc);
  const address = new URL(url);
  const preview = /\/work\/preview$/.test(address.pathname);
  const region =
    doc.querySelector(
      '.workTitle, .work-title, .workHead, .workHeader, .mark_title, .ZyTop, .workTit',
    ) ?? doc.body;
  const head = summaryText(region);
  const grade =
    head.match(/(?:成绩|得分)\s*[:：]?\s*(\d+(?:\.\d+)?)(?:分)?/)?.[1] ??
    (/\/work\/(?:view|review)$/.test(address.pathname)
      ? textOf(doc.querySelector('.detailsHead .resultNum')).match(
          /^(\d+(?:\.\d+)?)\s*分$/,
        )?.[1]
      : undefined);
  const deadline = parseDate(
    head.match(
      /(?:截止时间|截止日期|结束时间)\s*[:：]?\s*(20\d{2}[^\n]{0,24})/,
    )?.[1] ?? '',
  );
  // The platform's redirect receipt has neither the usual status words nor
  // a “成绩” prefix. Only accept its task-bound, dated success container;
  // a prompt URL or a question's maximum score alone is not a receipt.
  if (/\/work\/prompt$/.test(address.pathname)) {
    const receipt = doc.querySelector('.subSucess');
    const receiptText = receipt ? summaryText(receipt) : '';
    const container = receipt?.closest('.workCen') ?? receipt;
    const receiptContext = container ? summaryText(container) : '';
    const receiptGrade = receiptText.match(
      /^(\d+(?:\.\d+)?)\s*分(?:\s|$)/,
    )?.[1];
    const bound =
      taskIdentifiers(url, doc).work &&
      /^[1-9]\d*$/.test(address.searchParams.get('answerId') ?? '');
    if (
      bound &&
      receipt &&
      /提交时间\s*[:：]\s*\S/.test(receiptContext) &&
      (receiptGrade !== undefined || /提交成功|已提交|待批阅/.test(receiptText))
    )
      return { status: 'submitted', grade: receiptGrade, deadline };
    return { status: 'unknown', deadline };
  }
  if (preview) return { status: 'unknown', grade, deadline };
  if (
    /\/(?:view|review)(?:[/?]|$)/.test(url) ||
    /已提交|已完成|已批阅|待批阅/.test(head)
  )
    return { status: 'submitted', grade, deadline };
  if (
    /未交|待完成|未提交|未完成/.test(head) ||
    doc.querySelector('[onclick*="submitValidate"], [onclick*="btnBlueSubmit"]')
  )
    return {
      status: deadline && deadline < Date.now() ? 'expired' : 'pending',
      grade,
      deadline,
    };
  return { status: 'unknown', grade, deadline };
}
export function pageFingerprint(
  page: Pick<PageSnapshot, 'taskKey' | 'adapter' | 'questions' | 'fontCss'>,
): string {
  return hashText(
    JSON.stringify({
      // Candidate caches prepared with older text restoration rules must not
      // retain obsolete OCR issues or be reused for filling after an upgrade.
      textProcessingVersion: PAGE_TEXT_PROCESSING_VERSION,
      key: page.taskKey,
      adapter: page.adapter,
      font: page.fontCss ? hashText(page.fontCss) : undefined,
      questions: page.questions.map((q) => ({
        id: q.id,
        type: q.type,
        stem: q.stem,
        options: q.options.map((o) => [o.id, o.key, o.text]),
        blanks: q.blanks.map((b) => [b.id, b.kind]),
        ...(q.images?.length
          ? {
              images: q.images.map((image) => [
                image.id,
                image.part,
                image.optionId,
                image.resourceKey,
                image.width,
                image.height,
              ]),
            }
          : {}),
      })),
    }),
  );
}
export function extractPage(
  doc: Document,
  url: string,
  cookie = '',
): PageSnapshot | undefined {
  const modern = [...doc.querySelectorAll('.questionLi')];
  const legacy = [...doc.querySelectorAll('.TiMu')];
  const els = modern.length ? modern : legacy;
  if (!els.length) return undefined;
  const questions = els.map((el, index) => readQuestion(el, index, doc, url));
  const snapshot: PageSnapshot = {
    adapter: modern.length ? 'modern' : 'legacy',
    taskKey: taskKeyFromUrl(url, doc),
    fingerprint: '',
    url,
    title:
      textOf(doc.querySelector('.ceyan_name h3')) ||
      textOf(doc.querySelector('.workTitle, .work_name, .mark_title')) ||
      doc.title,
    ...readPageStatus(doc, url),
    questions,
    accountId: extractAccount(doc, cookie),
    ...(/\/work\/preview$/.test(new URL(url).pathname)
      ? { pageMode: 'preview' as const }
      : {}),
  };
  const fontFaces = new Set<string>();
  const appendFontFaces = (css: string, base: string) => {
    for (const face of css.match(/@font-face\s*\{[^}]*\}/gi) ?? []) {
      const family = face.match(/font-family\s*:\s*([^;}]+)/i)?.[1] ?? '';
      if (family.replace(/["']/g, '').trim().toLowerCase() !== 'font-cxsecret')
        continue;
      let valid = true;
      const resolved = face.replace(
        /url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)]+))\s*\)/gi,
        (_match, doubleQuoted: string, singleQuoted: string, unquoted: string) => {
          const raw = doubleQuoted ?? singleQuoted ?? unquoted ?? '';
          if (/^data:/i.test(raw)) return `url(${JSON.stringify(raw)})`;
          const url = safePageUrl(raw, base);
          if (!url) {
            valid = false;
            return 'url("")';
          }
          return `url(${JSON.stringify(url)})`;
        },
      );
      if (valid) fontFaces.add(resolved);
    }
  };
  for (const style of Array.from(doc.querySelectorAll('style')))
    appendFontFaces(style.textContent ?? '', doc.URL || url);
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    const base = sheet.href || doc.URL || url;
    for (const rule of Array.from(rules))
      if (rule.type === 5) appendFontFaces(rule.cssText, base);
  }
  const fontCss = [...fontFaces].join('\n');
  if (
    questions.some((q) => q.obfuscated || q.options.some((o) => o.obfuscated))
  )
    snapshot.fontCss = fontCss;
  snapshot.fingerprint = pageFingerprint(snapshot);
  return snapshot;
}
