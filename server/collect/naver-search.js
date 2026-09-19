import { withScraper } from '../browser.js';
import { logger } from '../util/logger.js';
import { SEARCH } from '../naver/selectors.js';
import { extractBlogCards, extractNewsCards } from './extractors.js';

const SEARCH_URL = 'https://search.naver.com/search.naver';

function searchUrl(params) {
  const url = new URL(SEARCH_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
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

export const NEWS_URL = (keyword) =>
  searchUrl({ where: 'news', query: keyword, sm: 'tab_opt', sort: '1', pd: '4' });

export const BLOG_URL = (keyword) => searchUrl({ ssc: 'tab.blog.all', query: keyword, sm: 'tab_jum' });

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
        await page.goto(NEWS_URL(keyword), { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1200);
        const found = await page.evaluate(extractNewsCards, { selectors: SEARCH.news, max: newsPerKeyword });
        found.forEach((item) => news.push({ ...item, keyword, kind: 'news' }));
        logger.info('collect', `뉴스 "${keyword}": ${found.length}건 수집`);
        if (!found.length) logger.warn('collect', `뉴스 "${keyword}" 결과가 0건입니다. 네이버가 검색 결과 구조를 바꿨을 수 있습니다.`);
      } catch (err) {
        logger.warn('collect', `뉴스 "${keyword}" 수집 실패: ${err.message}`);
      }

      try {
        await page.goto(BLOG_URL(keyword), { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1200);
        const found = await page.evaluate(extractBlogCards, { selectors: SEARCH.blog, max: blogsPerKeyword });
        found.forEach((item) => blogs.push({ ...item, keyword, kind: 'blog' }));
        logger.info('collect', `블로그 "${keyword}": ${found.length}건 수집`);
        if (!found.length) logger.warn('collect', `블로그 "${keyword}" 결과가 0건입니다. 네이버가 검색 결과 구조를 바꿨을 수 있습니다.`);
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
