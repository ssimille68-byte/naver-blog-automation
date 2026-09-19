#!/usr/bin/env node
/**
 * 실제 네이버 검색 결과 HTML 을 내려받아 파서를 검증하고, 그 HTML 을 픽스처로 저장한다.
 *
 *   node scripts/capture-naver.js                 # 기본 키워드로 실행
 *   node scripts/capture-naver.js "홈카페" "러닝"  # 키워드 직접 지정
 *   node scripts/capture-naver.js --no-save       # 저장하지 않고 확인만
 *
 * 저장된 HTML 은 test/fixtures/naver/ 에 들어가고, `npm test` 가 자동으로 이를
 * 회귀 테스트로 사용한다. 네이버가 검색 결과 구조를 바꿔 수집이 0건이 되면
 * 이 스크립트를 다시 돌려 픽스처를 갱신한 뒤 선택자를 고치면 된다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withScraper } from '../server/browser.js';
import { BLOG_URL, NEWS_URL } from '../server/collect/naver-search.js';
import { extractBlogCards, extractNewsCards } from '../server/collect/extractors.js';
import { SEARCH } from '../server/naver/selectors.js';

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'naver');

const args = process.argv.slice(2);
const save = !args.includes('--no-save');
const keywords = args.filter((arg) => !arg.startsWith('--'));
if (!keywords.length) keywords.push('홈카페 원두');

const slug = (text) => text.replace(/[^가-힣a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** Which card selector generation actually matched? Tells us what to fix when it breaks. */
async function diagnose(page, selectors) {
  return page.evaluate((sel) => {
    const counts = {};
    for (const candidate of sel.cards) {
      counts[candidate] = document.querySelectorAll(candidate).length;
    }
    return {
      cardCounts: counts,
      fallbackLinks: document.querySelectorAll(sel.fallbackLink).length,
      bodyChars: document.body.innerText.replace(/\s+/g, '').length,
      blocked: /로봇이 아닙니다|비정상적인 검색|captcha/i.test(document.body.innerText),
    };
  }, selectors);
}

function report(label, items, info) {
  const status = items.length ? '✅' : '❌';
  console.log(`\n${status} ${label} — ${items.length}건 추출`);

  const matched = Object.entries(info.cardCounts).filter(([, count]) => count > 0);
  if (matched.length) {
    console.log(`   카드 선택자 적중: ${matched.map(([sel, n]) => `${sel} (${n}개)`).join(', ')}`);
  } else {
    console.log(`   ⚠️  알려진 카드 선택자가 하나도 걸리지 않음 (폴백 링크 ${info.fallbackLinks}개)`);
  }
  if (info.blocked) console.log('   ⚠️  네이버가 자동화 차단 페이지를 내려보냈습니다.');
  if (info.bodyChars < 500) console.log(`   ⚠️  본문이 비어 있습니다 (${info.bodyChars}자). 페이지가 제대로 안 열렸을 수 있습니다.`);

  for (const item of items.slice(0, 3)) {
    console.log(`   · ${item.title.slice(0, 55)}`);
    console.log(`     ${item.press || item.author || '(출처 없음)'} | ${item.date || '(날짜 없음)'}`);
    console.log(`     ${(item.summary || '(요약 없음)').slice(0, 70)}`);
  }

  // 카드는 찾았는데 특정 필드만 통째로 비어 있다면, 내부 선택자가 낡았다는 뜻이다.
  if (items.length) {
    const fields = ['summary', 'date', 'press' in items[0] ? 'press' : 'author'];
    const empty = fields.filter((field) => items.every((item) => !item[field]));
    if (empty.length) console.log(`   ⚠️  모든 항목에서 비어 있는 필드: ${empty.join(', ')} — 해당 선택자를 확인하세요.`);
  }
}

let failures = 0;
let navErrors = 0;

await withScraper(async (context) => {
  const page = await context.newPage();
  if (save) fs.mkdirSync(FIXTURE_DIR, { recursive: true });

  for (const keyword of keywords) {
    for (const [kind, url, selectors, extractor] of [
      ['news', NEWS_URL(keyword), SEARCH.news, extractNewsCards],
      ['blog', BLOG_URL(keyword), SEARCH.blog, extractBlogCards],
    ]) {
      console.log(`\n${'─'.repeat(70)}\n${kind === 'news' ? '뉴스' : '블로그'} · "${keyword}"\n${url}`);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await page.waitForTimeout(2000);

        const info = await diagnose(page, selectors);
        const items = await page.evaluate(extractor, { selectors, max: 10 });
        report(`${kind}/${keyword}`, items, info);
        if (!items.length) failures += 1;

        if (save) {
          const file = path.join(FIXTURE_DIR, `${kind}-${slug(keyword)}.html`);
          fs.writeFileSync(file, await page.content());
          console.log(`   💾 ${path.relative(process.cwd(), file)}`);
        }
      } catch (err) {
        failures += 1;
        navErrors += 1;
        console.log(`\n❌ ${kind}/${keyword} — 페이지를 열지 못했습니다: ${err.message.split('\n')[0]}`);
      }
    }
  }
  await page.close().catch(() => {});
});

console.log(`\n${'─'.repeat(70)}`);
if (navErrors === failures && navErrors > 0) {
  console.log(`\n${navErrors}개 페이지를 아예 열지 못했습니다. 파서 문제가 아니라 네트워크 문제입니다.`);
  console.log('인터넷 연결과 프록시 설정을 확인한 뒤 다시 실행해 주세요.\n');
} else if (failures) {
  console.log(`\n${failures}개 검색에서 결과를 뽑지 못했습니다.`);
  console.log('저장된 HTML 을 열어 카드 구조를 확인하고 server/naver/selectors.js 의 SEARCH 를 고치세요.');
  console.log('고친 뒤 `npm test` 로 저장된 픽스처에 대해 바로 재검증할 수 있습니다.\n');
} else {
  console.log('\n모든 검색에서 결과를 정상적으로 추출했습니다.');
  if (save) console.log('저장된 HTML 은 이제 `npm test` 의 회귀 테스트로 쓰입니다.\n');
}
process.exit(failures ? 1 : 0);
