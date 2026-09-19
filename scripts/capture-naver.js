#!/usr/bin/env node
/**
 * 실제 네이버 검색 결과로 파서를 검증하고, 고칠 거리가 있으면 그대로 붙여 넣을 수 있는
 * 진단 리포트를 만든다.
 *
 *   npm run capture                          기본 키워드로 실행
 *   npm run capture -- "홈카페" "러닝 입문"    키워드 지정
 *   npm run capture -- --no-save             HTML 을 저장하지 않음
 *   npm run capture -- --from <파일.html>     이미 저장한 HTML 을 다시 진단 (네트워크 불필요)
 *
 * 결과 HTML 은 test/fixtures/naver/ 에 저장되고 `npm test` 가 회귀 테스트로 쓴다.
 * 리포트는 capture-report.md 로 저장된다 — 파서가 0건을 뽑았을 때 이 파일만 있으면
 * 실제 카드가 어떤 태그·클래스로 감싸여 있는지 알 수 있어 선택자를 고칠 수 있다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { withScraper } from '../server/browser.js';
import { BLOG_URL, NEWS_URL } from '../server/collect/naver-search.js';
import { extractBlogCards, extractNewsCards } from '../server/collect/extractors.js';
import { anchorChains, diagnoseSelectors, domSkeleton } from '../server/collect/diagnose.js';
import { SEARCH } from '../server/naver/selectors.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = path.join(ROOT, 'test', 'fixtures', 'naver');
const REPORT_FILE = path.join(ROOT, 'capture-report.md');

// ── 인자 파싱 ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const save = !argv.includes('--no-save');
const fromFiles = [];
const keywords = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--from') fromFiles.push(argv[++i]);
  else if (!argv[i].startsWith('--')) keywords.push(argv[i]);
}
if (!keywords.length && !fromFiles.length) keywords.push('홈카페 원두');

const slug = (text) => text.replace(/[^가-힣a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const kindOf = (name) => (path.basename(name).startsWith('blog') ? 'blog' : 'news');

const report = [];
const say = (line = '') => {
  console.log(line);
  report.push(line);
};

let checked = 0;
let failed = 0;
let degraded = 0;
let navErrors = 0;

/** Run both extractors + diagnostics against whatever page is currently loaded. */
async function inspect(page, { kind, label }) {
  checked += 1;
  const selectors = SEARCH[kind];
  const extractor = kind === 'news' ? extractNewsCards : extractBlogCards;

  const info = await page.evaluate(diagnoseSelectors, { selectors });
  const items = await page.evaluate(extractor, { selectors, max: 10 });

  const matched = Object.entries(info.cardCounts).filter(([, count]) => count > 0);
  const fields = ['summary', 'date', kind === 'news' ? 'press' : 'author'];
  const emptyFields = items.length ? fields.filter((field) => items.every((item) => !item[field])) : [];

  // 제목만 건진 상태도 "성공"이 아니다 — 요약·출처·날짜가 통째로 비면 글감 판단이 불가능하다.
  const status = !items.length ? 'fail' : emptyFields.length || !matched.length ? 'degraded' : 'ok';
  if (status === 'fail') failed += 1;
  if (status === 'degraded') degraded += 1;

  const mark = { ok: '✅', degraded: '⚠️', fail: '❌' }[status];
  say(`\n### ${mark} ${label} — ${items.length}건 추출${status === 'degraded' ? ' (일부 필드 누락)' : ''}`);
  say(`- 페이지 제목: \`${info.title}\``);
  say(`- 본문 길이: ${info.bodyChars}자`);
  if (info.blocked) say('- ⚠️ **네이버가 자동화 차단 페이지를 내려보냈습니다.**');
  if (info.noResults) say('- ⚠️ 네이버가 "검색결과 없음"을 반환했습니다 (키워드 문제일 수 있습니다).');
  if (info.bodyChars < 500) say('- ⚠️ 본문이 거의 비어 있습니다. 페이지가 제대로 열리지 않았을 수 있습니다.');

  say('');
  say('| 카드 선택자 | 매칭 수 |');
  say('|---|---|');
  for (const [selector, count] of Object.entries(info.cardCounts)) {
    say(`| \`${selector}\` | ${count} |`);
  }
  say(`| (폴백 링크 \`${selectors.fallbackLink}\`) | ${info.fallbackLinks} |`);

  if (!matched.length) say('\n⚠️ **알려진 카드 선택자가 하나도 걸리지 않았습니다.**');

  if (emptyFields.length) {
    say(`\n⚠️ 모든 항목에서 비어 있는 필드: **${emptyFields.join(', ')}** — 해당 선택자가 낡았습니다.`);
  }

  if (items.length) {
    say('\n추출 결과 (상위 3건):');
    say('```');
    for (const item of items.slice(0, 3)) {
      say(`제목  ${item.title.slice(0, 60)}`);
      say(`출처  ${item.press || item.author || '(없음)'}   날짜  ${item.date || '(없음)'}`);
      say(`요약  ${(item.summary || '(없음)').slice(0, 70)}`);
      say(`링크  ${item.link.slice(0, 80)}`);
      say('');
    }
    say('```');
  }

  // 정상일 때는 구조를 덤프하지 않는다. 하지만 0건이든, 제목만 건졌든, 카드 선택자가
  // 안 걸렸든 — 고칠 거리가 있으면 반드시 덤프해야 붙여 넣기만으로 수정할 수 있다.
  if (status !== 'ok') {
    const chains = await page.evaluate(anchorChains, { linkPattern: selectors.fallbackLink.split(',')[0].replace(/a\[href\*="|"\]/g, ''), limit: 3 });
    if (chains.length) {
      say('\n실제 기사 링크의 조상 사슬 (← 여기서 카드 선택자를 읽어 낼 수 있습니다):');
      say('```');
      for (const entry of chains) {
        say(`"${entry.title}"`);
        entry.chain.forEach((sig, depth) => say(`${'  '.repeat(depth)}${sig}`));
        say('');
      }
      say('```');
    }

    const skeleton = await page.evaluate(domSkeleton, { maxDepth: 6, maxLines: 80 });
    say('\n결과 영역 DOM 골격:');
    say('```');
    skeleton.forEach((line) => say(line));
    say('```');
  }

  return items.length;
}

