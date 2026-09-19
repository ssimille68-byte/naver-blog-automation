import { withScraper } from '../browser.js';
import { logger } from '../util/logger.js';

/**
 * Pull the readable body text out of a news article or blog post.
 * Naver blog posts live inside an iframe, so we follow it before extracting.
 */
async function extractOne(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(900);

  let target = page;
  if (/blog\.naver\.com/.test(url)) {
    const frame = page.frames().find((f) => f.name() === 'mainFrame' || /PostView/.test(f.url()));
    if (frame) target = frame;
  }

  return target.evaluate(() => {
    const clean = (t) => String(t || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

    const bodySelectors = [
      '#dic_area',
      '#newsct_article',
      '#articleBodyContents',
      '.newsct_article',
      '.se-main-container',
      '#postViewArea',
      '.post_ct',
      'article',
      '#content',
    ];
    const titleSelectors = [
      'h2#title_area',
      '.media_end_head_headline',
      '.se-title-text',
      '.pcol1',
      '.htitle',
      'h1',
      'title',
    ];

    let body = '';
    for (const selector of bodySelectors) {
      const el = document.querySelector(selector);
      if (el && clean(el.innerText).length > body.length) body = clean(el.innerText);
      if (body.length > 600) break;
    }
    if (body.length < 200) {
      // 본문 컨테이너를 못 찾으면 가장 글자 수가 많은 블록을 본문으로 본다.
      const blocks = Array.from(document.querySelectorAll('div, section, td'))
        .map((el) => ({ el, text: clean(el.innerText) }))
        .filter((entry) => entry.text.length > 300)
        .sort((a, b) => b.text.length - a.text.length);
      if (blocks[0]) body = blocks[0].text;
    }

    let title = '';
    for (const selector of titleSelectors) {
      const el = document.querySelector(selector);
      if (el) {
        title = clean(el.innerText || el.textContent);
        if (title) break;
      }
    }

    const images = Array.from(document.querySelectorAll('img'))
      .map((img) => img.getAttribute('data-lazy-src') || img.src)
      .filter((src) => src && /^https?:/.test(src) && !/icon|logo|blank|spacer|profile/i.test(src))
      .slice(0, 8);

    return { title, body: body.slice(0, 12_000), images };
  });
}

/** Fetch article bodies for a batch of links, skipping the ones that fail. */
export async function fetchArticles(items, { limit = 8, maxChars = 6000 } = {}) {
  const targets = items.slice(0, limit);
  if (!targets.length) return [];

  const results = [];
  await withScraper(async (context) => {
    const page = await context.newPage();
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(type)) return route.abort();
      return route.continue();
    });

    for (const item of targets) {
      try {
        const extracted = await extractOne(page, item.link);
        const body = extracted.body.slice(0, maxChars);
        if (body.length < 120) {
          logger.debug('collect', `본문이 너무 짧아 건너뜀: ${item.title}`);
          continue;
        }
        results.push({
          ...item,
          fullTitle: extracted.title || item.title,
          body,
          sourceImages: extracted.images,
        });
        logger.info('collect', `본문 확보 (${body.length}자): ${item.title.slice(0, 40)}`);
      } catch (err) {
        logger.warn('collect', `본문 수집 실패 (${item.title.slice(0, 30)}): ${err.message}`);
      }
    }
    await page.close().catch(() => {});
  });

  return results;
}
