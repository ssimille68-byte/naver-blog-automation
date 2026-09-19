import { askJson } from '../ai/claude-cli.js';
import { fetchArticles } from '../collect/article.js';
import { logger, emitEvent } from '../util/logger.js';
import { drafts, newId, settings, topics as topicStore } from '../store.js';

const SYSTEM = `당신은 네이버 블로그에서 오래 사랑받아 온 한국어 블로거입니다.

글을 쓸 때 지키는 원칙:
- 자료를 그대로 옮기지 않습니다. 이해한 뒤 자기 문장으로 완전히 다시 씁니다.
- 모바일 화면에서 읽기 편하도록 문단을 짧게 끊습니다.
- AI 가 쓴 티가 나는 상투어("~에 대해 알아보겠습니다", "결론적으로", "여러분")를 피합니다.
- 확인되지 않은 수치나 사실을 지어내지 않습니다. 자료에 없으면 쓰지 않습니다.
- 과장된 홍보성 표현, 의료·금융 단정 표현을 쓰지 않습니다.`;

/** Blocks the Naver editor knows how to render. */
const BLOCK_TYPES = ['heading', 'paragraph', 'quote', 'list', 'divider', 'image'];

function normalizeBlocks(rawBlocks) {
  const blocks = [];
  for (const block of Array.isArray(rawBlocks) ? rawBlocks : []) {
    const type = BLOCK_TYPES.includes(block?.type) ? block.type : 'paragraph';
    if (type === 'divider') {
      blocks.push({ type: 'divider' });
      continue;
    }
    if (type === 'list') {
      const items = (Array.isArray(block.items) ? block.items : [])
        .map((item) => String(item).trim())
        .filter(Boolean);
      if (items.length) blocks.push({ type: 'list', ordered: Boolean(block.ordered), items });
      continue;
    }
    if (type === 'image') {
      blocks.push({
        type: 'image',
        query: String(block.query || block.text || '').trim(),
        caption: String(block.caption || '').trim(),
        purpose: String(block.purpose || '').trim(),
        status: 'pending',
      });
      continue;
    }
    const text = String(block.text || '').trim();
    if (text) blocks.push({ type, text });
  }
  return blocks;
}

function countChars(blocks) {
  return blocks.reduce((total, block) => {
    if (block.type === 'list') return total + block.items.join('').length;
    return total + (block.text?.length || 0);
  }, 0);
}

function buildSourceDigest(articles, topic) {
  if (!articles.length) {
    return `(본문을 가져오지 못해 제목과 요약만 있습니다)\n${topic.sources
      .map((source, index) => `[${index + 1}] ${source.title}\n  ${source.summary || ''}\n  출처: ${source.link}`)
      .join('\n')}`;
  }
  return articles
    .map(
      (article, index) =>
        `[${index + 1}] ${article.fullTitle}\n  종류: ${article.kind === 'news' ? '뉴스' : '블로그'} | 출처: ${article.press || article.author || '미상'} | URL: ${article.link}\n  본문:\n${article.body}`,
    )
    .join('\n\n---\n\n');
}

/**
 * 글감 하나를 받아 원문을 읽고, AI 가 블록 구조의 블로그 글로 다시 쓴다.
 * 이미지는 여기서 "무엇이 필요한지"만 정하고, 실제 검색·검증은 images.js 가 맡는다.
 */
