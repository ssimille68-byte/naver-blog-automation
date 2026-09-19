/**
 * 발행 자동화 통합 테스트.
 *
 * 실제 네이버에 접속하지 않고, 스마트에디터 ONE 의 핵심 거동을 흉내 낸
 * 로컬 모의 페이지(test/fixtures)를 상대로 composeAndPublish() 를 돌린다.
 * 검증 대상: iframe 탐지 · 팝업 닫기 · 제목/본문 입력 · 서식 붙여넣기 ·
 *            이미지 업로드 · 캡션 · 발행 레이어(카테고리/공개범위/태그) · URL 회수
 *
 * 실행: npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { startMockNaver } from './mock-server.js';
import { composeAndPublish } from '../server/naver/publisher.js';
import { buildSegments, renderPreviewHtml, renderPreviewText } from '../server/naver/format.js';
import { extractJson } from '../server/ai/claude-cli.js';
import { safeJoin } from '../server/util/paths.js';

const PORT = 4399;

const DRAFT = {
  title: '테스트 제목: 자동 발행 점검',
  tags: ['자동화', '테스트', '블로그'],
  blocks: [
    { type: 'paragraph', text: '요즘 블로그에 글 올릴 시간을 내기가 참 어렵습니다. 그래서 자동화를 붙여 봤습니다.' },
    { type: 'heading', text: '무엇을 자동화했나' },
    { type: 'paragraph', text: '글감 수집부터 발행까지 한 번에 이어지도록 만들었습니다. 사람이 하는 일은 검토뿐입니다.' },
    { type: 'list', ordered: false, items: ['뉴스와 인기 글 수집', 'AI 초안 작성', '이미지 선별과 검증'] },
    { type: 'image', query: 'test image', caption: '테스트용 이미지입니다', status: 'ready', file: 'sample.png' },
    { type: 'heading', text: '직접 써 보니' },
    { type: 'paragraph', text: '완전히 손을 떼기보다는, 초안을 빠르게 만들어 주는 도구로 쓰는 편이 결과가 좋았습니다.' },
    { type: 'quote', text: '참고: 네이버 뉴스, 인기 블로그 글' },
    { type: 'divider' },
  ],
};

/** A tiny but valid PNG so the file-upload path has something real to send. */
function writeSamplePng(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=',
    'base64',
  );
  const file = path.join(dir, 'sample.png');
  fs.writeFileSync(file, png);
  return file;
}

test('format: 블록이 이미지 기준으로 조각나고 서식 HTML 이 만들어진다', () => {
  const segments = buildSegments(DRAFT.blocks);
  assert.equal(segments.filter((s) => s.kind === 'image').length, 1);
  assert.ok(segments.length >= 3, '이미지 앞뒤로 텍스트 조각이 나뉘어야 한다');

  const html = segments.find((s) => s.kind === 'html').html;
  assert.match(html, /<p style=/);
  assert.ok(html.includes('<h3'), '소제목은 h3 으로 나가야 한다');

  const withList = segments.map((s) => s.html || '').join('');
  assert.ok(withList.includes('<ul>') && withList.includes('<li'), '목록이 유지되어야 한다');
  assert.ok(withList.includes('<blockquote'), '인용구가 유지되어야 한다');
  assert.ok(withList.includes('<hr>'), '구분선이 유지되어야 한다');
});

test('format: 준비되지 않은 이미지는 본문에서 조용히 빠진다', () => {
  const blocks = [...DRAFT.blocks, { type: 'image', query: 'x', status: 'rejected', error: '점수 미달' }];
  const segments = buildSegments(blocks);
  assert.equal(segments.filter((s) => s.kind === 'image').length, 1, '거절된 이미지는 삽입하지 않는다');

  const preview = renderPreviewHtml(blocks, (block) => `/img/${block.file}`);
  assert.match(preview, /이미지를 넣지 못했습니다/, '미리보기에는 실패 사실을 표시한다');
  assert.match(renderPreviewText(blocks), /이미지 없음/);
});

test('format: HTML 특수문자가 이스케이프된다', () => {
  const [segment] = buildSegments([{ type: 'paragraph', text: '<script>alert("x")</script> & 그 외' }]);
  assert.ok(!segment.html.includes('<script>'), '원본 태그가 살아 있으면 안 된다');
  assert.match(segment.html, /&lt;script&gt;/);
  assert.match(segment.html, /&amp;/);
});

