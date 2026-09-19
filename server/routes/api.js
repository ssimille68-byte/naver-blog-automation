import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { checkCli } from '../ai/claude-cli.js';
import { ensureBrowserInstalled, hasDisplay } from '../browser.js';
import { getLoginStatus, isLoginInFlight, logout, startInteractiveLogin } from '../naver/session.js';
import { publishDraft } from '../naver/publisher.js';
import { renderPreviewHtml, renderPreviewText } from '../naver/format.js';
import { discoverTopics } from '../pipeline/topics.js';
import { reviseDraft, writeDraft } from '../pipeline/writer.js';
import { resolveImages } from '../pipeline/images.js';
import { drafts, publications, settings, topics } from '../store.js';
import { getJob, listJobs, startJob } from '../jobs.js';
import { bus, logger, recentLogs } from '../util/logger.js';
import { IMAGE_DIR, LOG_DIR, safeJoin } from '../util/paths.js';

export const api = express.Router();

/** Wrap an async handler so rejections become JSON error responses. */
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

// ─── 상태 ──────────────────────────────────────────────────────────────────
api.get(
  '/status',
  wrap(async (req, res) => {
    const [cli, login] = await Promise.all([checkCli(), getLoginStatus({ deep: req.query.deep === '1' })]);
    let browser = { installed: false };
    try {
      browser = await ensureBrowserInstalled();
    } catch (err) {
      browser = { installed: false, error: err.message };
    }
    res.json({
      claude: cli,
      naver: { ...login, loginInFlight: isLoginInFlight() },
      browser,
      display: hasDisplay(),
      counts: {
        topics: topics.all().length,
        drafts: drafts.all().length,
        publications: publications.all().length,
      },
      jobs: listJobs().slice(0, 10),
    });
  }),
);

// ─── 설정 ──────────────────────────────────────────────────────────────────
api.get('/settings', (req, res) => {
  const config = settings.get();
  // 저장된 키는 화면에 그대로 내보내지 않고 "설정됨" 여부만 알려 준다.
  res.json({
    ...config,
    unsplashAccessKey: config.unsplashAccessKey ? '********' : '',
    pexelsApiKey: config.pexelsApiKey ? '********' : '',
  });
});

api.put('/settings', (req, res) => {
  const patch = { ...req.body };
  // 마스킹된 값이 그대로 돌아오면 기존 키를 지우지 않도록 무시한다.
  for (const key of ['unsplashAccessKey', 'pexelsApiKey']) {
    if (patch[key] === '********') delete patch[key];
  }
  const updated = settings.update(patch);
  logger.info('settings', '설정을 저장했습니다.');
  res.json({ ...updated, unsplashAccessKey: updated.unsplashAccessKey ? '********' : '', pexelsApiKey: updated.pexelsApiKey ? '********' : '' });
});

// ─── 네이버 로그인 ─────────────────────────────────────────────────────────
api.post(
  '/naver/login',
  wrap(async (req, res) => {
    const job = startJob('login', '네이버 로그인', async (onProgress) => {
      onProgress({ step: 'open', message: '로그인 창을 여는 중… 브라우저에서 로그인해 주세요.' });
      const result = await startInteractiveLogin({ timeoutMs: Number(req.body?.timeoutMs) || 5 * 60_000 });
      onProgress({ step: 'done', message: `로그인 완료${result.naverId ? ` (${result.naverId})` : ''}` });
      return result;
    });
    res.json({ job });
  }),
);

api.post(
  '/naver/logout',
  wrap(async (req, res) => {
    res.json(await logout());
  }),
);

// ─── 글감 ──────────────────────────────────────────────────────────────────
api.get('/topics', (req, res) => res.json(topics.all()));
api.delete('/topics/:id', (req, res) => res.json({ removed: topics.remove(req.params.id) }));

api.post(
  '/topics/discover',
  wrap(async (req, res) => {
    const interest = String(req.body?.interest || '').trim() || settings.get().interests[0];
    if (!interest) return res.status(400).json({ error: '관심 분야를 입력해 주세요.' });

    const job = startJob('topics', `글감 찾기: ${interest}`, (onProgress) =>
      discoverTopics({ interest, onProgress }),
    );
    res.json({ job });
  }),
);

// ─── 초안 ──────────────────────────────────────────────────────────────────
api.get('/drafts', (req, res) =>
  res.json(
    drafts.all().map((draft) => ({
      id: draft.id,
      title: draft.title,
      summary: draft.summary,
      status: draft.status,
      charCount: draft.charCount,
      imagesReady: draft.imagesReady,
      tags: draft.tags,
      publishedUrl: draft.publishedUrl,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
    })),
  ),
);

api.get('/drafts/:id', (req, res) => {
  const draft = drafts.find(req.params.id);
  if (!draft) return res.status(404).json({ error: '초안을 찾을 수 없습니다.' });
  res.json({
    ...draft,
    previewHtml: renderPreviewHtml(draft.blocks, (block) => `/api/images/${draft.id}/${block.file}`),
    previewText: renderPreviewText(draft.blocks),
  });
});

api.delete('/drafts/:id', (req, res) => {
  fs.rmSync(path.join(IMAGE_DIR, req.params.id), { recursive: true, force: true });
  res.json({ removed: drafts.remove(req.params.id) });
});

api.patch('/drafts/:id', (req, res) => {
  const allowed = ['title', 'tags', 'blocks', 'category', 'visibility', 'summary'];
  const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([key]) => allowed.includes(key)));
  const updated = drafts.update(req.params.id, patch);
  if (!updated) return res.status(404).json({ error: '초안을 찾을 수 없습니다.' });
  res.json(updated);
});

