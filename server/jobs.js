import { logger, emitEvent } from './util/logger.js';
import { newId } from './store.js';

/**
 * 글감 수집·글 작성·발행은 수 분씩 걸린다. HTTP 요청을 붙잡아 두는 대신
 * 작업으로 등록하고, 진행 상황은 SSE 로 흘려보낸다.
 */
const jobs = new Map();
const MAX_KEPT = 50;

export function listJobs() {
  return [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function activeJob() {
  return listJobs().find((job) => job.status === 'running') || null;
}

/**
 * Start a background job. `fn` receives an `onProgress` callback.
 * Only one job of a given `kind` runs at a time.
 */
export function startJob(kind, label, fn, { exclusive = true } = {}) {
  if (exclusive) {
    const running = listJobs().find((job) => job.status === 'running');
    if (running) {
      throw Object.assign(new Error(`이미 실행 중인 작업이 있습니다: ${running.label}`), { status: 409 });
    }
  }

  const job = {
    id: newId('job'),
    kind,
    label,
    status: 'running',
    step: 'start',
    message: '시작하는 중…',
    progress: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    result: null,
    error: null,
  };
  jobs.set(job.id, job);
  emitEvent('job:start', { job });

  const onProgress = (update = {}) => {
    Object.assign(job, update);
    if (update.message) logger.info(kind, update.message);
    emitEvent('job:progress', { job });
  };

  Promise.resolve()
    .then(() => fn(onProgress))
    .then((result) => {
      Object.assign(job, {
        status: 'done',
        progress: 1,
        message: '완료',
        result,
        finishedAt: new Date().toISOString(),
      });
      emitEvent('job:done', { job });
    })
    .catch((err) => {
      Object.assign(job, {
        status: 'error',
        error: err.message,
        message: err.message,
        finishedAt: new Date().toISOString(),
      });
      logger.error(kind, `작업 실패: ${err.message}`);
      emitEvent('job:error', { job });
    })
    .finally(() => {
      // 오래된 작업 기록은 정리한다.
      const all = listJobs();
      for (const old of all.slice(MAX_KEPT)) jobs.delete(old.id);
    });

  return job;
}