test('ai: 코드펜스·설명문이 섞인 응답에서 JSON 을 뽑아낸다', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('알겠습니다.\n{"b":[1,2]}\n이상입니다.'), { b: [1, 2] });
  assert.deepEqual(extractJson('[{"c":true}]'), [{ c: true }]);
  assert.throws(() => extractJson('JSON 이 전혀 없는 문장'));
});

test('paths: 경로 탈출 시도를 막는다', () => {
  const base = os.tmpdir();
  assert.throws(() => safeJoin(base, '..', 'etc', 'passwd'));
  assert.throws(() => safeJoin(base, 'draft', '../../secret'));
  assert.ok(safeJoin(base, 'draft_1', 'a.png').startsWith(base));
});

test('publish: 모의 스마트에디터에 제목·본문·이미지를 넣고 발행까지 마친다', { timeout: 120_000 }, async (t) => {
  const imageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-test-'));
  writeSamplePng(imageDir);

  const { server, url } = await startMockNaver(PORT);
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  t.after(async () => {
    await browser.close().catch(() => {});
    server.close();
    fs.rmSync(imageDir, { recursive: true, force: true });
  });

  const context = await browser.newContext({ locale: 'ko-KR', viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const steps = [];
  const result = await composeAndPublish(page, {
    draft: DRAFT,
    draftId: 'draft_test',
    blogId: 'testblogger',
    writeUrl: url,
    category: 'IT·테크',
    visibility: 'neighbor',
    imageDir,
    onProgress: (update) => steps.push(update.step),
  });

  assert.equal(result.published, true, '발행이 완료되어야 한다');
  assert.equal(result.imagesInserted, 1, '이미지 1장이 업로드되어야 한다');
  assert.equal(result.formatting, 'rich', '서식 붙여넣기 경로를 탔어야 한다');
  assert.match(result.url, /testblogger\/223456789/, '게시글 URL 을 회수해야 한다');
  assert.ok(steps.includes('title') && steps.includes('body') && steps.includes('publish'));

  // 모의 에디터가 기록해 둔 실제 입력 결과를 확인한다.
  const mock = JSON.parse(await page.evaluate(() => sessionStorage.getItem('mockResult')));
  assert.equal(mock.title, DRAFT.title, '제목이 그대로 입력되어야 한다');
  assert.equal(mock.category, 'IT·테크', '카테고리가 선택되어야 한다');
  assert.equal(mock.visibility, 'neighbor', '공개 범위가 적용되어야 한다');
  assert.deepEqual(mock.tags, DRAFT.tags, '태그가 모두 입력되어야 한다');
  assert.equal(mock.images, 1);

  assert.ok(mock.bodyHtml.includes('<h3'), '소제목 서식이 에디터에 반영되어야 한다');
  assert.ok(mock.bodyHtml.includes('<li'), '목록 서식이 반영되어야 한다');
  assert.ok(mock.bodyHtml.includes('<blockquote'), '인용구 서식이 반영되어야 한다');
  assert.ok(mock.bodyHtml.includes('<figure'), '이미지가 본문에 들어가야 한다');
  assert.match(mock.bodyText, /글감 수집부터 발행까지/, '본문 문장이 그대로 들어가야 한다');
  assert.match(mock.bodyText, /테스트용 이미지입니다/, '이미지 캡션이 입력되어야 한다');
});

test('publish: 연습 모드에서는 발행 버튼을 누르지 않는다', { timeout: 120_000 }, async (t) => {
  const imageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-test-'));
  writeSamplePng(imageDir);

  const { server, url } = await startMockNaver(PORT + 1);
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  t.after(async () => {
    await browser.close().catch(() => {});
    server.close();
    fs.rmSync(imageDir, { recursive: true, force: true });
  });

  const page = await browser.newPage();
  const result = await composeAndPublish(page, {
    draft: DRAFT,
    draftId: 'draft_dry',
    blogId: 'testblogger',
    writeUrl: url,
    dryRun: true,
    imageDir,
  });

  assert.equal(result.published, false);
  assert.equal(result.dryRun, true);
  const published = await page.frames().find((f) => f.name() === 'mainFrame').evaluate(() => window.__mock.published);
  assert.equal(published, false, '연습 모드에서는 발행되지 않아야 한다');
});
