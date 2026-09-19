/**
 * 검색 결과 카드에서 항목을 뽑아내는 함수들.
 *
 * 이 함수들은 Playwright 의 page.evaluate() 로 **브라우저 안에서** 실행된다.
 * 그래서 모듈 스코프의 어떤 것도 참조할 수 없고, 필요한 선택자는 전부 인자로 받는다.
 * 대신 그 덕분에 실제 네이버에 접속하지 않고 저장해 둔 HTML 만으로도 그대로 검증할 수 있다.
 * (test/naver-parse.test.js, scripts/capture-naver.js 참고)
 *
 * 카드 범위를 두 겹으로 나누는 이유:
 *   네이버의 신형 레이아웃에서 제목·요약을 감싼 블록과 언론사·날짜를 담은 프로필 블록은
 *   서로 형제다. 제목이 잡히는 블록만 보면 출처·날짜가 통째로 비어 버린다.
 *   그렇다고 바깥 컨테이너를 선택자로 박으면 해시 클래스(v33RoPVqTTc4AJaM)라 곧 깨진다.
 *   그래서 제목에서 위로 거슬러 올라가되, 다른 기사까지 품기 직전에 멈춘다.
 */

export function extractNewsCards({ selectors, max }) {
  const clean = (t) =>
    String(t || '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/(?:\s*(?:새\s?창\s?열림|언론사\s?선정|선택됨))+$/, '')
      .trim();

  const pick = (scope, list) => {
    for (const selector of list || []) {
      const text = clean(scope.querySelector(selector)?.textContent);
      if (text) return text;
    }
    return '';
  };

  const pickDate = (scope, list) => {
    const nodes = list?.length ? [...scope.querySelectorAll(list.join(','))] : [];
    const dated = nodes.find((el) => /(\d+\s*(분|시간|일|주|개월)\s*전|어제|오늘|\d{4}\s*\.)/.test(el.textContent || ''));
    return clean(dated?.textContent) || '';
  };

  /** 제목에서 위로 올라가 출처·날짜까지 품는 범위를 찾는다. */
  const metaScopeOf = (node, fallback) => {
    if (!selectors.titleMarker) return fallback;
    let scope = node;
    for (let step = 0; step < (selectors.maxClimb || 8); step += 1) {
      const parent = scope.parentElement;
      if (!parent || parent === document.body) break;
      // 다른 기사까지 품기 시작하면 남의 출처를 가져오게 된다. 직전에 멈춘다.
      if (parent.querySelectorAll(selectors.titleMarker).length > 1) break;
      scope = parent;
      if (selectors.metaMarker && scope.querySelector(selectors.metaMarker)) return scope;
    }
    return fallback;
  };

  const titleTextOf = (node, anchor) => {
    const shown = clean(node.textContent);
    // 네이버는 긴 제목을 "..." 로 잘라 보여 준다. 온전한 제목이 속성에 남아 있으면 그쪽을 쓴다.
    const full = clean(anchor.getAttribute('title') || anchor.getAttribute('aria-label'));
    return full.length > shown.length ? full : shown;
  };

  const seen = new Set();
  const collect = (out, item) => {
    if (!item.link || seen.has(item.link)) return;
    seen.add(item.link);
    out.push(item);
  };

  for (const cardSelector of selectors.cards) {
    const out = [];
    for (const card of document.querySelectorAll(cardSelector)) {
      // 제목 후보는 요소 자체가 링크가 아닐 수도 있어(span 안의 텍스트) 가장 가까운 a 로 올라간다.
      let anchor = null;
      let titleNode = null;
      for (const selector of selectors.title) {
        const found = card.querySelector(selector);
        const link = found?.tagName === 'A' ? found : found?.closest('a');
        if (link?.href) {
          anchor = link;
          // 링크 전체가 아니라 제목 요소의 글자를 쓴다. 링크에는 숨김 텍스트가 섞여 있다.
          titleNode = found;
          break;
        }
      }
      if (!anchor) continue;

      const title = titleTextOf(titleNode, anchor);
      if (title.length < selectors.minTitleLength) continue;

      const meta = metaScopeOf(anchor, card);
      collect(out, {
        title,
        link: anchor.href,
        summary: pick(card, selectors.summary).slice(0, 400),
        press: pick(meta, selectors.press),
        date: pickDate(meta, selectors.date),
      });
      if (out.length >= max) return out;
    }
    if (out.length) return out;
    seen.clear();
  }

  // 알려진 어떤 세대에도 걸리지 않았다 — 뉴스 도메인으로 향하는 링크만 보고 긁는다.
  const out = [];
  for (const anchor of document.querySelectorAll(selectors.fallbackLink)) {
    const title = clean(anchor.textContent);
    if (title.length < selectors.minFallbackTitleLength) continue;
    collect(out, { title, link: anchor.href, summary: '', press: '', date: '' });
    if (out.length >= max) break;
  }
  return out;
}

export function extractBlogCards({ selectors, max }) {
  const clean = (t) =>
    String(t || '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/(?:\s*(?:새\s?창\s?열림|선택됨|블로그 내 검색))+$/, '')
      .trim();

  const pick = (scope, list) => {
    for (const selector of list || []) {
      const text = clean(scope.querySelector(selector)?.textContent);
      if (text) return text;
    }
    return '';
  };

  const pickDate = (scope, list) => {
    const nodes = list?.length ? [...scope.querySelectorAll(list.join(','))] : [];
    const dated = nodes.find((el) => /(\d+\s*(분|시간|일|주|개월)\s*전|어제|오늘|\d{4}\s*\.)/.test(el.textContent || ''));
    return clean(dated?.textContent) || '';
  };

  const metaScopeOf = (node, fallback) => {
    if (!selectors.titleMarker) return fallback;
    let scope = node;
    for (let step = 0; step < (selectors.maxClimb || 8); step += 1) {
      const parent = scope.parentElement;
      if (!parent || parent === document.body) break;
      if (parent.querySelectorAll(selectors.titleMarker).length > 1) break;
      scope = parent;
      if (selectors.metaMarker && scope.querySelector(selectors.metaMarker)) return scope;
    }
    return fallback;
  };

  const linkPattern = new RegExp(selectors.linkPattern);
  const titleTextOf = (node, anchor) => {
    const shown = clean(node.textContent);
    // 네이버는 긴 제목을 "..." 로 잘라 보여 준다. 온전한 제목이 속성에 남아 있으면 그쪽을 쓴다.
    const full = clean(anchor.getAttribute('title') || anchor.getAttribute('aria-label'));
    return full.length > shown.length ? full : shown;
  };

  const seen = new Set();
  const collect = (out, item) => {
    if (!item.link || seen.has(item.link)) return;
    seen.add(item.link);
    out.push(item);
  };

  for (const cardSelector of selectors.cards) {
    const out = [];
    for (const card of document.querySelectorAll(cardSelector)) {
      let anchor = null;
      let titleNode = null;
      for (const selector of selectors.title) {
        const found = card.querySelector(selector);
        const link = found?.tagName === 'A' ? found : found?.closest('a');
        if (link?.href) {
          anchor = link;
          titleNode = found;
          break;
        }
      }
      if (!anchor) continue;

      const title = titleTextOf(titleNode, anchor);
      if (title.length < selectors.minTitleLength) continue;
      if (!linkPattern.test(anchor.href)) continue;

      const meta = metaScopeOf(anchor, card);
      collect(out, {
        title,
        link: anchor.href,
        summary: pick(card, selectors.summary).slice(0, 400),
        author: pick(meta, selectors.author),
        date: pickDate(meta, selectors.date),
      });
      if (out.length >= max) return out;
    }
    if (out.length) return out;
    seen.clear();
  }

  const out = [];
  for (const anchor of document.querySelectorAll(selectors.fallbackLink)) {
    const title = clean(anchor.textContent);
    if (title.length < selectors.minFallbackTitleLength) continue;
    collect(out, { title, link: anchor.href, summary: '', author: '', date: '' });
    if (out.length >= max) break;
  }
  return out;
}
