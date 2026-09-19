/**
 * 검색 결과 카드에서 항목을 뽑아내는 함수들.
 *
 * 이 함수들은 Playwright 의 page.evaluate() 로 **브라우저 안에서** 실행된다.
 * 그래서 모듈 스코프의 어떤 것도 참조할 수 없고, 필요한 선택자는 전부 인자로 받는다.
 * 대신 그 덕분에 실제 네이버에 접속하지 않고 저장해 둔 HTML 만으로도 그대로 검증할 수 있다.
 * (test/naver-parse.test.js, scripts/capture-naver.js 참고)
 */

/**
 * 뉴스 검색 결과 추출기.
 * @param {{selectors: object, max: number}} args
 */
export function extractNewsCards({ selectors, max }) {
  const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const pick = (card, list) => {
    for (const selector of list) {
      const el = card.querySelector(selector);
      const text = clean(el?.textContent);
      if (text) return text;
    }
    return '';
  };

  const seen = new Set();
  const push = (out, item) => {
    if (!item.link || seen.has(item.link)) return;
    seen.add(item.link);
    out.push(item);
  };

  for (const cardSelector of selectors.cards) {
    const out = [];
    for (const card of document.querySelectorAll(cardSelector)) {
      // 제목 후보는 요소 자체가 링크가 아닐 수도 있어(span 안의 텍스트) 가장 가까운 a 로 올라간다.
      let titleEl = null;
      for (const selector of selectors.title) {
        const found = card.querySelector(selector);
        const anchor = found?.tagName === 'A' ? found : found?.closest('a');
        if (anchor?.href) {
          titleEl = anchor;
          break;
        }
      }
      if (!titleEl) continue;

      const title = clean(titleEl.textContent);
      if (title.length < selectors.minTitleLength) continue;

      const dateEl = [...card.querySelectorAll(selectors.date.join(','))].find((el) =>
        /(전|앞|어제|오늘|\d{4}\.)/.test(el.textContent || ''),
      );

      push(out, {
        title,
        link: titleEl.href,
        summary: pick(card, selectors.summary).slice(0, 400),
        press: pick(card, selectors.press).replace(/언론사 선정$/, '').trim(),
        date: clean(dateEl?.textContent),
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
    push(out, { title, link: anchor.href, summary: '', press: '', date: '' });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 블로그 검색 결과 추출기.
 * @param {{selectors: object, max: number}} args
 */
export function extractBlogCards({ selectors, max }) {
  const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const pick = (card, list) => {
    for (const selector of list) {
      const el = card.querySelector(selector);
      const text = clean(el?.textContent);
      if (text) return text;
    }
    return '';
  };

  const linkPattern = new RegExp(selectors.linkPattern);
  const seen = new Set();
  const push = (out, item) => {
    if (!item.link || seen.has(item.link)) return;
    seen.add(item.link);
    out.push(item);
  };

  for (const cardSelector of selectors.cards) {
    const out = [];
    for (const card of document.querySelectorAll(cardSelector)) {
      let titleEl = null;
      for (const selector of selectors.title) {
        const found = card.querySelector(selector);
        const anchor = found?.tagName === 'A' ? found : found?.closest('a');
        if (anchor?.href) {
          titleEl = anchor;
          break;
        }
      }
      if (!titleEl) continue;

      const title = clean(titleEl.textContent);
      if (title.length < selectors.minTitleLength) continue;
      if (!linkPattern.test(titleEl.href)) continue;

      push(out, {
        title,
        link: titleEl.href,
        summary: pick(card, selectors.summary).slice(0, 400),
        author: pick(card, selectors.author),
        date: pick(card, selectors.date),
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
    push(out, { title, link: anchor.href, summary: '', author: '', date: '' });
    if (out.length >= max) break;
  }
  return out;
}
