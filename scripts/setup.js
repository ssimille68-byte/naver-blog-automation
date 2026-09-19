#!/usr/bin/env node
/** 최초 1회 실행: Chromium 을 내려받고 데이터 폴더를 만든다. */
import { ensureBrowserInstalled } from '../server/browser.js';
import { ensureDirs, DATA_DIR } from '../server/util/paths.js';

ensureDirs();
console.log(`데이터 폴더 준비 완료: ${DATA_DIR}`);

try {
  const result = await ensureBrowserInstalled();
  console.log(result.justInstalled ? 'Chromium 설치 완료.' : 'Chromium 이 이미 설치되어 있습니다.');
} catch (err) {
  console.error(`Chromium 설치 실패: ${err.message}`);
  process.exit(1);
}

console.log('\n다음 단계:');
console.log('  1) claude login        — 구독 계정으로 Claude CLI 로그인');
console.log('  2) npm start           — 대시보드 실행 (http://127.0.0.1:4300)');
console.log('  3) 대시보드에서 [네이버 로그인] 클릭\n');
