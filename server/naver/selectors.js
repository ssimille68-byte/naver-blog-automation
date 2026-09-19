/**
 * 네이버 스마트에디터 ONE 의 DOM 은 해시가 붙은 클래스명을 쓰고(`publish_btn__m9KHH`)
 * 배포마다 해시가 바뀐다. 그래서 아래 선택자는 전부 "후보 배열"이고,
 * 접두사 부분 일치(`[class*="publish_btn"]`)와 텍스트 매칭을 함께 쓴다.
 *
 * 네이버가 구조를 바꿔 자동화가 깨지면 이 파일만 고치면 된다.
 */
export const SEL = {
  // 에디터가 들어 있는 iframe
  editorFrame: ['iframe#mainFrame', 'iframe[name="mainFrame"]'],

  // 진입 시 뜨는 방해 요소들
  dismissables: [
    '.se-popup-button-cancel',                   // "작성 중인 글이 있습니다" 복구 팝업 – 취소
    '.se-popup-button-close',
    'button.se-help-panel-close-button',         // 도움말 패널
    '.se-guide-hide-button',
    'article[class*="popup"] button[class*="close"]',
    'button[class*="btn_close"]',
  ],

  // 제목 영역
  title: [
    '.se-section-documentTitle .se-text-paragraph',
    '.se-documentTitle .se-text-paragraph',
    '.se-section-documentTitle',
    'span.se-placeholder.__se_placeholder',
  ],

  // 본문 영역
  body: [
    '.se-section-text .se-text-paragraph',
    '.se-component.se-text .se-text-paragraph',
    '.se-main-container .se-text-paragraph',
    '.se-main-container',
  ],
  bodyContainer: ['.se-main-container', '.se-container'],

  // 툴바 - 이미지 추가
  imageButton: [
    'button.se-image-toolbar-button',
    'button[data-name="image"]',
    '.se-toolbar-item-image button',
    'button[data-log="ect.image"]',
  ],
  imageFileInput: ['input.se-image-file-input', 'input[type="file"][accept*="image"]', 'input[type="file"]'],

  // 툴바 - 구분선
  dividerButton: [
    'button.se-horizontalLine-toolbar-button',
    'button[data-name="horizontalLine"]',
    '.se-toolbar-item-horizontalLine button',
  ],

  // 툴바 - 인용구
  quoteButton: [
    'button.se-quotation-toolbar-button',
    'button[data-name="quotation"]',
    '.se-toolbar-item-quotation button',
  ],

  // 발행 1단계 (헤더의 "발행" 버튼)
  publishOpen: [
    'button[class*="publish_btn"]',
    '.header button:has-text("발행")',
    'button.publish_btn__m9KHH',
    '[data-click-area="tpb.publish"]',
  ],

  // 발행 레이어
  publishLayer: ['[class*="layer_publish"]', '.option_area', '[class*="publish_layer"]'],
  categoryToggle: ['button[class*="selectbox_button"]', '.selectbox_button__jb1Dt'],
  categoryOption: ['[class*="selectbox_list"] [class*="option"] button', '.option_list__ry7Zd button'],
  tagInput: ['#tag-input', 'input[class*="tag_input"]', 'input[placeholder*="태그"]'],

  // 발행 2단계 (레이어 안의 최종 "발행" 버튼)
  publishConfirm: [
    'button[class*="confirm_btn"]',
    '[data-click-area="tpb*i.publish"]',
    'button.confirm_btn__WEaBq',
  ],

  // 발행 완료 후 나타나는 것들
  publishedMarkers: ['.se-viewer', '#post-area', '.post_ct', '.se_doc_viewer'],
};

/**
 * Try each candidate selector in turn and return the first one that resolves
 * to a visible element. Returns null when none of them match.
 */
export async function firstVisible(scope, candidates, { timeout = 4000 } = {}) {
  // 1단계: 이미 떠 있는 요소를 빠르게 훑는다. 대부분 여기서 끝난다.
  for (const selector of candidates) {
    try {
      const locator = scope.locator(selector).first();
      if (await locator.isVisible({ timeout: 250 })) return locator;
    } catch {
      // 다음 후보
    }
  }

  // 2단계: 아직 렌더링 전일 수 있으므로 후보마다 제대로 기다려 본다.
  for (const selector of candidates) {
    try {
      const locator = scope.locator(selector).first();
      await locator.waitFor({ state: 'visible', timeout });
      return locator;
    } catch {
      // 다음 후보
    }
  }
  return null;
}

/** Like firstVisible but only checks presence, not visibility (hidden inputs). */
export async function firstPresent(scope, candidates, { timeout = 3000 } = {}) {
  for (const selector of candidates) {
    try {
      const locator = scope.locator(selector).first();
      await locator.waitFor({ state: 'attached', timeout });
      return locator;
    } catch {
      // 계속 시도
    }
  }
  return null;
}

/**
 * 검색 결과 카드 선택자.
 *
 * 네이버 검색은 개편 때마다 마크업 세대가 통째로 바뀐다. 지금까지 확인된 세대를
 * 모두 후보로 두고, 카드 선택자를 순서대로 시도해 처음으로 결과가 나오는 세대를 쓴다.
 * 어느 세대에도 걸리지 않으면 `fallbackLink` 로 링크 패턴만 보고 긁는다.
 *
 * 브라우저 안에서 실행되는 추출기(server/collect/extractors.js)에 인자로 넘어가므로
 * 순수 데이터만 담아야 한다.
 */
export const SEARCH = {
  news: {
    cards: [
      'div.sds-comps-base-layout.sds-comps-full-layout',
      'div.news_wrap.api_ani_send',
      'li.bx',
      'div.group_news > div',
    ],
    title: [
      'a.news_tit',
      'span.sds-comps-text-type-headline1',
      'a[href*="n.news.naver.com"]',
      'a[href^="http"]',
    ],
    summary: ['div.news_dsc', 'span.sds-comps-text-type-body1', 'a.api_txt_lines.dsc_txt_wrap'],
    press: ['a.info.press', 'span.sds-comps-profile-info-title-text', '.press'],
    date: ['span.info', 'span.sds-comps-profile-info-subtext'],
    fallbackLink: 'a[href*="n.news.naver.com"], a[href*="news.naver.com"]',
    minTitleLength: 8,
    minFallbackTitleLength: 12,
  },
  blog: {
    cards: [
      'div.view_wrap',
      'li.bx._svp_item',
      'div.sds-comps-base-layout.sds-comps-full-layout',
      'li.bx',
    ],
    title: [
      'a.title_link',
      'a.api_txt_lines.total_tit',
      'span.sds-comps-text-type-headline1',
      'a[href*="blog.naver.com"]',
    ],
    summary: ['a.dsc_link', 'div.api_txt_lines.dsc_txt', 'span.sds-comps-text-type-body1'],
    author: ['a.name', 'span.sds-comps-profile-info-title-text', '.user_info > a'],
    date: ['span.sub', 'span.sds-comps-profile-info-subtext'],
    fallbackLink: 'a[href*="blog.naver.com"]',
    linkPattern: 'blog\\.naver\\.com|post\\.naver\\.com|tistory|brunch',
    minTitleLength: 6,
    minFallbackTitleLength: 8,
  },
};
