import { useEffect, useState } from 'react';
import type { QuestionImage, QuestionRecord } from '../domain';
import { answerImages } from '../image-content';
import { imageMaterials } from '../image-materials';

function SavedImage({ image, label }: { image: QuestionImage; label: string }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const binding = JSON.stringify(image.material);
  useEffect(() => {
    let active = true;
    let objectUrl = '';
    setUrl('');
    setError('');
    if (!image.material) {
      setError('原图尚未保存，请重新识别本题');
      return;
    }
    void imageMaterials
      .read(image.material)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (active) setError('原图材料已失效，请重新识别本题');
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [binding]);
  const extension =
    image.material?.mimeType === 'image/jpeg'
      ? 'jpg'
      : image.material?.mimeType === 'image/webp'
        ? 'webp'
        : 'png';
  return (
    <figure className="question-image-material">
      <figcaption>
        {label} · {image.placeholder} · 原图材料
      </figcaption>
      {url ? (
        <>
          <img src={url} alt={label + ' ' + image.placeholder} />
          <a
            href={url}
            download={
              'question-image-' +
              image.id.replace(/[^a-z0-9_-]/gi, '-') +
              '.' +
              extension
            }
          >
            下载原图
          </a>
        </>
      ) : (
        <small className={error ? 'warning' : ''}>
          {error || '正在读取本机原图…'}
        </small>
      )}
    </figure>
  );
}

export function QuestionImages({
  question,
  optionId,
}: {
  question: QuestionRecord;
  optionId?: string;
}) {
  const images = answerImages(question).filter((image) =>
    optionId === undefined
      ? image.part === 'stem'
      : image.part === 'option' && image.optionId === optionId,
  );
  if (!images.length) return null;
  const label =
    optionId === undefined
      ? '题干'
      : '选项 ' +
        question.options.find((option) => option.id === optionId)?.label;
  return (
    <div className="question-image-materials">
      {images.map((image) => (
        <SavedImage key={image.id} image={image} label={label} />
      ))}
    </div>
  );
}
