import fs from 'node:fs';
import path from 'node:path';
import { withProfile } from '../browser.js';
import { logger, emitEvent } from '../util/logger.js';
import { IMAGE_DIR, LOG_DIR, safeJoin } from '../util/paths.js';
import { drafts, publications, newId, settings } from '../store.js';
import { getLoginStatus } from './session.js';
import { SEL, firstPresent, firstVisible } from './selectors.js';
import { buildSegments } from './format.js';

const WRITE_URL = (blogId) => `https://blog.naver.com/${blogId}?Redirect=Write&`;

/** Save a screenshot next to the logs so failures can be diagnosed later. */
async function snapshot(page, name) {
  try {
    const file = path.join(LOG_DIR, `${name}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: false });
    logger.info('publish', `화면을 저장했습니다: ${path.basename(file)}`);
    return file;
  } catch {
    return null;
  }
}

/** Close the "restore unsaved post" and help popups that block the editor. */
async function dismissPopups(frame) {
  for (const selector of SEL.dismissables) {
    try {
      const locator = frame.locator(selector).first();
      if (await locator.isVisible({ timeout: 800 })) {
        await locator.click({ timeout: 2000 }).catch(() => {});
        await frame.waitForTimeout(400);
        logger.debug('publish', `팝업을 닫았습니다: ${selector}`);
      }
    } catch {
      // 해당 팝업이 없으면 그냥 넘어간다.
    }
  }
}

/** Resolve the editor document — it lives inside the #mainFrame iframe. */
async function getEditorFrame(page) {
  await page.waitForTimeout(1500);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const frame =
      page.frames().find((f) => f.name() === 'mainFrame') ||
      page.frames().find((f) => /postwrite|PostWriteForm/i.test(f.url()));
    if (frame) {
      const hasEditor = await frame
        .locator('.se-main-container, .se-content, .se-section-documentTitle')
        .first()
        .waitFor({ state: 'attached', timeout: 3000 })
        .then(() => true)
        .catch(() => false);
      if (hasEditor) return frame;
    }
    // iframe 없이 에디터가 최상위에 바로 렌더링되는 경우도 있다.
    const topHasEditor = await page
      .locator('.se-main-container')
      .first()
      .isVisible({ timeout: 500 })
      .catch(() => false);
    if (topHasEditor) return page.mainFrame();

    await page.waitForTimeout(1000);
  }
  throw new Error('스마트에디터를 찾지 못했습니다. 네이버 블로그 글쓰기 화면이 열렸는지 확인해 주세요.');
}

/** Click into an editable region and put the caret at the very end. */
async function focusEditable(frame, candidates) {
  const target = await firstVisible(frame, candidates, { timeout: 8000 });
  if (!target) throw new Error('에디터 입력 영역을 찾지 못했습니다.');
  await target.click({ timeout: 8000 });
  await frame.waitForTimeout(250);
  return target;
}

/**
 * 스마트에디터는 붙여넣기로 들어온 HTML 을 자기 컴포넌트(소제목/인용구/목록)로
 * 바꿔 준다. 합성 paste 이벤트를 만들어 서식이 살아 있는 본문을 한 번에 넣는다.
 */
async function pasteHtml(frame, html, plain) {
  return frame.evaluate(
    ({ html, plain }) => {
      const selection = window.getSelection();
      const anchor = selection?.anchorNode;
      const host =
        (anchor?.nodeType === 1 ? anchor : anchor?.parentElement)?.closest('[contenteditable="true"]') ||
        document.querySelector('.se-main-container [contenteditable="true"]') ||
        document.querySelector('[contenteditable="true"]');
      if (!host) return false;

      const transfer = new DataTransfer();
      transfer.setData('text/html', html);
      transfer.setData('text/plain', plain);

      const event = new ClipboardEvent('paste', {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      });
      host.dispatchEvent(event);
      return !event.defaultPrevented ? 'not-handled' : true;
    },
    { html, plain },
  );
}

/** How much text is currently in the editor body? Used to verify insertions. */
async function bodyLength(frame) {
  return frame
    .evaluate(() => {
      const el = document.querySelector('.se-main-container');
      return el ? el.innerText.replace(/\s+/g, '').length : 0;
    })
    .catch(() => 0);
}

/** Fallback path: type the text in, line by line. Slow but very reliable. */
async function typePlain(frame, page, plain) {
  const lines = plain.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]) await page.keyboard.type(lines[i], { delay: 4 });
    if (i < lines.length - 1) {
      await page.keyboard.press('Enter');
      await frame.waitForTimeout(40);
    }
  }
}

/** Upload one local image through the editor's 사진 button. */
async function insertImage(frame, page, imageDir, block) {
  const file = path.join(imageDir, block.file);
  if (!fs.existsSync(file)) {
    logger.warn('publish', `이미지 파일이 없어 건너뜁니다: ${block.file}`);
    return false;
  }

  // 1순위: 숨겨진 file input 에 직접 파일을 넣는다 (파일 대화상자를 아예 띄우지 않음).
  const input = await firstPresent(frame, SEL.imageFileInput, { timeout: 2000 });
  if (input) {
    try {
      await input.setInputFiles(file);
      await frame.waitForTimeout(2500);
      logger.debug('publish', `이미지 업로드 (input 직접): ${block.file}`);
      return true;
    } catch (err) {
      logger.debug('publish', `input 직접 주입 실패, 버튼 경로로 전환: ${err.message}`);
    }
  }

  // 2순위: 툴바 버튼을 눌러 파일 선택 대화상자를 가로챈다.
  const button = await firstVisible(frame, SEL.imageButton, { timeout: 4000 });
  if (!button) {
    logger.warn('publish', '이미지 추가 버튼을 찾지 못했습니다.');
    return false;
  }
  try {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 10_000 }),
      button.click({ timeout: 5000 }),
    ]);
    await chooser.setFiles(file);
    await frame.waitForTimeout(3000);
    logger.debug('publish', `이미지 업로드 (파일 선택): ${block.file}`);
    return true;
  } catch (err) {
    logger.warn('publish', `이미지 업로드 실패 (${block.file}): ${err.message}`);
    return false;
  }
}

/** Type the caption line under a freshly inserted image. */
async function writeCaption(frame, page, caption) {
  if (!caption) return;
  try {
    const field = frame.locator('.se-caption .se-text-paragraph, .se-module-caption [contenteditable="true"]').last();
    if (await field.isVisible({ timeout: 2000 })) {
      await field.click({ timeout: 2000 });
      await page.keyboard.type(caption, { delay: 6 });
      await frame.waitForTimeout(200);
      // 캡션에서 빠져나와 본문 끝으로 커서를 되돌린다.
      await page.keyboard.press('Escape');
    }
  } catch {
    // 캡션은 부가 요소라 실패해도 발행을 막지 않는다.
  }
}

/** Fill in the publish layer: category, tags, visibility, then confirm. */
async function completePublishLayer(page, frame, { category, tags, visibility }) {
  const scope = (await firstVisible(page, SEL.publishLayer, { timeout: 6000 })) ? page : frame;

  if (category) {
    try {
      const toggle = await firstVisible(scope, SEL.categoryToggle, { timeout: 3000 });
      if (toggle) {
        await toggle.click();
        await page.waitForTimeout(600);
        const option = scope.locator(`text="${category}"`).first();
        if (await option.isVisible({ timeout: 2500 })) {
          await option.click();
          logger.info('publish', `카테고리 설정: ${category}`);
        } else {
          logger.warn('publish', `카테고리 "${category}" 를 찾지 못해 기본값으로 둡니다.`);
          await page.keyboard.press('Escape');
        }
        await page.waitForTimeout(400);
      }
    } catch (err) {
      logger.warn('publish', `카테고리 설정 실패: ${err.message}`);
    }
  }

  if (visibility && visibility !== 'public') {
    const label = visibility === 'private' ? '비공개' : '이웃공개';
    try {
      const option = scope.locator(`label:has-text("${label}"), span:has-text("${label}")`).first();
      if (await option.isVisible({ timeout: 2500 })) {
        await option.click();
        logger.info('publish', `공개 범위: ${label}`);
      }
    } catch {
      logger.warn('publish', `공개 범위(${label}) 설정에 실패해 기본값으로 둡니다.`);
    }
  }

  if (tags?.length) {
    try {
      const input = await firstVisible(scope, SEL.tagInput, { timeout: 3000 });
      if (input) {
        await input.click();
        for (const tag of tags.slice(0, 10)) {
          await page.keyboard.type(tag, { delay: 15 });
          await page.keyboard.press('Enter');
          await page.waitForTimeout(150);
        }
        logger.info('publish', `태그 ${tags.length}개 입력`);
      }
    } catch (err) {
      logger.warn('publish', `태그 입력 실패: ${err.message}`);
    }
  }

  const confirm =
    (await firstVisible(scope, SEL.publishConfirm, { timeout: 5000 })) ||
    (await firstVisible(scope, ['button:has-text("발행")'], { timeout: 3000 }));
  if (!confirm) throw new Error('발행 확인 버튼을 찾지 못했습니다.');

  await confirm.click();
  logger.info('publish', '발행 버튼을 눌렀습니다. 게시글이 올라가기를 기다립니다…');
}

/**
 * 에디터를 실제로 조작하는 핵심 루틴: 제목·본문·이미지를 채우고 발행까지 한다.
 * 브라우저 페이지를 주입받으므로 모의 에디터로도 그대로 검증할 수 있다.
 * (test/publish.test.js 참고)
 */
export async function composeAndPublish(page, {
  draft,
  draftId,
  blogId,
  writeUrl,
  dryRun = false,
  category = '',
  visibility = 'public',
  imageDir,
  onProgress = () => {},
}) {
  const segments = buildSegments(draft.blocks);
  let result;

  try {
    onProgress({ step: 'open', message: '네이버 블로그 글쓰기 화면을 여는 중…' });
    await page.goto(writeUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    const frame = await getEditorFrame(page);
    await dismissPopups(frame);
    await dismissPopups(page);

    onProgress({ step: 'title', message: '제목을 입력하는 중…' });
    await focusEditable(frame, SEL.title);
    await page.keyboard.type(draft.title, { delay: 12 });
    await frame.waitForTimeout(500);

    onProgress({ step: 'body', message: '본문을 작성하는 중…' });
    await focusEditable(frame, SEL.body);

    let usedFallback = false;
    let imagesInserted = 0;

    for (const [index, segment] of segments.entries()) {
      onProgress({
        step: 'body',
        message: `본문 작성 중 (${index + 1}/${segments.length})…`,
        progress: index / segments.length,
      });

      if (segment.kind === 'image') {
        if (await insertImage(frame, page, imageDir, segment.block)) {
          imagesInserted += 1;
          await writeCaption(frame, page, segment.block.caption);
        }
        // 이미지 뒤에 새 문단을 만들어 다음 텍스트가 캡션에 붙지 않게 한다.
        await page.keyboard.press('End');
        await page.keyboard.press('Enter');
        await frame.waitForTimeout(300);
        continue;
      }

      const before = await bodyLength(frame);
      let pasted = false;
      if (!usedFallback) {
        pasted = await pasteHtml(frame, segment.html, segment.plain).catch(() => false);
        await frame.waitForTimeout(700);
      }

      const after = await bodyLength(frame);
      const grewEnough = after - before >= Math.max(20, segment.plain.replace(/\s+/g, '').length * 0.5);

      if (!pasted || pasted === 'not-handled' || !grewEnough) {
        if (!usedFallback) {
          logger.warn('publish', '서식 붙여넣기가 적용되지 않아 직접 입력 방식으로 전환합니다.');
          usedFallback = true;
        }
        await typePlain(frame, page, segment.plain);
      }

      await page.keyboard.press('Enter');
      await frame.waitForTimeout(200);
    }

    const finalLength = await bodyLength(frame);
    if (finalLength < 100) {
      await snapshot(page, 'body-empty');
      throw new Error('본문이 에디터에 제대로 입력되지 않았습니다. 네이버 에디터 구조가 바뀌었을 수 있습니다.');
    }
    logger.ok('publish', `본문 입력 완료 (${finalLength}자, 이미지 ${imagesInserted}장${usedFallback ? ', 서식 단순화됨' : ''})`);

    if (dryRun) {
      const shot = await snapshot(page, 'dry-run');
      logger.ok('publish', '연습 모드: 발행하지 않고 에디터에 글만 채워 두었습니다.');
      result = { published: false, dryRun: true, screenshot: shot ? path.basename(shot) : null, imagesInserted };
    } else {
      onProgress({ step: 'publish', message: '발행 설정을 적용하는 중…' });
      const openButton =
        (await firstVisible(frame, SEL.publishOpen, { timeout: 4000 })) ||
        (await firstVisible(page, SEL.publishOpen, { timeout: 4000 }));
      if (!openButton) {
        await snapshot(page, 'no-publish-button');
        throw new Error('발행 버튼을 찾지 못했습니다.');
      }
      await openButton.click();
      await page.waitForTimeout(1200);

      await completePublishLayer(page, frame, { category, tags: draft.tags, visibility });

      onProgress({ step: 'publish', message: '발행 결과를 확인하는 중…' });
      const url = await waitForPublished(page, blogId);
      const shot = await snapshot(page, 'published');
      result = {
        published: true,
        url,
        screenshot: shot ? path.basename(shot) : null,
        imagesInserted,
        formatting: usedFallback ? 'plain' : 'rich',
      };
      logger.ok('publish', `발행 완료! ${url || '(URL 확인 실패)'}`);
    }
  } catch (err) {
    await snapshot(page, 'publish-error');
    throw err;
  }

  return result;
}

/**
 * 초안 하나를 네이버 블로그에 실제로 발행한다.
 *
 * @param {object} opts
 * @param {string} opts.draftId
 * @param {boolean} [opts.dryRun]  true 면 에디터에 글만 채우고 발행은 하지 않는다.
 */
export async function publishDraft({ draftId, dryRun = false, onProgress = () => {} } = {}) {
  const config = settings.get();
  const draft = drafts.find(draftId);
  if (!draft) throw new Error('초안을 찾을 수 없습니다.');

  const status = await getLoginStatus();
  const blogId = config.blogId || status.blogId;
  if (!status.loggedIn) throw new Error('네이버에 로그인되어 있지 않습니다. 대시보드에서 먼저 로그인해 주세요.');
  if (!blogId) throw new Error('블로그 아이디를 알 수 없습니다. 설정에서 블로그 아이디를 입력해 주세요.');

  logger.info('publish', `발행 시작: "${draft.title}" (블록 ${draft.blocks.length}개${dryRun ? ', 연습 모드' : ''})`);
  drafts.update(draftId, { status: 'publishing' });

  return withProfile(
    async (context) => {
      const page = context.pages()[0] || (await context.newPage());
      let result;
      try {
        result = await composeAndPublish(page, {
          draft,
          draftId,
          blogId,
          writeUrl: WRITE_URL(blogId),
          dryRun,
          category: draft.category ?? config.defaultCategory,
          visibility: draft.visibility ?? config.defaultVisibility,
          imageDir: safeJoin(IMAGE_DIR, draftId),
          onProgress,
        });
      } catch (err) {
        drafts.update(draftId, { status: 'failed', lastError: err.message });
        emitEvent('publish:failed', { draftId, error: err.message });
        throw err;
      }

      const record = publications.insert({
        id: newId('pub'),
        draftId,
        title: draft.title,
        blogId,
        url: result.url || null,
        dryRun: Boolean(result.dryRun),
        imagesInserted: result.imagesInserted,
        screenshot: result.screenshot,
        createdAt: new Date().toISOString(),
      });
      publications.trim(200);

      drafts.update(draftId, {
        status: result.published ? 'published' : 'ready',
        publishedUrl: result.url || null,
        publishedAt: result.published ? new Date().toISOString() : null,
        lastError: null,
      });

      emitEvent('publish:done', { draftId, ...result });
      return { ...result, publicationId: record.id };
    },
    { headless: config.headless, slowMo: config.slowMo },
  );
}

/**
 * Wait for the published post to appear and read back its URL.
 *
 * 발행 후 실제로 이동하는 것은 대개 최상위 창이 아니라 에디터가 들어 있던
 * mainFrame 이다. 그래서 최상위 URL 만 보면 영영 못 찾는다 — 모든 프레임과
 * 새로 열린 탭까지 함께 살펴야 한다.
 */
async function waitForPublished(page, blogId) {
  const pattern = new RegExp(`blog\\.naver\\.com/(${blogId}|PostView)`, 'i');
  const isPost = (url) => pattern.test(url) && !/postwrite|PostWriteForm/i.test(url);

  const toPostUrl = (url) => {
    const logNo = url.match(/logNo=(\d+)/)?.[1] || url.match(/blog\.naver\.com\/[^/]+\/(\d+)/)?.[1];
    return logNo ? `https://blog.naver.com/${blogId}/${logNo}` : url;
  };

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await page.waitForTimeout(1000);

    const candidates = [
      page.url(),
      ...page.frames().map((frame) => frame.url()),
      ...page.context().pages().filter((other) => other !== page).map((other) => other.url()),
    ];
    const hit = candidates.find(isPost);
    if (hit) return toPostUrl(hit);
  }

  logger.warn('publish', '발행은 되었지만 게시글 URL 을 확인하지 못했습니다.');
  return null;
}
