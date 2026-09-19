import { withScraper } from '../browser.js';
import { logger } from '../util/logger.js';

const SEARCH = 'https://search.naver.com/search.naver';

function searchUrl(params) {
  const url = new URL(SEARCH);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function clean(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.link || item.title;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 네이버는 검색 결과 DOM 을 자주 바꾼다. 그래서 알려진 선택자를 먼저 시도하고,
 * 모두 실패하면 링크 패턴을 훑는 범용 추출기로 내려간다.
 */
async function extractNews(page, limit) {
  return page.evaluate((max) => {
    const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
    const out = [];

    const cardSelectors = [
      'div.sds-comps-base-layout.sds-comps-full-layout',
      'div.news_wrap.api_ani_send',
      'li.bx',
      'div.group_news > div',
    ];

    for (const selector of cardSelectors) {
      const cards = Array.from(document.querySelectorAll(selector));
      for (const card of cards) {
        const titleEl =
          card.querySelector('a.news_tit') ||
          card.querySelector('span.sds-comps-text-type-headline1')?.closest('a') ||
          card.querySelector('a[href*="n.news.naver.com"]') ||
          card.querySelector('a[href^="http"]');
        if (!titleEl) continue;

        const title = clean(titleEl.textContent);
        const link = titleEl.href;
        if (!title || title.length < 8 || !link) continue;

        const summaryEl =
          card.querySelector('div.news_dsc') ||
          card.querySelector('span.sds-comps-text-type-body1') ||
          card.querySelector('a.api_txt_lines.dsc_txt_wrap');
        const pressEl =
          card.querySelector('a.info.press') ||
          card.querySelector('span.sds-comps-profile-info-title-text') ||
          card.querySelector('.press');
        const dateEl = Array.from(card.querySelectorAll('span.info, span.sds-comps-profile-info-subtext')).find((el) =>
          /(전|앞|\d{4}\.)/.test(el.textContent),
        );

        out.push({
          title,
          link,
          summary: clean(summaryEl?.textContent).slice(0, 400),
          press: clean(pressEl?.textContent).replace(/언론사 선정$/, ''),
          date: clean(dateEl?.textContent),
        });
        if (out.length >= max) return out;
      }
      if (out.length) return out;
    }

    // 범용 폴백: 뉴스 도메인으로 향하는 링크를 그대로 긁는다.
    const anchors = Array.from(document.querySelectorAll('a[href*="n.news.naver.com"], a[href*="news.naver.com"]'));
    for (const anchor of anchors) {
      const title = clean(anchor.textContent);
      if (title.length < 12) continue;
      out.push({ title, link: anchor.href, summary: '', press: '', date: '' });
      if (out.length >= max) break;
    }
    return out;
  }, limit);
}

async function extractBlogs(page, limit) {
  return page.evaluate((max) => {
    const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
    const out = [];

    const cardSelectors = [
      'div.view_wrap',
      'li.bx._svp_item',
      'div.sds-comps-base-layout.sds-comps-full-layout',
      'li.bx',
    ];

    for (const selector of cardSelectors) {
      const cards = Array.from(document.querySelectorAll(selector));
      for (const card of cards) {
        const titleEl =
          card.querySelector('a.title_link') ||
          card.querySelector('a.api_txt_lines.total_tit') ||
          card.querySelector('span.sds-comps-text-type-headline1')?.closest('a') ||
          card.querySelector('a[href*="blog.naver.com"]');
        if (!titleEl) continue;

        const title = clean(titleEl.textContent);
        const link = titleEl.href;
        if (!title || title.length < 6 || !link || !/blog\.naver\.com|post\.naver\.com|tistory|brunch/.test(link)) continue;

        const summaryEl =
          card.querySelector('a.dsc_link') ||
          card.querySelector('div.api_txt_lines.dsc_txt') ||
          card.querySelector('span.sds-comps-text-type-body1');
        const authorEl =
          card.querySelector('a.name') ||
          card.querySelector('span.sds-comps-profile-info-title-text') ||
          card.querySelector('.user_info > a');
        const dateEl =
          card.querySelector('span.sub') ||
          card.querySelector('span.sds-comps-profile-info-subtext');

        out.push({
          title,
          link,
          summary: clean(summaryEl?.textContent).slice(0, 400),
          author: clean(authorEl?.textContent),
          date: clean(dateEl?.textContent),
        });
        if (out.length >= max) return out;
      }
      if (out.length) return out;
    }

    const anchors = Array.from(document.querySelectorAll('a[href*="blog.naver.com"]'));
    for (const anchor of anchors) {
      const title = clean(anchor.textContent);
      if (title.length < 8) continue;
      out.push({ title, link: anchor.href, summary: '', author: '', date: '' });
      if (out.length >= max) break;
    }
    return out;
  }, limit);
}

/**
 * Search Naver News and popular blog posts for a set of keywords.
 * Both tabs are scraped in one browser session to keep it fast.
 */
export async function searchNaver(keywords, { newsPerKeyword = 10, blogsPerKeyword = 10 } = {}) {
  const news = [];
  const blogs = [];

  await withScraper(async (context) => {
    const page = await context.newPage();
    // 검색 결과 스크래핑에 이미지/폰트는 필요 없다 — 차단해서 속도를 올린다.
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font'].includes(type)) return route.abort();
      return route.continue();
    });

    for (const keyword of keywords) {
      try {
        await page.goto(
          searchUrl({ where: 'news', query: keyword, sm: 'tab_opt', sort: '1', pd: '4' }),
          { waitUntil: 'domcontentloaded' },
        );
        await page.waitForTimeout(1200);
        const found = await extractNews(page, newsPerKeyword);
        found.forEach((item) => news.push({ ...item, keyword, kind: 'news' }));
        logger.info('collect', `뉴스 "${keyword}": ${found.length}건 수집`);
      } catch (err) {
        logger.warn('collect', `뉴스 "${keyword}" 수집 실패: ${err.message}`);
      }

      try {
        await page.goto(searchUrl({ ssc: 'tab.blog.all', query: keyword, sm: 'tab_jum' }), {
          waitUntil: 'domcontentloaded',
        });
        await page.waitForTimeout(1200);
        const found = await extractBlogs(page, blogsPerKeyword);
        found.forEach((item) => blogs.push({ ...item, keyword, kind: 'blog' }));
        logger.info('collect', `블로그 "${keyword}": ${found.length}건 수집`);
      } catch (err) {
        logger.warn('collect', `블로그 "${keyword}" 수집 실패: ${err.message}`);
      }
    }

    await page.close().catch(() => {});
  });

  return { news: dedupe(news), blogs: dedupe(blogs) };
}

/** Today's trending search terms, used to nudge topic ideas toward what's hot. */
export async function fetchTrendingKeywords(category = '') {
  try {
    return await withScraper(async (context) => {
      const page = await context.newPage();
      await page.goto(`https://datalab.naver.com/keyword/realtimeList.naver${category ? `?where=${category}` : ''}`, {
        waitUntil: 'domcontentloaded',
      });
      await page.waitForTimeout(1500);
      const items = await page.$$eval('.ranking_item .item_title, .item_title', (els) =>
        els.map((el) => el.textContent.trim()).filter(Boolean),
      );
      await page.close().catch(() => {});
      return items.slice(0, 20);
    });
  } catch (err) {
    // 급상승 검색어 서비스는 종료/변경이 잦다. 없으면 없는 대로 진행한다.
    logger.debug('collect', `실시간 검색어 수집 생략: ${err.message}`);
    return [];
  }
}
