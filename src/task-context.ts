export function classifyTaskPage(
  url: string,
  referrer = '',
  title = '',
): 'quiz' | 'homework' | 'exam' | undefined {
  const address = new URL(url);
  const path = address.pathname;
  let parentPath = '';
  try {
    parentPath = new URL(referrer).pathname;
  } catch {
    /* No referrer. */
  }
  if (
    /\/(?:exam|examination|exam-ans)(?:\/|$)/i.test(path + '/' + parentPath) ||
    /考试|考核试卷/.test(title)
  )
    return 'exam';
  if (/\/api\/work$|\/ananas\/modules\/work\/index\.html$/.test(path))
    return 'quiz';
  if (
    /\/work\/(?:task|dowork|view|review|preview|doHomeWorkNew|selectWorkQuestionYiPiYue|selectWorkQuestionWeiPiYue)$/.test(
      path,
    )
  ) {
    const knowledgeId =
      address.searchParams.get('knowledgeid') ??
      address.searchParams.get('knowledgeId');
    const chapterContext =
      /\/knowledge\/cards$|\/mycourse\/studentstudy$|\/ananas\/modules\/work\//.test(
        parentPath,
      ) ||
      (address.searchParams.get('api') === '1' &&
        Boolean(
          knowledgeId && /^\d+$/.test(knowledgeId) && Number(knowledgeId) > 0,
        ));
    return chapterContext ? 'quiz' : 'homework';
  }
  return undefined;
}
export function taskIdentifiers(
  url: string,
  doc?: Document,
): { course: string; clazz: string; work: string } {
  const params = new URL(url).searchParams;
  let parent = new URLSearchParams();
  try {
    if (doc?.referrer) parent = new URL(doc.referrer).searchParams;
  } catch {
    /* No parent context. */
  }
  function value(names: string[], fallback = true): string {
    for (const name of names) {
      const found =
        params.get(name) ||
        doc?.querySelector<HTMLInputElement>(
          `input[name="${name}"], input#${name}`,
        )?.value;
      if (found) return found;
    }
    if (fallback)
      for (const name of names) {
        const found = parent.get(name);
        if (found) return found;
      }
    return '';
  }
  return {
    course: value(['courseid', 'courseId']),
    clazz: value(['clazzId', 'clazzid', 'classId']),
    work: value(['workId', 'workid'], false),
  };
}

/** Match the stable card task id when a live work page also has an instance id. */
export function matchesTaskFrameKey(
  frame: { url: string; taskKey?: string },
  expectedTaskKey: string,
  knownTaskKey?: string,
): boolean {
  if (frame.taskKey === expectedTaskKey) return true;
  const expected = expectedTaskKey.match(/^([^:]+):([^:]+):work:(.+)$/);
  const actual = frame.taskKey?.match(/^([^:]+):([^:]+):work:(.+)$/);
  if (
    !expected ||
    !actual ||
    actual[1] !== expected[1] ||
    actual[2] !== expected[2]
  )
    return false;
  const known = knownTaskKey?.match(/^([^:]+):([^:]+):work:(.+)$/);
  if (
    known &&
    frame.taskKey === knownTaskKey &&
    known[1] === expected[1] &&
    known[2] === expected[2]
  )
    return true;
  const address = new URL(frame.url);
  if (!/\/work\/(?:task|dowork|view|review|preview|doHomeWorkNew|selectWorkQuestionYiPiYue|selectWorkQuestionWeiPiYue)$/.test(address.pathname))
    return false;
  return (
    address.searchParams.get('oldWorkId') === expected[3] ||
    address.searchParams.get('oldworkid') === expected[3] ||
    address.searchParams.get('oldWorkID') === expected[3]
  );
}