api.post(
  '/drafts/generate',
  wrap(async (req, res) => {
    const { topicId, instructions = '', withImages = true, autoPublish = false } = req.body || {};
    const topic = topics.find(topicId);
    if (!topic) return res.status(404).json({ error: '글감을 찾을 수 없습니다.' });

    const job = startJob('writer', `글 작성: ${topic.title.slice(0, 30)}`, async (onProgress) => {
      const draft = await writeDraft({ topicId, instructions, onProgress });
      if (withImages) {
        onProgress({ step: 'images', message: '이미지를 찾고 AI 로 검증하는 중…', progress: 0.6 });
        await resolveImages({ draftId: draft.id, onProgress });
      }
      if (autoPublish) {
        onProgress({ step: 'publish', message: '네이버 블로그에 발행하는 중…', progress: 0.85 });
        await publishDraft({ draftId: draft.id, onProgress });
      }
      return drafts.find(draft.id);
    });
    res.json({ job });
  }),
);

api.post(
  '/drafts/:id/revise',
  wrap(async (req, res) => {
    const instruction = String(req.body?.instruction || '').trim();
    const draft = drafts.find(req.params.id);
    if (!draft) return res.status(404).json({ error: '초안을 찾을 수 없습니다.' });

    const job = startJob('writer', `글 수정: ${draft.title.slice(0, 30)}`, () =>
      reviseDraft({ draftId: req.params.id, instruction }),
    );
    res.json({ job });
  }),
);

api.post(
  '/drafts/:id/images',
  wrap(async (req, res) => {
    const draft = drafts.find(req.params.id);
    if (!draft) return res.status(404).json({ error: '초안을 찾을 수 없습니다.' });

    const job = startJob('images', `이미지 재검색: ${draft.title.slice(0, 30)}`, (onProgress) =>
      resolveImages({ draftId: req.params.id, onProgress }),
    );
    res.json({ job });
  }),
);

api.post(
  '/drafts/:id/publish',
  wrap(async (req, res) => {
    const draft = drafts.find(req.params.id);
    if (!draft) return res.status(404).json({ error: '초안을 찾을 수 없습니다.' });

    const { category, visibility, dryRun = false } = req.body || {};
    if (category !== undefined || visibility !== undefined) {
      drafts.update(req.params.id, {
        ...(category !== undefined ? { category } : {}),
        ...(visibility !== undefined ? { visibility } : {}),
      });
    }

    const job = startJob('publish', `${dryRun ? '발행 연습' : '발행'}: ${draft.title.slice(0, 30)}`, (onProgress) =>
      publishDraft({ draftId: req.params.id, dryRun: Boolean(dryRun), onProgress }),
    );
    res.json({ job });
  }),
);

// ─── 전자동 파이프라인 ─────────────────────────────────────────────────────
api.post(
  '/run/auto',
  wrap(async (req, res) => {
    const config = settings.get();
    const interest = String(req.body?.interest || '').trim() || config.interests[0];
    const publish = req.body?.publish ?? config.autoPublish;
    const dryRun = Boolean(req.body?.dryRun);
    if (!interest) return res.status(400).json({ error: '관심 분야를 입력해 주세요.' });

    const job = startJob('auto', `전자동 실행: ${interest}`, async (onProgress) => {
      onProgress({ step: 'topics', message: '글감을 찾는 중…', progress: 0.05 });
      const { topics: found } = await discoverTopics({ interest, onProgress });
      const best = found[0];
      if (!best) throw new Error('쓸 만한 글감을 찾지 못했습니다.');

      onProgress({ step: 'write', message: `가장 점수가 높은 글감으로 작성합니다: ${best.title}`, progress: 0.3 });
      const draft = await writeDraft({ topicId: best.id, onProgress });

      onProgress({ step: 'images', message: '이미지를 찾고 검증하는 중…', progress: 0.6 });
      await resolveImages({ draftId: draft.id, onProgress });

      if (!publish) {
        onProgress({ step: 'done', message: '초안까지 완료했습니다. 검토 후 발행해 주세요.', progress: 1 });
        return { draftId: draft.id, published: false };
      }

      onProgress({ step: 'publish', message: '네이버 블로그에 발행하는 중…', progress: 0.85 });
      const result = await publishDraft({ draftId: draft.id, dryRun, onProgress });
      return { draftId: draft.id, ...result };
    });
    res.json({ job });
  }),
);

// ─── 발행 기록 ─────────────────────────────────────────────────────────────
api.get('/publications', (req, res) => res.json(publications.all()));

// ─── 작업 / 로그 ───────────────────────────────────────────────────────────
api.get('/jobs', (req, res) => res.json(listJobs()));
api.get('/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  res.json(job);
});
api.get('/logs', (req, res) => res.json(recentLogs(Number(req.query.limit) || 200)));

/** Server-sent events: live log lines and job progress for the dashboard. */
api.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const send = (type) => (payload) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  const onLog = send('log');
  const onEvent = send('event');
  bus.on('log', onLog);
  bus.on('event', onEvent);

  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => {
    clearInterval(keepAlive);
    bus.off('log', onLog);
    bus.off('event', onEvent);
  });
});

// ─── 정적 이미지 / 스크린샷 ────────────────────────────────────────────────
api.get('/images/:draftId/:file', (req, res) => {
  try {
    const file = safeJoin(IMAGE_DIR, req.params.draftId, req.params.file);
    if (!fs.existsSync(file)) return res.status(404).end();
    res.sendFile(file);
  } catch {
    res.status(400).end();
  }
});

api.get('/screenshots/:file', (req, res) => {
  try {
    const file = safeJoin(LOG_DIR, req.params.file);
    if (!fs.existsSync(file)) return res.status(404).end();
    res.sendFile(file);
  } catch {
    res.status(400).end();
  }
});
