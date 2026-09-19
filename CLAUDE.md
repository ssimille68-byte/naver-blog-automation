# 작업 지침

네이버 블로그 자동화 도구. Node.js ESM, 빌드 도구 없음.

## 핵심 원칙

- **AI 호출은 반드시 `server/ai/claude-cli.js` 의 `ask()` / `askJson()` 를 거친다.**
  Anthropic SDK 나 API 키를 직접 쓰지 말 것 — 이 프로젝트는 `claude -p` 로 구독 요금제를 쓰는 것이 전제다.
- **사용자에게 보이는 문자열(로그·오류·UI)은 한국어로.** 코드 주석은 "왜"를 설명할 때만 쓴다.
- **네이버 DOM 선택자는 `server/naver/selectors.js` 에만 둔다.** 다른 파일에 하드코딩하지 말 것.
  - 에디터(`SEL`): 후보 배열 + `firstVisible()` / `firstPresent()`
  - 검색(`SEARCH`): 마크업 세대별 카드 선택자 + 링크 패턴 폴백. 순수 데이터만 담는다
    (브라우저 안에서 도는 `collect/extractors.js` 에 인자로 넘어가기 때문).
- **네트워크·DOM 실패는 파이프라인을 멈추지 않는다.** 수집 실패는 로그를 남기고 건너뛴다.
  발행처럼 되돌릴 수 없는 동작만 예외를 던진다.

## 검증

```bash
npm test          # 발행 + 검색 파싱 테스트 (네트워크 불필요)
npm run capture   # 실제 네이버 HTML 로 파서 검증 + 픽스처 저장 (네트워크 필요)
npm run doctor    # 환경 점검
```

발행 로직을 고쳤다면 `npm test` 를 반드시 돌린다. 모의 에디터(`test/fixtures/editor.html`)는
실제 SE ONE 의 거동(iframe, 복구 팝업, paste→HTML 변환, 파일 업로드, 발행 레이어)을 흉내 내므로
네이버에 접속하지 않고도 회귀를 잡을 수 있다.

검색 파서를 고쳤다면 `npm test` 로 세대별 표본을 통과시키고, 네트워크가 되는 환경이라면
`npm run capture` 로 실제 HTML 에도 돌려 본다. 표본은 "다루기로 한 구조"만 증명할 뿐,
네이버가 지금 내려보내는 것과 같다는 보장은 없다.

`npm run capture` 는 문제가 있을 때 기사 링크의 조상 사슬과 결과 영역 DOM 골격을
`capture-report.md` 에 덤프한다. 사용자가 이 리포트를 붙여 넣으면 그것만 보고
`SEARCH` 를 고칠 수 있다 — 코드 변경 없이 선택자 데이터만 바꾸면 된다.
`--from <파일>` 로 저장된 HTML 을 네트워크 없이 재진단할 수 있다.

## 주의

- `data/` 에는 로그인 세션이 들어 있다. 커밋하지 말 것 (`.gitignore` 에 있음).
- 사용자 입력이 경로에 들어가면 `safeJoin()` 을 쓴다.
- 발행은 되돌릴 수 없다. 새 기능은 `dryRun` 경로를 함께 지원할 것.
