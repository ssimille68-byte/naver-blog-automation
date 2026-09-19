#!/usr/bin/env node
/** 실행 전에 환경이 갖춰졌는지 한 번에 점검한다: node scripts/doctor.js */
import { checkCli } from '../server/ai/claude-cli.js';
import { ensureBrowserInstalled, hasDisplay } from '../server/browser.js';
import { getLoginStatus } from '../server/naver/session.js';
import { DATA_DIR } from '../server/util/paths.js';

const mark = (ok) => (ok === true ? '✅' : ok === false ? '❌' : '⚠️ ');
let failures = 0;

console.log('\n네이버 블로그 자동화 — 환경 점검\n');

const node = Number(process.versions.node.split('.')[0]);
console.log(`${mark(node >= 20)} Node.js ${process.versions.node} (20 이상 필요)`);
if (node < 20) failures += 1;

const cli = await checkCli();
console.log(`${mark(cli.available)} Claude Code CLI ${cli.available ? cli.version : `— ${cli.error}`}`);
if (!cli.available) {
  failures += 1;
  console.log('    → npm i -g @anthropic-ai/claude-code && claude login');
} else {
  console.log('    → 모든 AI 호출이 `claude -p` 로 나가므로 구독 요금제가 그대로 적용됩니다.');
}

try {
  const browser = await ensureBrowserInstalled();
  console.log(`${mark(true)} Playwright Chromium 준비됨${browser.justInstalled ? ' (방금 설치함)' : ''}`);
} catch (err) {
  failures += 1;
  console.log(`${mark(false)} Playwright Chromium — ${err.message}`);
  console.log('    → npx playwright install chromium');
}

console.log(`${mark(hasDisplay() ? true : null)} 디스플레이 ${hasDisplay() ? '사용 가능' : '없음 — 로그인 창을 띄우려면 xvfb-run 필요'}`);

const login = await getLoginStatus();
console.log(`${mark(login.loggedIn ? true : null)} 네이버 세션 ${login.loggedIn ? `저장됨 (${login.naverId || '아이디 미확인'})` : '없음 — 대시보드에서 로그인하세요'}`);

console.log(`\n데이터 위치: ${DATA_DIR}`);
console.log(failures ? `\n${failures}개 항목을 먼저 해결해 주세요.\n` : '\n준비 완료. `npm start` 로 실행하세요.\n');
process.exit(failures ? 1 : 0);
