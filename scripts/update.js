#!/usr/bin/env node
/**
 * 최신 코드로 갱신한다: `npm run update`
 *
 * git 없이도 동작한다. ZIP 을 받아 압축을 푸는 대신 깃허브 API 로 파일 목록을
 * 받아 하나씩 내려받는다. Node 기본 기능만 쓰므로 윈도우·맥·리눅스에서 똑같이 돈다.
 *
 * node_modules, data/ 는 건드리지 않는다 — 다시 설치할 필요가 없다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'ssimille68-byte';
const REPO = 'naver-blog-automation';
const BRANCH = 'claude/naver-blog-automation-9u2lnh';

/** 갱신 대상. 이 목록 밖의 파일(내 설정·데이터)은 손대지 않는다. */
const TRACKED = [/^server\//, /^public\//, /^scripts\//, /^test\//, /^package\.json$/, /^[^/]+\.md$/];

// 사용자가 직접 만든 캡처본·리포트는 덮어쓰지 않는다.
const SKIP = [/^test\/fixtures\/naver\/.*\.html$/];

const tracked = (file) => TRACKED.some((rule) => rule.test(file)) && !SKIP.some((rule) => rule.test(file));

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `${REPO}-updater` },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function main() {
  console.log('\n최신 코드를 확인하는 중…');
  console.log('(직접 고친 파일이 있다면 덮어쓰입니다. node_modules 와 data 는 그대로 둡니다.)\n');

  let tree;
  try {
    const data = await fetchJson(
      `https://api.github.com/repos/${OWNER}/${REPO}/git/trees/${encodeURIComponent(BRANCH)}?recursive=1`,
    );
    tree = (data.tree || []).filter((entry) => entry.type === 'blob' && tracked(entry.path));
  } catch (err) {
    console.error(`❌ 깃허브에 연결하지 못했습니다: ${err.message}`);
    console.error('   인터넷 연결을 확인한 뒤 다시 시도해 주세요.\n');
    process.exit(1);
  }

  if (!tree.length) {
    console.error('❌ 받아올 파일 목록이 비어 있습니다. 브랜치 이름이 바뀌었을 수 있습니다.\n');
    process.exit(1);
  }

  let changed = 0;
  let same = 0;
  let failed = 0;

  for (const entry of tree) {
    const url = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${entry.path
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
    const target = path.join(ROOT, entry.path);

    try {
      const response = await fetch(url, { headers: { 'User-Agent': `${REPO}-updater` } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = Buffer.from(await response.arrayBuffer());

      const current = fs.existsSync(target) ? fs.readFileSync(target) : null;
      if (current && current.equals(next)) {
        same += 1;
        continue;
      }

      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, next);
      console.log(`  ↻ ${entry.path}`);
      changed += 1;
    } catch (err) {
      console.log(`  ✗ ${entry.path} — ${err.message}`);
      failed += 1;
    }
  }

  console.log('');
  if (failed) {
    console.log(`⚠️  ${failed}개 파일을 받지 못했습니다. 다시 실행해 보세요.`);
  }
  if (!changed) {
    console.log('이미 최신 코드입니다. 바꿀 것이 없습니다.\n');
    return;
  }

  console.log(`✅ ${changed}개 파일을 갱신했습니다 (그대로인 파일 ${same}개).`);
  console.log('   이제 `npm run capture` 를 실행하세요.\n');
}

await main();
