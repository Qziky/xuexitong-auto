import { expect, it } from 'vitest';
import { matchesCourseLearningMenu } from '../src/learning-directory';

const course = {
  courseId: '100',
  classId: '200',
  cpi: '300',
  url: 'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=100&clazzid=200&cpi=300',
};

it('rebinds a course directory when the live route uses camel-case courseId', () => {
  expect(
    matchesCourseLearningMenu(
      {
        hasLearningMenu: true,
        url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=900&courseId=100&clazzid=200&cpi=300',
      },
      course,
    ),
  ).toBe(true);
});

it('rejects another enrollment, course, class, non-directory frame, or foreign origin', () => {
  const url =
    'https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=100&clazzid=200&cpi=300';
  expect(matchesCourseLearningMenu({ url, hasLearningMenu: true }, course)).toBe(
    true,
  );
  expect(
    matchesCourseLearningMenu(
      { url: url.replace('cpi=300', 'cpi=301'), hasLearningMenu: true },
      course,
    ),
  ).toBe(false);
  expect(
    matchesCourseLearningMenu(
      { url: url.replace('courseId=100', 'courseId=101'), hasLearningMenu: true },
      course,
    ),
  ).toBe(false);
  expect(
    matchesCourseLearningMenu(
      { url: url.replace('clazzid=200', 'clazzid=201'), hasLearningMenu: true },
      course,
    ),
  ).toBe(false);
  expect(matchesCourseLearningMenu({ url, hasLearningMenu: false }, course)).toBe(
    false,
  );
  expect(
    matchesCourseLearningMenu(
      { url: url.replace('mooc1.chaoxing.com', 'example.com'), hasLearningMenu: true },
      course,
    ),
  ).toBe(false);
});
