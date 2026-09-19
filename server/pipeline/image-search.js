import { logger } from '../util/logger.js';

const TIMEOUT = 20_000;

async function getJson(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'naver-blog-automation/1.0 (personal blog tool)', ...headers },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Openverse — 별도 키 없이 CC 라이선스 이미지를 검색할 수 있다. */
async function searchOpenverse(query, limit) {
  const url =
    'https://api.openverse.org/v1/images/?' +
    new URLSearchParams({
      q: query,
      page_size: String(limit),
      license_type: 'commercial,modification',
      mature: 'false',
      // 블로그 본문에 넣을 것이므로 가로로 긴 사진이 잘 어울린다.
      aspect_ratio: 'wide',
    });
  const data = await getJson(url);
  return (data?.results || []).map((item) => ({
    url: item.url,
    thumbnail: item.thumbnail,
    title: item.title || '',
    provider: 'openverse',
    license: item.license ? `${item.license} ${item.license_version || ''}`.trim() : '',
    creator: item.creator || '',
    sourcePage: item.foreign_landing_url || item.url,
    width: item.width,
    height: item.height,
  }));
}

/** Wikimedia Commons — 공공/자유 라이선스 이미지, 키 불필요. */
async function searchWikimedia(query, limit) {
  const url =
    'https://commons.wikimedia.org/w/api.php?' +
    new URLSearchParams({
      action: 'query',
      format: 'json',
      generator: 'search',
      gsrsearch: `filetype:bitmap ${query}`,
      gsrnamespace: '6',
      gsrlimit: String(limit),
      prop: 'imageinfo',
      iiprop: 'url|size|extmetadata',
      iiurlwidth: '1200',
      origin: '*',
    });
  const data = await getJson(url);
  const pages = Object.values(data?.query?.pages || {});
  return pages
    .map((page) => {
      const info = page.imageinfo?.[0];
      if (!info) return null;
      const meta = info.extmetadata || {};
      return {
        url: info.thumburl || info.url,
        thumbnail: info.thumburl || info.url,
        title: page.title?.replace(/^File:/, '') || '',
        provider: 'wikimedia',
        license: meta.LicenseShortName?.value || '',
        creator: String(meta.Artist?.value || '').replace(/<[^>]+>/g, ''),
        sourcePage: info.descriptionurl,
        width: info.thumbwidth || info.width,
        height: info.thumbheight || info.height,
      };
    })
    .filter(Boolean);
}

async function searchUnsplash(query, limit, accessKey) {
  const url =
    'https://api.unsplash.com/search/photos?' +
    new URLSearchParams({ query, per_page: String(limit), orientation: 'landscape' });
  const data = await getJson(url, { Authorization: `Client-ID ${accessKey}` });
  return (data?.results || []).map((item) => ({
    url: item.urls?.regular,
    thumbnail: item.urls?.small,
    title: item.description || item.alt_description || '',
    provider: 'unsplash',
    license: 'Unsplash License',
    creator: item.user?.name || '',
    sourcePage: item.links?.html,
    width: item.width,
    height: item.height,
  }));
}

async function searchPexels(query, limit, apiKey) {
  const url =
    'https://api.pexels.com/v1/search?' +
    new URLSearchParams({ query, per_page: String(limit), orientation: 'landscape' });
  const data = await getJson(url, { Authorization: apiKey });
  return (data?.photos || []).map((item) => ({
    url: item.src?.large,
    thumbnail: item.src?.medium,
    title: item.alt || '',
    provider: 'pexels',
    license: 'Pexels License',
    creator: item.photographer || '',
    sourcePage: item.url,
    width: item.width,
    height: item.height,
  }));
}

/**
 * Search every configured provider and return a de-duplicated candidate list.
 * A provider that errors out is logged and skipped — one bad key must not kill
 * the run.
 */
export async function searchImages(query, { limit = 5, sources = ['openverse', 'wikimedia'], keys = {} } = {}) {
  const tasks = [];
  for (const source of sources) {
    if (source === 'openverse') tasks.push(['openverse', searchOpenverse(query, limit)]);
    if (source === 'wikimedia') tasks.push(['wikimedia', searchWikimedia(query, limit)]);
    if (source === 'unsplash' && keys.unsplashAccessKey)
      tasks.push(['unsplash', searchUnsplash(query, limit, keys.unsplashAccessKey)]);
    if (source === 'pexels' && keys.pexelsApiKey) tasks.push(['pexels', searchPexels(query, limit, keys.pexelsApiKey)]);
  }

  const settled = await Promise.allSettled(tasks.map(([, promise]) => promise));
  const results = [];
  settled.forEach((outcome, index) => {
    const name = tasks[index][0];
    if (outcome.status === 'fulfilled') {
      results.push(...outcome.value.filter((item) => item.url));
    } else {
      logger.warn('images', `${name} 이미지 검색 실패: ${outcome.reason?.message || outcome.reason}`);
    }
  });

  const seen = new Set();
  return results
    .filter((item) => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    })
    // 너무 작은 이미지는 블로그 본문에서 흐릿하게 보인다.
    .filter((item) => !item.width || item.width >= 640)
    .slice(0, limit * 2);
}
