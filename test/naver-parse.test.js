/**
 * 네이버 검색 결과 파서 테스트.
 *
 * 두 갈래로 검증한다.
 *  1) 마크업 세대별 표본(test/fixtures/naver-samples.js) — 파서의 각 분기가 도는지
 *  2) 실제로 캡처한 HTML(test/fixtures/naver/*.html) — `npm run capture` 로 받아 둔 것
 *
 * 2)는 파일이 있을 때만 돈다. 실제 네이버 HTML 로 확인하려면 먼저 캡처하라고
 * 안내만 하고 통과시킨다 (네트워크가 막힌 CI 에서 빨간불이 뜨지 않게).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { before, after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { extractBlogCards, extractNewsCards } from '../server/collect/extractors.js';
import { SEARCH } from '../server/naver/selectors.js';
import * as SAMPLES from './fixtures/naver-samples.js';

const CAPTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'naver');

let browser;
let page;

before(async () => {
  browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  page = await browser.newPage();
  // 캡처된 HTML 은 외부 스크립트·이미지를 참조한다. 문서만 우리가 채우고 나머지는 전부 막는다.
  await page.route('**/*', (route) =>
    route.request().resourceType() === 'document' ? route.fallback() : route.abort(),
  );
});

after(async () => {
  await browser?.close().catch(() => {});
});

/**
 * 검색 결과 URL 인 것처럼 HTML 을 올린다.
 * setContent 를 쓰면 about:blank 기준이라 상대 경로 링크가 깨지므로,
 * 실제 주소로 goto 하고 응답만 가로채서 채운다.
 */
async function load(html) {
  const url = 'https://search.naver.com/search.naver?query=test';
  await page.route(url, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }), {
    times: 1,
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
}

const parseNews = (max = 10) => page.evaluate(extractNewsCards, { selectors: SEARCH.news, max });
const parseBlogs = (max = 10) => page.evaluate(extractBlogCards, { selectors: SEARCH.blog, max });

// ── 뉴스 ──────────────────────────────────────────────────────────────────
test('뉴스: 구형 레이아웃에서 제목·링크·언론사·날짜·요약을 모두 뽑는다', async () => {
  await load(SAMPLES.NEWS_LEGACY);
  const items = await parseNews();

  assert.equal(items.length, 2);
  assert.equal(items[0].title, '원두 보관법 바꾸니 커피 맛이 달라졌다');
  assert.equal(items[0].link, 'https://n.news.naver.com/mnews/article/001/0014000001');
  assert.equal(items[0].press, '테스트일보', '"언론사 선정" 꼬리표는 떼어 내야 한다');
  assert.equal(items[0].date, '2시간 전');
  assert.match(items[0].summary, /밀폐와 온도 변화 차단/);
  assert.equal(items[1].date, '2026.09.18.', '절대 날짜 형식도 인식해야 한다');
});

test('뉴스: 신형 sds-comps 레이아웃을 인식하고 중첩 컨테이너를 중복으로 세지 않는다', async () => {
  await load(SAMPLES.NEWS_MODERN);
  const items = await parseNews();

  // 바깥 래퍼가 카드와 같은 클래스를 쓰지만, 링크 기준 중복 제거로 2건이어야 한다.
  assert.equal(items.length, 2, '중첩된 래퍼 때문에 같은 기사가 두 번 들어가면 안 된다');
  assert.equal(items[0].title, '커피 산패를 늦추는 네 가지 방법');
  assert.equal(items[0].link, 'https://n.news.naver.com/mnews/article/011/0011000001');
  assert.equal(items[0].press, '모던일보', 'span 안의 제목에서도 언론사를 찾아야 한다');
  assert.equal(items[0].date, '3시간 전');
  assert.match(items[0].summary, /산소, 빛, 습기/);
  assert.equal(items[1].date, '어제');
});

test('뉴스: 알려지지 않은 구조는 폴백이 링크 패턴으로 건져 낸다', async () => {
  await load(SAMPLES.NEWS_UNKNOWN);
  const items = await parseNews();

  assert.equal(items.length, 2, '짧은 카테고리 링크("연예")는 제외되어야 한다');
  assert.match(items[0].title, /완전히 새로운 레이아웃/);
  assert.ok(items.every((item) => item.link.startsWith('https://n.news.naver.com/')));
});

test('뉴스: 광고와 중복 기사를 걸러 낸다', async () => {
  await load(SAMPLES.NEWS_NOISY);
  const items = await parseNews();

  assert.equal(items.length, 1, '광고 1건 + 중복 1건이 빠져야 한다');
  assert.equal(items[0].title, '정상적인 기사 제목입니다');
  assert.ok(!items.some((item) => item.link.includes('adcr.naver.com')), '광고 링크가 섞이면 안 된다');
});

test('뉴스: max 를 넘겨 받으면 그 수만큼만 돌려준다', async () => {
  await load(SAMPLES.NEWS_LEGACY);
  assert.equal((await parseNews(1)).length, 1);
});

