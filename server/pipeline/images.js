import fs from 'node:fs';
import path from 'node:path';
import { ask, extractJson } from '../ai/claude-cli.js';
import { searchImages } from './image-search.js';
import { logger, emitEvent } from '../util/logger.js';
import { IMAGE_DIR, safeJoin } from '../util/paths.js';
import { drafts, settings } from '../store.js';

const MAX_BYTES = 8 * 1024 * 1024;

const MAGIC = [
  { ext: '.jpg', type: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: '.png', type: 'image/png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: '.gif', type: 'image/gif', test: (b) => b.slice(0, 3).toString('ascii') === 'GIF' },
  {
    ext: '.webp',
    type: 'image/webp',
    test: (b) => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP',
  },
];

/** Trust the bytes, not the URL extension or the server's Content-Type. */
function sniff(buffer) {
  return MAGIC.find((entry) => entry.test(buffer)) || null;
}

async function download(url, destDir, baseName) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'naver-blog-automation/1.0 (personal blog tool)' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) throw new Error(`파일이 너무 큽니다 (${Math.round(declared / 1e6)}MB)`);

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_BYTES) throw new Error('파일이 너무 큽니다');
    if (buffer.length < 4096) throw new Error('이미지가 너무 작습니다');

    const kind = sniff(buffer);
    if (!kind) throw new Error('이미지 파일이 아닙니다');

    fs.mkdirSync(destDir, { recursive: true });
    const file = path.join(destDir, `${baseName}${kind.ext}`);
    fs.writeFileSync(file, buffer);
    return { file, bytes: buffer.length, mime: kind.type };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Claude 가 실제로 이미지를 "보고" 글의 맥락에 맞는지 판단한다.
 * Read 도구만 허용해 두면 -p 모드에서도 로컬 이미지 파일을 읽을 수 있다.
 */
async function judgeImage({ file, context, model }) {
  const prompt = `이미지 파일을 Read 도구로 열어서 직접 확인한 뒤, 아래 블로그 글의 해당 위치에 쓰기 적합한지 판단해 주세요.

이미지 경로: ${file}

# 글의 맥락
글 제목: ${context.title}
이미지가 들어갈 자리: ${context.purpose || context.caption || '본문 중간'}
앞 문단: ${context.before || '(없음)'}
뒤 문단: ${context.after || '(없음)'}

# 판단 기준
1. relevance(0~100): 사진의 실제 내용이 이 맥락과 얼마나 맞는가
2. quality(0~100): 해상도, 구도, 밝기 등 블로그 본문에 넣었을 때의 보기 좋음
3. safe: 선정적·폭력적·혐오 요소나 한국 블로그에 부적절한 요소가 없으면 true
4. hasText: 사진 안에 읽히는 글자(워터마크, 로고, 자막)가 크게 박혀 있으면 true
5. describe: 사진에 실제로 무엇이 보이는지 한국어 한 문장. 추측하지 말고 보이는 대로.
6. reason: 적합/부적합 판단 이유 한 문장
7. altText: 이 사진의 한국어 대체 텍스트 한 줄

score 는 relevance 70% + quality 30% 으로 계산하되, safe 가 false 면 0 으로 하세요.

스키마: {"relevance":0,"quality":0,"safe":true,"hasText":false,"describe":"...","reason":"...","altText":"...","score":0}
JSON 하나만 출력하세요.`;

  const text = await ask(prompt, {
    model,
    allowedTools: ['Read'],
    addDirs: [path.dirname(file)],
    label: 'judge-image',
    timeout: 180_000,
  });

  const verdict = extractJson(text);
  const relevance = Number(verdict.relevance) || 0;
  const quality = Number(verdict.quality) || 0;
  const safe = verdict.safe !== false;
  const score = safe ? Math.round(Number(verdict.score) || relevance * 0.7 + quality * 0.3) : 0;
  return { ...verdict, relevance, quality, safe, score };
}

function neighbourText(blocks, index) {
  const textOf = (block) => {
    if (!block) return '';
    if (block.type === 'list') return block.items.join(' / ');
    return block.text || '';
  };
  let before = '';
  let after = '';
  for (let i = index - 1; i >= 0 && !before; i -= 1) before = textOf(blocks[i]);
  for (let i = index + 1; i < blocks.length && !after; i += 1) after = textOf(blocks[i]);
  return { before: before.slice(0, 400), after: after.slice(0, 400) };
}

/**
 * 초안의 모든 image 블록에 대해: 후보 검색 → 다운로드 → AI 시각 검증 → 최고점 선택.
 */
