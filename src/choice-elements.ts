// Chapter quizzes use separate labels and handlers for multiple choice.
// Keep extraction and native clicking on the same DOM sequence and real keys.
export const CHOICE_CONTROL_SELECTOR =
  '[onclick*="addChoice"], [onclick*="addMultipleChoice"], [role="radio"][qid], [role="checkbox"][qid]';
export const CHOICE_LABEL_SELECTOR = '.num_option, .num_option_dx';
export const CHOICE_KEY_SELECTOR = '.num_option[data], .num_option_dx[data]';

export function editableChoiceElements(root: Element): HTMLElement[] {
  return (
    [...root.querySelectorAll<HTMLElement>(CHOICE_CONTROL_SELECTOR)]
      // Retain a visible choice even when its key is missing. The parser must
      // report that structural problem instead of silently dropping an option.
      .filter((node) => node.querySelector(CHOICE_LABEL_SELECTOR))
  );
}