test('뉴스: 2026년 실제 구조 — 제목 블록 밖의 언론사·날짜까지 찾아낸다', async () => {
  await load(SAMPLES.NEWS_SDS_2026);
  const items = await parseNews();

  assert.equal(items.length, 2);
  assert.equal(
    items[0].title,
    '북적이는 축제속 고요한 커피머신 작동음…카누가 만든 홈카페 [2026청춘커피페스티벌]',
    '화면에 잘려 보이는 제목 대신 title 속성의 온전한 제목을 쓰고, "새 창 열림" 은 떼어 낸다',
  );
  assert.equal(items[0].link, 'https://www.hankyung.com/article/202609195237i', '원문 언론사 링크를 쓴다');
  assert.equal(items[0].press, '한국경제', '형제 블록에 있는 언론사를 찾아야 한다');
  assert.equal(items[0].date, '6시간 전');
  assert.match(items[0].summary, /1\.7배 많은 9\.5g/);

  assert.equal(items[1].press, '에너지경제', '두 번째 기사가 첫 기사의 언론사를 가져오면 안 된다');
  assert.equal(items[1].date, '2026.09.19.');
});

test('뉴스: "네이버뉴스" 링크를 날짜로 착각하지 않는다', async () => {
  await load(SAMPLES.NEWS_SDS_2026);
  const [first] = await parseNews();
  assert.ok(!/네이버뉴스/.test(first.date), `날짜에 "${first.date}" 가 들어왔다`);
  assert.ok(!/네이버뉴스/.test(first.press));
});

// ── 블로그 ────────────────────────────────────────────────────────────────
test('블로그: 구형 레이아웃에서 제목·작성자·날짜·요약을 뽑고 외부 블로그도 받는다', async () => {
  await load(SAMPLES.BLOG_LEGACY);
  const items = await parseBlogs();

  assert.equal(items.length, 2);
  assert.equal(items[0].title, '원두 3개월 써보고 남기는 보관 후기');
  assert.equal(items[0].link, 'https://blog.naver.com/homecafe/223000111');
  assert.equal(items[0].author, '홈카페러');
  assert.equal(items[0].date, '2026.09.10.');
  assert.match(items[0].summary, /소분 냉동이 나았습니다/);
  assert.ok(items[1].link.includes('tistory.com'), '티스토리·브런치도 인기 글로 받아들인다');
});

test('블로그: 신형 sds-comps 레이아웃을 인식한다', async () => {
  await load(SAMPLES.BLOG_MODERN);
  const items = await parseBlogs();

  assert.equal(items.length, 1);
  assert.equal(items[0].title, '드립 커피 입문 6개월 기록');
  assert.equal(items[0].author, '모던빈');
  assert.equal(items[0].date, '1일 전');
  assert.match(items[0].summary, /그라인더부터 물 온도까지/);
});

test('블로그: 블로그가 아닌 링크(연관 검색어 등)는 버린다', async () => {
  await load(SAMPLES.BLOG_OFFSITE);
  const items = await parseBlogs();

  assert.equal(items.length, 1);
  assert.equal(items[0].title, '진짜 블로그 글 제목');
  assert.ok(!items.some((item) => item.link.includes('search.naver.com')));
});

test('블로그: 알려지지 않은 구조는 폴백이 건져 낸다', async () => {
  await load(SAMPLES.BLOG_UNKNOWN);
  const items = await parseBlogs();

  assert.equal(items.length, 1, '"홈" 같은 짧은 링크는 제외되어야 한다');
  assert.match(items[0].title, /미래 레이아웃/);
});

test('블로그: 2026년 실제 구조 — 제목 블록 밖의 작성자·날짜까지 찾아낸다', async () => {
  await load(SAMPLES.BLOG_SDS_2026);
  const items = await parseBlogs();

  assert.equal(items.length, 2, '썸네일용 빈 블록이 항목으로 잡히면 안 된다');
  assert.equal(items[0].title, '홈카페 원두 추천 커피 입문자라면 그냥 외우세요');
  assert.equal(items[0].author, '우당탕탕 지구여행', '형제 블록에 있는 작성자를 찾아야 한다');
  assert.equal(items[0].date, '3일 전');
  assert.match(items[0].summary, /쫀득한 크레마/);

  assert.equal(items[1].author, '테니스리', '두 번째 글이 첫 글의 작성자를 가져오면 안 된다');
  assert.equal(items[1].date, '2026.09.01.');
});

// ── 실제 캡처본 ───────────────────────────────────────────────────────────
test('실제 캡처한 네이버 HTML 에서도 결과가 나온다', async (t) => {
  const files = fs.existsSync(CAPTURE_DIR)
    ? fs.readdirSync(CAPTURE_DIR).filter((name) => name.endsWith('.html'))
    : [];

  if (!files.length) {
    t.diagnostic('캡처본이 없어 건너뜁니다. `npm run capture` 로 실제 네이버 HTML 을 받아 두세요.');
    return;
  }

  for (const name of files) {
    const html = fs.readFileSync(path.join(CAPTURE_DIR, name), 'utf8');
    await load(html);

    const isNews = name.startsWith('news');
    const items = isNews ? await parseNews() : await parseBlogs();

    assert.ok(items.length >= 3, `${name}: 최소 3건은 나와야 하는데 ${items.length}건입니다`);
    assert.ok(
      items.every((item) => item.title && item.link?.startsWith('http')),
      `${name}: 제목이나 링크가 빈 항목이 있습니다`,
    );

    const withSummary = items.filter((item) => item.summary).length;
    assert.ok(withSummary > 0, `${name}: 요약이 전부 비어 있습니다 — summary 선택자를 확인하세요`);

    const source = isNews ? 'press' : 'author';
    assert.ok(
      items.filter((item) => item[source]).length > 0,
      `${name}: ${source} 가 전부 비어 있습니다 — 해당 선택자를 확인하세요`,
    );

    t.diagnostic(`${name}: ${items.length}건 (요약 ${withSummary}건) — ${items[0].title.slice(0, 40)}`);
  }
});
