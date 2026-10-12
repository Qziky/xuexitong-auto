import type { QuestionRecord, RecognitionTrace } from '../domain';
const SOURCES = {
  web: '网页原文',
  ocr: 'OCR',
  vision: '视觉识别',
  manual: '人工确认',
};
export function RecognitionSource({ trace }: { trace?: RecognitionTrace }) {
  if (!trace) return null;
  return (
    <span className={`recognition-source ${trace.source ?? 'unconfirmed'}`}>
      {trace.source ? SOURCES[trace.source] : '文字待确认'}
    </span>
  );
}
export function RecognitionDetails({ question }: { question: QuestionRecord }) {
  if (!question.recognition) return null;
  const fragments = [
    { label: '题干', trace: question.recognition.stem },
    ...question.options.map((option) => ({
      label: `选项 ${option.label}`,
      trace: question.recognition!.options[option.id],
    })),
    ...(question.images ?? []).map((image) => ({
      label: `${image.part === 'stem' ? '题干' : '选项 ' + (question.options.find((option) => option.id === image.optionId)?.label ?? '')} · ${image.placeholder}`,
      trace: question.recognition!.images?.[image.id],
    })),
  ];
  return (
    <details className="recognition-details">
      <summary>文字识别记录</summary>
      {fragments
        .filter((f) => f.trace)
        .map(({ label, trace }) => (
          <div key={label}>
            <strong>{label}</strong> <RecognitionSource trace={trace} />
            {trace!.attempts.map((attempt, index) => (
              <div className="recognition-attempt" key={index}>
                <span>
                  {SOURCES[attempt.engine]} ·{' '}
                  {attempt.success ? '已确认' : '未通过'}
                </span>
                {attempt.readings?.map((reading, i) => (
                  <div key={i}>
                    <span className="subtle">
                      第 {i + 1} 次 · 评分{' '}
                      {Number.isFinite(reading.confidence)
                        ? Math.round(reading.confidence)
                        : '未知'}
                    </span>
                    <pre>{reading.text || '（空结果）'}</pre>
                  </div>
                ))}
                {!attempt.readings?.length && attempt.text && (
                  <pre>{attempt.text}</pre>
                )}
                {attempt.reason && <p className="amber">{attempt.reason}</p>}
              </div>
            ))}
          </div>
        ))}
    </details>
  );
}
