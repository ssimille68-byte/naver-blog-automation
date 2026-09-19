import { askJson } from '../ai/claude-cli.js';
import { searchNaver, fetchTrendingKeywords } from '../collect/naver-search.js';
import { logger, emitEvent } from '../util/logger.js';
import { topics, newId, settings } from '../store.js';

const SYSTEM = `당신은 네이버 블로그 상위 노출을 오래 다뤄 온 한국어 콘텐츠 기획자입니다.
검색 수요가 있고, 실제로 사람들이 궁금해하며, 블로그 글 한 편으로 충분히 다룰 수 있는 주제를 고릅니다.
근거 없는 추측이나 과장된 표현은 쓰지 않습니다.`;

/** Turn a broad interest into concrete search keywords. */
export async function expandKeywords(interest, { model = 'sonnet', count = 5 } = {}) {
  const prompt = `관심 분야: "${interest}"

이 분야에서 지금 네이버에 검색했을 때 최신 뉴스와 인기 블로그 글이 잘 나올 만한
구체적인 검색 키워드를 ${count}개 만들어 주세요.

조건:
- 너무 광범위한 한 단어("경제")보다 검색 의도가 분명한 2~4어절 키워드
- 서로 다른 각도를 다룰 것 (트렌드 / 제품·서비스 / 방법·노하우 / 비교 / 이슈)
- 한국어로, 실제 사람들이 검색창에 칠 법한 표현으로

스키마: {"keywords": ["키워드1", "키워드2", ...]}`;

  const result = await askJson(prompt, { system: SYSTEM, model, label: 'expand-keywords' });
  const keywords = Array.isArray(result?.keywords) ? result.keywords.filter(Boolean) : [];
  return keywords.length ? keywords.slice(0, count) : [interest];
}

function formatSources(news, blogs) {
  const lines = [];
  lines.push('## 최신 뉴스');
  news.forEach((item, index) => {
    lines.push(
      `[N${index + 1}] ${item.title}\n  언론사: ${item.press || '미상'} | 날짜: ${item.date || '미상'} | 키워드: ${item.keyword}\n  요약: ${item.summary || '(없음)'}`,
    );
  });
  lines.push('\n## 인기 블로그 글');
  blogs.forEach((item, index) => {
    lines.push(
      `[B${index + 1}] ${item.title}\n  작성자: ${item.author || '미상'} | 날짜: ${item.date || '미상'} | 키워드: ${item.keyword}\n  요약: ${item.summary || '(없음)'}`,
    );
  });
  return lines.join('\n');
}

/**
 * 관심 분야 → 키워드 확장 → 뉴스/블로그 수집 → AI 가 글감 후보를 뽑는 전체 흐름.
 */
export async function discoverTopics({ interest, onProgress = () => {} } = {}) {
  const config = settings.get();
  const model = config.model;

  onProgress({ step: 'keywords', message: '관심 분야를 검색 키워드로 확장하는 중…' });
  const keywords = await expandKeywords(interest, { model, count: 5 });
  logger.info('topics', `검색 키워드: ${keywords.join(', ')}`);

  onProgress({ step: 'collect', message: `네이버 뉴스·블로그 수집 중 (키워드 ${keywords.length}개)…` });
  const [{ news, blogs }, trending] = await Promise.all([
    searchNaver(keywords, {
      newsPerKeyword: config.newsPerKeyword,
      blogsPerKeyword: config.blogsPerKeyword,
    }),
    fetchTrendingKeywords(),
  ]);

  if (!news.length && !blogs.length) {
    throw new Error(
      '네이버에서 수집된 자료가 없습니다. 네트워크 상태를 확인하거나 관심 분야를 조금 더 일반적인 표현으로 바꿔 보세요.',
    );
  }
  logger.ok('topics', `수집 완료: 뉴스 ${news.length}건 / 블로그 ${blogs.length}건`);

  onProgress({ step: 'analyze', message: 'AI 가 글감 후보를 분석하는 중…' });

  const prompt = `관심 분야: "${interest}"
검색에 사용한 키워드: ${keywords.join(', ')}
${trending.length ? `오늘의 실시간 인기 검색어(참고용): ${trending.slice(0, 10).join(', ')}` : ''}

아래는 방금 네이버에서 수집한 실제 자료입니다.

${formatSources(news, blogs)}

위 자료를 바탕으로 블로그 글감 ${config.topicCount}개를 제안해 주세요.

각 글감마다:
- title: 네이버 검색과 클릭을 동시에 노리는 제목 (25~45자, 낚시성 금지)
- angle: 이 글이 다른 글과 어떻게 다른지 한 문장
- summary: 어떤 내용을 담을지 2~3문장
- keywords: 이 글이 노릴 검색 키워드 3~5개
- sources: 근거로 쓸 자료 번호 배열 (예: ["N1","B3"]). 반드시 위 목록에 있는 번호만.
- score: 0~100. 검색 수요 + 시의성 + 블로그 글로서의 적합성을 종합한 점수
- reason: 그 점수를 준 이유 한 문장

주의:
- 수집된 자료에 실제로 근거가 있는 글감만 제안하세요.
- 서로 내용이 겹치지 않게, 각기 다른 각도로 구성하세요.
- score 가 높은 순서로 정렬해 주세요.

스키마: {"topics": [{"title": "...", "angle": "...", "summary": "...", "keywords": [...], "sources": [...], "score": 0, "reason": "..."}]}`;

  const result = await askJson(prompt, { system: SYSTEM, model, label: 'discover-topics', timeout: 420_000 });
  const raw = Array.isArray(result?.topics) ? result.topics : [];
  if (!raw.length) throw new Error('AI 가 글감을 만들어 내지 못했습니다. 다시 시도해 주세요.');

  const byRef = new Map();
  news.forEach((item, index) => byRef.set(`N${index + 1}`, item));
  blogs.forEach((item, index) => byRef.set(`B${index + 1}`, item));

  const createdAt = new Date().toISOString();
  const saved = raw
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .map((topic) => {
      const refs = Array.isArray(topic.sources) ? topic.sources : [];
      const sources = refs.map((ref) => byRef.get(String(ref).toUpperCase())).filter(Boolean);
      return topics.insert({
        id: newId('topic'),
        interest,
        title: String(topic.title || '').trim(),
        angle: String(topic.angle || '').trim(),
        summary: String(topic.summary || '').trim(),
        keywords: Array.isArray(topic.keywords) ? topic.keywords : [],
        score: Number(topic.score) || 0,
        reason: String(topic.reason || '').trim(),
        sources: sources.length ? sources : [...news.slice(0, 2), ...blogs.slice(0, 2)],
        searchKeywords: keywords,
        status: 'new',
        createdAt,
        updatedAt: createdAt,
      });
    });

  topics.trim(200);
  logger.ok('topics', `글감 ${saved.length}개를 찾았습니다.`);
  emitEvent('topics:updated', { count: saved.length });
  return { topics: saved, stats: { news: news.length, blogs: blogs.length, keywords } };
}
