import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { logger } from './util/logger.js';
import { PROFILE_DIR, ensureDirs } from './util/paths.js';

ensureDirs();

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const CONTEXT_DEFAULTS = {
  userAgent: UA,
  locale: 'ko-KR',
  timezoneId: 'Asia/Seoul',
  viewport: { width: 1440, height: 960 },
  deviceScaleFactor: 1,
};

let installPromise = null;

/** Make sure a Chromium build exists, downloading it once if it does not. */
export async function ensureBrowserInstalled() {
  try {
    const exe = chromium.executablePath();
    if (exe && fs.existsSync(exe)) return { installed: true, path: exe };
  } catch {
    // executablePath() 는 브라우저가 없으면 예외를 던진다 — 아래에서 설치한다.
  }

  if (!installPromise) {
    installPromise = runInstall().finally(() => {
      installPromise = null;
    });
  }
  return installPromise;
}

/**
 * Playwright CLI 의 진입 파일 경로.
 *
 * `npx playwright` 를 쓰지 않는 이유: 윈도우에서 npx 는 `npx.cmd` 라서
 * shell 없는 spawn 이 ENOENT 로 죽는다. 이미 설치된 패키지의 cli.js 를
 * 지금 돌고 있는 node 로 직접 실행하면 플랫폼을 가리지 않는다.
 */
function playwrightCliPath() {
  const require = createRequire(import.meta.url);
  for (const pkg of ['playwright', 'playwright-core']) {
    try {
      // 'playwright/cli.js' 는 package exports 에 막히므로 진입점에서 루트를 구한다.
      const cli = path.join(path.dirname(require.resolve(pkg)), 'cli.js');
      if (fs.existsSync(cli)) return cli;
    } catch {
      // 다음 후보
    }
  }
  return null;
}

function runPlaywrightInstall(extraArgs) {
  const cli = playwrightCliPath();
  if (!cli) {
    return Promise.reject(
      new Error('Playwright CLI 를 찾지 못했습니다. `npm install` 을 먼저 실행해 주세요.'),
    );
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'install', ...extraArgs, 'chromium'], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let tail = '';
    const capture = (chunk) => {
      tail = (tail + chunk).slice(-4000);
      const line = String(chunk).trim().split('\n').pop();
      if (line) logger.debug('browser', line);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    child.on('error', (err) => reject(new Error(`Playwright 설치 실행 실패: ${err.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`code ${code}\n${tail.slice(-800)}`))));
  });
}

async function runInstall() {
  logger.info('browser', 'Chromium 이 없어 Playwright 브라우저를 설치합니다. 몇 분 걸릴 수 있습니다…');

  // --with-deps 는 리눅스에서 apt 로 OS 패키지를 까는 옵션이다. 다른 OS 에는 의미가 없고,
  // 리눅스에서도 root 가 아니면 실패하므로 실패하면 브라우저만 다시 받는다.
  const withDeps = process.platform === 'linux' ? ['--with-deps'] : [];

  try {
    await runPlaywrightInstall(withDeps);
  } catch (err) {
    if (!withDeps.length) {
      throw new Error(`Playwright Chromium 설치 실패: ${err.message}`);
    }
    logger.warn('browser', 'OS 의존성 설치에 실패해 브라우저만 다시 설치합니다.');
    try {
      await runPlaywrightInstall([]);
    } catch (retryErr) {
      throw new Error(`Playwright Chromium 설치 실패: ${retryErr.message}`);
    }
  }

  logger.ok('browser', 'Chromium 설치 완료');
  return { installed: true, justInstalled: true };
}

/**
 * 로그인 세션(쿠키·로컬스토리지)이 담기는 영속 프로필.
 *
 * 네이버 로그인 창과 발행 작업이 같은 프로필을 공유해야 하므로, 동시에 두 개가
 * 열리지 않도록 잠금을 걸고 순차적으로 실행한다.
 */
let profileContext = null;
let profileChain = Promise.resolve();

export function withProfile(fn, { headless = true, slowMo = 0 } = {}) {
  const run = async () => {
    await ensureBrowserInstalled();
    const context = await openProfile({ headless, slowMo });
    try {
      return await fn(context);
    } finally {
      await closeProfile();
    }
  };
  // 이전 작업이 끝난 뒤에 실행되도록 직렬화한다.
  profileChain = profileChain.then(run, run);
  return profileChain;
}

async function openProfile({ headless, slowMo }) {
  if (profileContext) return profileContext;
  profileContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    slowMo,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--lang=ko-KR',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    ...CONTEXT_DEFAULTS,
  });
  await hardenContext(profileContext);
  return profileContext;
}

async function closeProfile() {
  if (!profileContext) return;
  const context = profileContext;
  profileContext = null;
  try {
    await context.close();
  } catch (err) {
    logger.warn('browser', `프로필 컨텍스트 종료 중 오류: ${err.message}`);
  }
}

/** A throwaway context for scraping — never touches the logged-in profile. */
export async function withScraper(fn, { headless = true } = {}) {
  await ensureBrowserInstalled();
  const browser = await chromium.launch({
    headless,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const context = await browser.newContext(CONTEXT_DEFAULTS);
    await hardenContext(context);
    return await fn(context);
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Hide the most obvious automation fingerprints Naver checks for. */
async function hardenContext(context) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  });
  context.setDefaultTimeout(30_000);
  context.setDefaultNavigationTimeout(60_000);
}

export function hasDisplay() {
  return process.platform !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}
