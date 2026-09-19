import express from 'express';
import { api } from './routes/api.js';
import { checkCli } from './ai/claude-cli.js';
import { hasDisplay } from './browser.js';
import { getLoginStatus } from './naver/session.js';
import { logger } from './util/logger.js';
import { PUBLIC_DIR, ensureDirs } from './util/paths.js';

ensureDirs();

const PORT = Number(process.env.PORT || 4300);
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));
app.use('/api', api);

// eslint-disable-next-line no-unused-vars -- Express 는 4-인자 시그니처로 오류 핸들러를 식별한다.
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) logger.error('http', `${req.method} ${req.path} → ${err.message}`);
  res.status(status).json({ error: err.message || '알 수 없는 오류가 발생했습니다.' });
});

app.listen(PORT, HOST, async () => {
  console.log('');
  console.log('  네이버 블로그 자동화');
  console.log(`  대시보드  http://${HOST}:${PORT}`);
  console.log('');

  const cli = await checkCli();
  if (cli.available) {
    logger.ok('start', `Claude Code CLI 확인 (${cli.version}) — 구독 요금제로 동작합니다.`);
  } else {
    logger.error(
      'start',
      `Claude Code CLI 를 사용할 수 없습니다: ${cli.error}\n` +
        '  → npm i -g @anthropic-ai/claude-code 로 설치한 뒤 `claude login` 으로 로그인해 주세요.',
    );
  }

  if (!hasDisplay()) {
    logger.warn(
      'start',
      '디스플레이가 없는 환경입니다. 네이버 로그인 창을 띄우려면 `xvfb-run -a npm start` 로 실행하세요.',
    );
  }

  const login = await getLoginStatus();
  if (login.loggedIn) {
    logger.ok('start', `저장된 네이버 세션이 있습니다${login.naverId ? ` (${login.naverId})` : ''}.`);
  } else {
    logger.info('start', '네이버 로그인이 필요합니다. 대시보드에서 [네이버 로그인] 을 눌러 주세요.');
  }
});
