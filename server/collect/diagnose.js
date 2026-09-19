/**
 * 검색 결과 페이지의 구조를 사람이(그리고 다른 개발자가) 읽을 수 있게 요약한다.
 *
 * 파서가 0건을 뽑았을 때 "0건"이라는 사실만으로는 아무것도 고칠 수 없다.
 * 실제 카드가 어떤 태그·클래스로 감싸여 있는지 알아야 선택자를 고칠 수 있으므로,
 * 결과 영역의 DOM 골격과 기사 링크의 조상 사슬을 함께 뽑아 둔다.
 *
 * extractors.js 와 마찬가지로 브라우저 안에서 실행되니 모듈 스코프를 참조하지 않는다.
 */

/**
 * 어떤 카드 선택자가 몇 개나 걸렸는지, 페이지가 정상인지 확인한다.
 * @param {{selectors: object}} args
 */
export function diagnoseSelectors({ selectors }) {
  const cardCounts = {};
  for (const candidate of selectors.cards) {
    cardCounts[candidate] = document.querySelectorAll(candidate).length;
  }
  const text = document.body?.innerText || '';
  return {
    cardCounts,
    fallbackLinks: document.querySelectorAll(selectors.fallbackLink).length,
    bodyChars: text.replace(/\s+/g, '').length,
    blocked: /로봇이 아닙니다|비정상적인 검색|자동 입력 방지|captcha/i.test(text),
    noResults: /검색결과가 없습니다|에 대한 검색결과가 없습니다/.test(text),
    title: document.title,
  };
}

/**
 * 기사·포스트 링크에서 위로 거슬러 올라가며 조상의 태그·클래스를 적는다.
 * 카드 선택자를 새로 써야 할 때 가장 직접적인 단서가 된다.
 * @param {{linkPattern: string, limit: number}} args
 */
export function anchorChains({ linkPattern, limit = 3 }) {
  const pattern = new RegExp(linkPattern);
  const signature = (el) => {
    const classes = (el.getAttribute('class') || '')
      .split(/\s+/)
      .filter(Boolean)
      // 해시가 붙은 클래스(name__aB3xY)는 배포마다 바뀌므로 접두사만 남긴다.
      .map((name) => name.replace(/__[A-Za-z0-9_-]{4,}$/, '__*'))
      .slice(0, 4);
    return el.tagName.toLowerCase() + (classes.length ? `.${classes.join('.')}` : '');
  };

  const anchors = [...document.querySelectorAll('a[href]')]
    .filter((anchor) => pattern.test(anchor.href))
    .filter((anchor) => (anchor.textContent || '').trim().length >= 8);

  const out = [];
  const seen = new Set();
  for (const anchor of anchors) {
    if (out.length >= limit) break;
    if (seen.has(anchor.href)) continue;
    seen.add(anchor.href);

    const chain = [];
    let node = anchor;
    for (let depth = 0; node && depth < 7 && node !== document.body; depth += 1) {
      chain.unshift(signature(node));
      node = node.parentElement;
    }
    out.push({
      title: (anchor.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50),
      href: anchor.href.slice(0, 90),
      chain,
    });
  }
  return out;
}

/**
 * 결과 영역의 DOM 골격을 들여쓰기 트리로 뽑는다.
 * 같은 모양의 형제는 "× N" 으로 접어 길이를 줄인다.
 * @param {{maxDepth: number, maxLines: number}} args
 */
export function domSkeleton({ maxDepth = 6, maxLines = 90 }) {
  const root =
    document.querySelector('#main_pack') ||
    document.querySelector('.api_subject_bx') ||
    document.querySelector('main') ||
    document.body;
  if (!root) return [];

  const signature = (el) => {
    const classes = (el.getAttribute('class') || '')
      .split(/\s+/)
      .filter(Boolean)
      .map((name) => name.replace(/__[A-Za-z0-9_-]{4,}$/, '__*'))
      .slice(0, 4);
    return el.tagName.toLowerCase() + (classes.length ? `.${classes.join('.')}` : '');
  };

  const lines = [];
  const walk = (el, depth) => {
    if (lines.length >= maxLines || depth > maxDepth) return;

    const children = [...el.children].filter(
      (child) => !['SCRIPT', 'STYLE', 'NOSCRIPT', 'svg', 'SVG'].includes(child.tagName),
    );

    let index = 0;
    while (index < children.length && lines.length < maxLines) {
      const child = children[index];
      const sig = signature(child);

      let repeat = 1;
      while (index + repeat < children.length && signature(children[index + repeat]) === sig) repeat += 1;

      lines.push(`${'  '.repeat(depth)}${sig}${repeat > 1 ? `  × ${repeat}` : ''}`);
      // 반복되는 카드는 첫 개만 펼쳐 봐도 구조를 알 수 있다.
      walk(child, depth + 1);
      index += repeat;
    }
  };

  lines.push(signature(root) + '   ← 결과 영역 루트');
  walk(root, 1);
  return lines;
}
