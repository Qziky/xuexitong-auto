/** Read header text without cloning a page or descending into question/player subtrees. */
export function summaryText(root: Element, max = 3500): string {
  const walker = root.ownerDocument.createTreeWalker(root, 5, {
    acceptNode(node) {
      if (
        node.nodeType === 1 &&
        (node as Element).matches(
          'script,style,iframe,.TiMu,.questionLi,video,audio',
        )
      )
        return 2;
      return node.nodeType === 3 ? 1 : 3;
    },
  });
  let result = '';
  for (
    let node = walker.nextNode();
    node && result.length < max;
    node = walker.nextNode()
  )
    result += (node.textContent ?? '') + ' ';
  return result.replace(/\s+/g, ' ').slice(0, max).trim();
}