// ── 실행 ───────────────────────────────────────────────────────────────────
// 리포트만 보고도 어느 버전이 낸 결과인지 알 수 있어야 한다.
// 코드를 갱신하지 않고 다시 돌린 결과를 새 결과로 착각하면 엉뚱한 곳을 파게 된다.
const version = createRequire(import.meta.url)('../package.json').version;

say(`# 네이버 검색 파서 진단 리포트`);
say(`\n- 생성: ${new Date().toISOString()}`);
say(`- 코드 버전: **v${version}**  (\`npm run update\` 로 최신으로 맞출 수 있습니다)`);
say(`- Node: ${process.version} · ${process.platform}`);

await withScraper(async (context) => {
  const page = await context.newPage();

  for (const file of fromFiles) {
    const kind = kindOf(file);
    const target = path.resolve(file);
    say(`\n${'─'.repeat(64)}`);
    say(`\n## ${kind === 'news' ? '뉴스' : '블로그'} · 저장된 파일 \`${path.relative(ROOT, target)}\``);
    try {
      const html = fs.readFileSync(target, 'utf8');
      // 저장된 HTML 의 상대 경로 링크가 검색 결과 기준으로 풀리도록 실제 주소로 띄운다.
      const url = 'https://search.naver.com/search.naver?query=replay';
      await page.route('**/*', (route) =>
        route.request().resourceType() === 'document'
          ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: html })
          : route.abort(),
      );
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await inspect(page, { kind, label: path.basename(target) });
      await page.unroute('**/*');
    } catch (err) {
      failed += 1;
      say(`\n❌ 파일을 읽지 못했습니다: ${err.message}`);
    }
  }

  if (keywords.length) {
    if (save) fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    // 검색 결과 판독에 이미지·폰트는 필요 없다.
    await page.route('**/*', (route) =>
      ['image', 'media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue(),
    );
  }

  for (const keyword of keywords) {
    for (const [kind, url] of [
      ['news', NEWS_URL(keyword)],
      ['blog', BLOG_URL(keyword)],
    ]) {
      say(`\n${'─'.repeat(64)}`);
      say(`\n## ${kind === 'news' ? '뉴스' : '블로그'} · "${keyword}"`);
      say(`\n${url}`);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await page.waitForTimeout(2000);
        await inspect(page, { kind, label: `${kind} / ${keyword}` });

        if (save) {
          const file = path.join(FIXTURE_DIR, `${kind}-${slug(keyword)}.html`);
          fs.writeFileSync(file, await page.content());
          say(`\n💾 저장: \`${path.relative(ROOT, file)}\``);
        }
      } catch (err) {
        checked += 1;
        failed += 1;
        navErrors += 1;
        say(`\n### ❌ ${kind} / ${keyword} — 페이지를 열지 못했습니다`);
        say(`\n\`${err.message.split('\n')[0]}\``);
      }
    }
  }

  await page.close().catch(() => {});
});

// ── 마무리 ─────────────────────────────────────────────────────────────────
say(`\n${'─'.repeat(64)}`);
if (navErrors === checked && navErrors > 0) {
  say(`\n## 결론: 네트워크 문제`);
  say(`\n${navErrors}개 페이지를 아예 열지 못했습니다. 파서가 아니라 인터넷 연결·프록시 문제입니다.`);
} else if (failed || degraded) {
  const parts = [];
  if (failed) parts.push(`${failed}개 실패(0건)`);
  if (degraded) parts.push(`${degraded}개 부분 성공(필드 누락)`);
  say(`\n## 결론: ${checked}개 중 ${parts.join(', ')}`);
  say('\n위의 **조상 사슬**과 **DOM 골격**을 보고 `server/naver/selectors.js` 의 `SEARCH` 를 고치세요.');
  say('고친 뒤 `npm test` 로 저장된 픽스처에 대해 바로 재검증할 수 있습니다.');
} else {
  say(`\n## 결론: ${checked}개 모두 정상`);
  say('\n파서가 실제 네이버 HTML 에서 제목·요약·출처·날짜를 모두 뽑았습니다.');
  if (save) say('저장된 HTML 은 이제 `npm test` 의 회귀 테스트로 쓰입니다.');
}

fs.writeFileSync(REPORT_FILE, report.join('\n') + '\n');
console.log(`\n📄 리포트를 저장했습니다: ${path.relative(process.cwd(), REPORT_FILE)}`);
console.log('   문제가 있다면 이 파일 내용을 그대로 복사해서 알려 주시면 선택자를 고쳐 드립니다.\n');

process.exit(failed || degraded ? 1 : 0);