export async function writeDraft({ topicId, instructions = '', onProgress = () => {} } = {}) {
  const config = settings.get();
  const topic = topicStore.find(topicId);
  if (!topic) throw new Error('글감을 찾을 수 없습니다.');

  onProgress({ step: 'read', message: '참고 자료 원문을 읽는 중…' });
  const articles = await fetchArticles(topic.sources, { limit: config.sourcesPerTopic, maxChars: 6000 });
  logger.info('writer', `참고 자료 ${articles.length}건의 본문을 확보했습니다.`);

  onProgress({ step: 'write', message: 'AI 가 블로그 글을 작성하는 중…' });

  const prompt = `아래 자료를 바탕으로 네이버 블로그 글 한 편을 완성해 주세요.

# 글감
제목 후보: ${topic.title}
차별점: ${topic.angle}
방향: ${topic.summary}
노릴 검색 키워드: ${(topic.keywords || []).join(', ')}

# 글의 톤
${config.tone}

# 분량
공백 포함 ${config.targetLength}자 내외 (±20%)

${instructions ? `# 사용자 추가 요청\n${instructions}\n` : ''}
# 참고 자료
${buildSourceDigest(articles, topic)}

# 작성 규칙
1. 자료의 문장을 복사하지 마세요. 내용을 이해한 뒤 완전히 새로운 문장으로 쓰세요.
2. 도입부는 독자의 상황이나 질문으로 시작해 자연스럽게 본론으로 넘어가세요.
3. 소제목(heading)으로 3~5개 구간을 나누고, 각 구간은 문단 2~4개로 채우세요.
4. 한 문단은 2~4문장, 모바일에서 3~4줄 정도로 유지하세요.
5. 숫자·날짜·인용은 자료에 있는 것만 쓰고, 어디서 나온 이야기인지 문맥으로 알 수 있게 하세요.
6. 이미지가 들어가면 좋을 자리에 image 블록을 ${config.imagesPerPost}개 넣으세요.
   - query: 이미지를 찾을 영어 검색어 (예: "seoul apartment skyline")
   - purpose: 이 자리에 이미지가 왜 필요한지 한국어 한 문장 (AI 가 사진 적합성을 판단할 때 씁니다)
   - caption: 사진 아래 들어갈 한국어 설명 한 줄
7. 마무리는 요약 + 독자에게 건네는 한마디로 끝내세요. "구독", "좋아요" 구걸은 넣지 마세요.
8. 맨 끝에 참고한 출처를 quote 블록 하나로 정리하세요.

# 출력 스키마
{
  "title": "실제 발행할 제목 (30자 내외)",
  "summary": "글 전체 한 줄 요약",
  "tags": ["태그", ...],
  "blocks": [
    {"type": "paragraph", "text": "..."},
    {"type": "heading", "text": "소제목"},
    {"type": "list", "ordered": false, "items": ["...", "..."]},
    {"type": "quote", "text": "..."},
    {"type": "image", "query": "...", "purpose": "...", "caption": "..."},
    {"type": "divider"}
  ]
}
tags 는 네이버 블로그 태그로 쓸 한국어 단어 7~10개입니다.`;

  const result = await askJson(prompt, {
    system: SYSTEM,
    model: config.model,
    label: 'write-draft',
    timeout: 600_000,
  });

  const blocks = normalizeBlocks(result?.blocks);
  if (blocks.length < 3) throw new Error('AI 가 충분한 본문을 만들어 내지 못했습니다. 다시 시도해 주세요.');

  const now = new Date().toISOString();
  const draft = drafts.insert({
    id: newId('draft'),
    topicId,
    title: String(result?.title || topic.title).trim(),
    summary: String(result?.summary || topic.summary).trim(),
    tags: (Array.isArray(result?.tags) ? result.tags : topic.keywords || [])
      .map((tag) => String(tag).replace(/^#/, '').trim())
      .filter(Boolean)
      .slice(0, 10),
    blocks,
    charCount: countChars(blocks),
    sources: articles.map((article) => ({
      title: article.fullTitle,
      link: article.link,
      kind: article.kind,
    })),
    instructions,
    status: 'written',
    imagesReady: false,
    createdAt: now,
    updatedAt: now,
  });

  topicStore.update(topicId, { status: 'drafted' });
  drafts.trim(100);

  logger.ok('writer', `초안 작성 완료: "${draft.title}" (${draft.charCount}자, 블록 ${blocks.length}개)`);
  emitEvent('drafts:updated', { draftId: draft.id });
  return draft;
}

/** Re-run the whole post through Claude with an edit instruction. */
export async function reviseDraft({ draftId, instruction }) {
  const config = settings.get();
  const draft = drafts.find(draftId);
  if (!draft) throw new Error('초안을 찾을 수 없습니다.');
  if (!instruction?.trim()) throw new Error('수정 요청 내용을 입력해 주세요.');

  const prompt = `아래는 이미 작성된 네이버 블로그 글입니다. 사용자의 수정 요청을 반영해 전체를 다시 출력해 주세요.

# 수정 요청
${instruction}

# 현재 글
${JSON.stringify({ title: draft.title, tags: draft.tags, blocks: draft.blocks }, null, 2)}

# 규칙
- 요청과 관계없는 부분은 그대로 두세요.
- 이미지 블록은 개수와 위치를 유지하되, 요청에 따라 query/purpose/caption 은 바꿔도 됩니다.
- 출력 스키마는 입력과 동일하게 {"title","summary","tags","blocks"} 입니다.`;

  const result = await askJson(prompt, {
    system: SYSTEM,
    model: config.model,
    label: 'revise-draft',
    timeout: 600_000,
  });

  const blocks = normalizeBlocks(result?.blocks);
  if (blocks.length < 3) throw new Error('수정 결과가 비어 있습니다. 다시 시도해 주세요.');

  // 이미 검증을 마친 이미지는 순서대로 다시 붙여 준다 (재검색 비용 절약).
  const resolved = draft.blocks.filter((block) => block.type === 'image' && block.file);
  let cursor = 0;
  for (const block of blocks) {
    if (block.type === 'image' && resolved[cursor]) {
      Object.assign(block, {
        file: resolved[cursor].file,
        url: resolved[cursor].url,
        credit: resolved[cursor].credit,
        score: resolved[cursor].score,
        verdict: resolved[cursor].verdict,
        status: 'ready',
      });
      cursor += 1;
    }
  }

  const updated = drafts.update(draftId, {
    title: String(result?.title || draft.title).trim(),
    summary: String(result?.summary || draft.summary).trim(),
    tags: (Array.isArray(result?.tags) ? result.tags : draft.tags)
      .map((tag) => String(tag).replace(/^#/, '').trim())
      .filter(Boolean)
      .slice(0, 10),
    blocks,
    charCount: countChars(blocks),
    imagesReady: blocks.filter((b) => b.type === 'image').every((b) => b.status === 'ready'),
    status: 'written',
  });

  logger.ok('writer', `초안을 수정했습니다: "${updated.title}"`);
  emitEvent('drafts:updated', { draftId });
  return updated;
}