export async function resolveImages({ draftId, onProgress = () => {} } = {}) {
  const config = settings.get();
  const draft = drafts.find(draftId);
  if (!draft) throw new Error('초안을 찾을 수 없습니다.');

  const destDir = safeJoin(IMAGE_DIR, draftId);
  fs.mkdirSync(destDir, { recursive: true });

  const imageBlocks = draft.blocks
    .map((block, index) => ({ block, index }))
    .filter((entry) => entry.block.type === 'image');

  if (!imageBlocks.length) {
    drafts.update(draftId, { imagesReady: true });
    return drafts.find(draftId);
  }

  let slot = 0;
  for (const { block, index } of imageBlocks) {
    slot += 1;
    const query = block.query || draft.title;
    onProgress({
      step: 'images',
      message: `이미지 ${slot}/${imageBlocks.length}: "${query}" 검색 중…`,
      progress: (slot - 1) / imageBlocks.length,
    });

    let candidates = [];
    try {
      candidates = await searchImages(query, {
        limit: config.imageCandidates,
        sources: config.imageSources,
        keys: { unsplashAccessKey: config.unsplashAccessKey, pexelsApiKey: config.pexelsApiKey },
      });
    } catch (err) {
      logger.warn('images', `이미지 검색 실패 (${query}): ${err.message}`);
    }

    if (!candidates.length) {
      Object.assign(block, { status: 'failed', error: '검색 결과가 없습니다.' });
      logger.warn('images', `이미지 후보를 찾지 못했습니다: ${query}`);
      continue;
    }

    const context = { title: draft.title, purpose: block.purpose, caption: block.caption, ...neighbourText(draft.blocks, index) };
    const reviewed = [];

    for (let i = 0; i < candidates.length && reviewed.length < config.imageCandidates; i += 1) {
      const candidate = candidates[i];
      let downloaded;
      try {
        downloaded = await download(candidate.url, destDir, `slot${slot}-cand${i + 1}`);
      } catch (err) {
        logger.debug('images', `다운로드 건너뜀: ${err.message}`);
        continue;
      }

      onProgress({
        step: 'images',
        message: `이미지 ${slot}/${imageBlocks.length}: AI 가 후보 ${reviewed.length + 1}번을 살펴보는 중…`,
      });

      try {
        const verdict = await judgeImage({ file: downloaded.file, context, model: config.visionModel });
        reviewed.push({ candidate, downloaded, verdict });
        logger.info(
          'images',
          `후보 ${i + 1} 평가: ${verdict.score}점 — ${verdict.describe || verdict.reason || ''}`.slice(0, 160),
        );
        // 충분히 좋은 사진을 찾았으면 남은 후보를 더 볼 필요가 없다.
        if (verdict.score >= Math.max(config.imageMinScore + 10, 85)) break;
      } catch (err) {
        logger.warn('images', `AI 이미지 판독 실패: ${err.message}`);
        fs.rmSync(downloaded.file, { force: true });
      }
    }

    const best = reviewed.sort((a, b) => b.verdict.score - a.verdict.score)[0];

    if (!best || best.verdict.score < config.imageMinScore) {
      Object.assign(block, {
        status: 'rejected',
        error: best
          ? `가장 높은 후보도 ${best.verdict.score}점으로 기준(${config.imageMinScore}점)에 못 미칩니다: ${best.verdict.reason || ''}`
          : 'AI 검증을 통과한 이미지가 없습니다.',
        rejected: reviewed.map((entry) => ({ score: entry.verdict.score, reason: entry.verdict.reason })),
      });
      logger.warn('images', `이미지 ${slot} 선택 실패 — 본문에서 제외됩니다.`);
    } else {
      Object.assign(block, {
        status: 'ready',
        file: path.basename(best.downloaded.file),
        url: best.candidate.url,
        sourcePage: best.candidate.sourcePage,
        credit: [best.candidate.creator, best.candidate.license, best.candidate.provider]
          .filter(Boolean)
          .join(' · '),
        score: best.verdict.score,
        verdict: best.verdict.reason,
        describe: best.verdict.describe,
        altText: best.verdict.altText || block.caption,
      });
      logger.ok('images', `이미지 ${slot} 확정 (${best.verdict.score}점, ${best.candidate.provider})`);
    }

    // 선택되지 않은 후보 파일은 지워서 데이터 폴더가 불어나지 않게 한다.
    for (const entry of reviewed) {
      if (!best || entry.downloaded.file !== best.downloaded.file) {
        fs.rmSync(entry.downloaded.file, { force: true });
      }
    }
  }

  const ready = draft.blocks.filter((b) => b.type === 'image').every((b) => b.status === 'ready');
  const updated = drafts.update(draftId, { blocks: draft.blocks, imagesReady: ready, status: 'ready' });

  emitEvent('drafts:updated', { draftId });
  return updated;
}
