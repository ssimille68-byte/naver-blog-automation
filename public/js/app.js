const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  status: null,
  settings: null,
  topics: [],
  drafts: [],
  selectedDraft: null,
  activeJobId: null,
};

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.error || `요청 실패 (${response.status})`);
  return data;
}

function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 6000);
}

// ── 탭 ──────────────────────────────────────────────────────────────────
$('#tabs').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-tab]');
  if (!button) return;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b === button));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === button.dataset.tab));
  if (button.dataset.tab === 'topics') loadTopics();
  if (button.dataset.tab === 'drafts') loadDrafts();
  if (button.dataset.tab === 'published') loadPublications();
  if (button.dataset.tab === 'settings') renderSettings();
});

// ── 상태 ────────────────────────────────────────────────────────────────
function pill(label, ok, detail) {
  const cls = ok === true ? 'ok' : ok === false ? 'bad' : 'warn';
  return `<span class="pill ${cls}" title="${esc(detail || '')}"><span class="dot"></span>${esc(label)}</span>`;
}

async function loadStatus() {
  try {
    state.status = await api('/status');
  } catch (err) {
    $('#statusPills').innerHTML = pill('서버 연결 끊김', false, err.message);
    return;
  }
  const s = state.status;
  $('#statusPills').innerHTML = [
    pill(s.claude.available ? `Claude CLI ${s.claude.version}` : 'Claude CLI 없음', s.claude.available, s.claude.error),
    pill(s.naver.loggedIn ? `네이버 ${s.naver.naverId || '로그인됨'}` : '네이버 미로그인', s.naver.loggedIn),
    pill(s.browser.installed ? 'Chromium 준비됨' : 'Chromium 미설치', s.browser.installed, s.browser.error),
    pill(s.display ? '로그인 창 가능' : '디스플레이 없음', s.display ? true : null, s.display ? '' : 'xvfb-run 으로 실행하거나 데스크톱에서 실행하세요.'),
  ].join('');
  renderLoginBox();
}

function renderLoginBox() {
  const naver = state.status?.naver || {};
  $('#loginBox').innerHTML = naver.loggedIn
    ? `<div class="who"><strong>${esc(naver.naverId || '로그인됨')}</strong>
         <span>블로그 아이디: ${esc(naver.blogId || '미확인')} · 세션이 로컬에 저장되어 있습니다</span></div>
       <div class="row">
         <button id="btnVerify">세션 확인</button>
         <button id="btnLogout" class="danger">로그아웃</button>
       </div>`
    : `<div class="who"><strong>로그인이 필요합니다</strong>
         <span>버튼을 누르면 브라우저 창이 열립니다. 직접 로그인하면 세션이 로컬에 저장됩니다.</span></div>
       <button id="btnLogin" class="primary">네이버 로그인</button>`;

  $('#btnLogin')?.addEventListener('click', async () => {
    try {
      const { job } = await api('/naver/login', { method: 'POST' });
      watchJob(job);
      toast('로그인 창을 열고 있습니다. 브라우저에서 로그인해 주세요.');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $('#btnLogout')?.addEventListener('click', async () => {
    if (!confirm('저장된 네이버 세션을 삭제할까요?')) return;
    await api('/naver/logout', { method: 'POST' });
    toast('로그아웃했습니다.');
    loadStatus();
  });
  $('#btnVerify')?.addEventListener('click', async () => {
    toast('세션을 확인하는 중…');
    state.status = await api('/status?deep=1');
    renderLoginBox();
    toast(state.status.naver.loggedIn ? '세션이 유효합니다.' : '세션이 만료되었습니다. 다시 로그인해 주세요.', state.status.naver.loggedIn ? 'info' : 'error');
  });
}

// ── 작업 진행 ───────────────────────────────────────────────────────────
function renderJob(job) {
  if (!job) {
    $('#jobCard').hidden = true;
    return;
  }
  $('#jobCard').hidden = false;
  const pct = Math.round((job.progress || 0) * 100);
  const statusLabel = { running: '진행 중', done: '완료', error: '실패' }[job.status] || job.status;
  $('#jobBody').innerHTML = `
    <div class="row" style="justify-content:space-between">
      <strong>${esc(job.label)}</strong>
      <span class="badge ${job.status === 'error' ? 'failed' : job.status === 'done' ? 'ready' : ''}">${esc(statusLabel)}</span>
    </div>
    <div class="progress"><div style="width:${job.status === 'done' ? 100 : pct}%"></div></div>
    <div class="job-step">${esc(job.message || '')}</div>`;
}

function watchJob(job) {
  state.activeJobId = job.id;
  renderJob(job);
}

function onJobUpdate(job) {
  if (job.id !== state.activeJobId) {
    // 다른 작업이 새로 시작되면 그쪽을 따라간다.
    if (job.status === 'running') state.activeJobId = job.id;
    else return;
  }
  renderJob(job);

  if (job.status === 'done') {
    toast(`완료: ${job.label}`);
    loadStatus();
    loadTopics();
    loadDrafts();
    loadPublications();
    if (state.selectedDraft) openDraft(state.selectedDraft);
  }
  if (job.status === 'error') toast(`실패: ${job.error}`, 'error');
}

// ── 자동 실행 ───────────────────────────────────────────────────────────
$('#autoRun').addEventListener('click', async () => {
  const interest = $('#autoInterest').value.trim();
  if (!interest) return toast('관심 분야를 입력해 주세요.', 'error');
  try {
    const { job } = await api('/run/auto', {
      method: 'POST',
      body: { interest, publish: $('#autoPublish').checked, dryRun: $('#autoDryRun').checked },
    });
    watchJob(job);
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ── 글감 ────────────────────────────────────────────────────────────────
$('#topicDiscover').addEventListener('click', async () => {
  const interest = $('#topicInterest').value.trim();
  if (!interest) return toast('관심 분야를 입력해 주세요.', 'error');
  try {
    const { job } = await api('/topics/discover', { method: 'POST', body: { interest } });
    watchJob(job);
  } catch (err) {
    toast(err.message, 'error');
  }
});

async function loadTopics() {
  state.topics = await api('/topics').catch(() => []);
  const list = $('#topicList');
  if (!state.topics.length) {
    list.innerHTML = '<div class="empty">아직 글감이 없습니다. 관심 분야를 입력하고 [글감 찾기] 를 눌러 보세요.</div>';
    return;
  }
  list.innerHTML = state.topics
    .map(
      (topic) => `
      <article class="item" data-topic="${esc(topic.id)}">
        <div class="item-head">
          <div>
            <h3>${esc(topic.title)}</h3>
            <p>${esc(topic.summary)}</p>
          </div>
          <div class="score">${topic.score}</div>
        </div>
        <div class="meta">
          <span class="badge ${topic.status === 'drafted' ? 'ready' : ''}">${topic.status === 'drafted' ? '작성함' : '새 글감'}</span>
          ${(topic.keywords || []).map((k) => `<span class="tag">${esc(k)}</span>`).join('')}
          <span>· 근거 ${topic.sources?.length || 0}건</span>
        </div>
        <div class="meta" style="margin-top:6px">${esc(topic.angle)} — ${esc(topic.reason)}</div>
        <div class="item-actions">
          <button class="primary" data-write="${esc(topic.id)}">이 글감으로 쓰기</button>
          <button data-sources="${esc(topic.id)}">근거 자료 보기</button>
          <button class="danger" data-del-topic="${esc(topic.id)}">삭제</button>
        </div>
        <div class="sources" hidden></div>
      </article>`,
    )
    .join('');
}

$('#topicList').addEventListener('click', async (event) => {
  const writeId = event.target.dataset.write;
  const sourcesId = event.target.dataset.sources;
  const delId = event.target.dataset.delTopic;

  if (writeId) {
    const instructions = prompt('추가 요청이 있으면 적어 주세요 (없으면 비워 두세요).', '') ?? '';
    try {
      const { job } = await api('/drafts/generate', {
        method: 'POST',
        body: { topicId: writeId, instructions, withImages: true },
      });
      watchJob(job);
      toast('글 작성을 시작했습니다. 몇 분 걸립니다.');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  if (sourcesId) {
    const topic = state.topics.find((t) => t.id === sourcesId);
    const box = event.target.closest('.item').querySelector('.sources');
    box.hidden = !box.hidden;
    box.innerHTML = (topic?.sources || [])
      .map(
        (source) =>
          `<div class="meta" style="margin-top:8px"><span class="tag">${source.kind === 'news' ? '뉴스' : '블로그'}</span>
           <a href="${esc(source.link)}" target="_blank" rel="noopener">${esc(source.title)}</a></div>`,
      )
      .join('');
  }

  if (delId) {
    await api(`/topics/${delId}`, { method: 'DELETE' });
    loadTopics();
  }
});

// ── 초안 ────────────────────────────────────────────────────────────────
async function loadDrafts() {
  state.drafts = await api('/drafts').catch(() => []);
  const list = $('#draftList');
  if (!state.drafts.length) {
    list.innerHTML = '<div class="empty">초안이 없습니다.</div>';
    return;
  }
  list.innerHTML = state.drafts
    .map(
      (draft) => `
      <article class="item ${draft.id === state.selectedDraft ? 'selected' : ''}" data-draft="${esc(draft.id)}">
        <h3>${esc(draft.title)}</h3>
        <div class="meta">
          <span class="badge ${esc(draft.status)}">${esc(statusLabel(draft.status))}</span>
          <span>${draft.charCount}자</span>
          ${draft.imagesReady ? '<span>· 이미지 완료</span>' : '<span>· 이미지 미완</span>'}
        </div>
      </article>`,
    )
    .join('');
}

function statusLabel(status) {
  return { written: '작성됨', ready: '발행 대기', publishing: '발행 중', published: '발행됨', failed: '실패' }[status] || status;
}

$('#draftList').addEventListener('click', (event) => {
  const item = event.target.closest('[data-draft]');
  if (item) openDraft(item.dataset.draft);
});

async function openDraft(id) {
  state.selectedDraft = id;
  $$('#draftList .item').forEach((el) => el.classList.toggle('selected', el.dataset.draft === id));

  let draft;
  try {
    draft = await api(`/drafts/${id}`);
  } catch (err) {
    $('#draftDetail').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }

  const imageBlocks = draft.blocks.filter((b) => b.type === 'image');
  $('#draftDetail').innerHTML = `
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <div>
        <h2 style="margin:0 0 4px">${esc(draft.title)}</h2>
        <div class="meta">
          <span class="badge ${esc(draft.status)}">${esc(statusLabel(draft.status))}</span>
          <span>${draft.charCount}자</span>
          ${draft.publishedUrl ? `· <a href="${esc(draft.publishedUrl)}" target="_blank" rel="noopener">발행된 글 보기</a>` : ''}
        </div>
      </div>
    </div>
    ${draft.lastError ? `<div class="preview img-missing">${esc(draft.lastError)}</div>` : ''}

    <div class="meta" style="margin-top:10px">${draft.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>

    <div class="item-actions" style="margin-top:14px">
      <button class="primary" data-publish="${esc(draft.id)}">네이버에 발행</button>
      <button data-dry="${esc(draft.id)}">발행 연습 (발행 안 함)</button>
      <button data-images="${esc(draft.id)}">이미지 다시 찾기</button>
      <button data-revise="${esc(draft.id)}">AI 수정 요청</button>
      <button class="danger" data-del-draft="${esc(draft.id)}">삭제</button>
    </div>

    <div class="row" style="margin-top:12px">
      <div class="field" style="flex:1"><label>카테고리 (비우면 기본값)</label>
        <input type="text" id="draftCategory" value="${esc(draft.category || '')}" placeholder="네이버 블로그 카테고리 이름"></div>
      <div class="field" style="flex:1"><label>공개 범위</label>
        <select id="draftVisibility">
          <option value="public"${(draft.visibility || 'public') === 'public' ? ' selected' : ''}>전체공개</option>
          <option value="neighbor"${draft.visibility === 'neighbor' ? ' selected' : ''}>이웃공개</option>
          <option value="private"${draft.visibility === 'private' ? ' selected' : ''}>비공개</option>
        </select></div>
    </div>

    ${
      imageBlocks.length
        ? `<h3 style="margin:22px 0 8px;font-size:14px">AI 이미지 검증 결과</h3>
           <div class="img-review">${imageBlocks
             .map((block) =>
               block.status === 'ready'
                 ? `<div class="entry">
                      <img src="/api/images/${esc(draft.id)}/${esc(block.file)}" alt="">
                      <div><strong>${block.score}점</strong> · ${esc(block.credit || '')}
                        <div class="verdict">${esc(block.describe || '')}</div>
                        <div class="verdict">판단: ${esc(block.verdict || '')}</div></div>
                    </div>`
                 : `<div class="entry"><div class="verdict">❌ "${esc(block.query)}" — ${esc(block.error || block.status)}</div></div>`,
             )
             .join('')}</div>`
        : ''
    }

    <div class="preview">${draft.previewHtml}</div>`;
}

$('#draftDetail').addEventListener('click', async (event) => {
  const { publish, dry, images, revise, delDraft } = event.target.dataset;
  const category = $('#draftCategory')?.value.trim() || '';
  const visibility = $('#draftVisibility')?.value || 'public';

  try {
    if (publish || dry) {
      const id = publish || dry;
      if (publish && !confirm('네이버 블로그에 실제로 발행합니다. 계속할까요?')) return;
      const { job } = await api(`/drafts/${id}/publish`, {
        method: 'POST',
        body: { category, visibility, dryRun: Boolean(dry) },
      });
      watchJob(job);
    }
    if (images) {
      const { job } = await api(`/drafts/${images}/images`, { method: 'POST' });
      watchJob(job);
    }
    if (revise) {
      const instruction = prompt('어떻게 고칠까요? (예: 도입부를 더 짧게, 표 대신 목록으로)');
      if (!instruction) return;
      const { job } = await api(`/drafts/${revise}/revise`, { method: 'POST', body: { instruction } });
      watchJob(job);
    }
    if (delDraft) {
      if (!confirm('이 초안을 삭제할까요?')) return;
      await api(`/drafts/${delDraft}`, { method: 'DELETE' });
      state.selectedDraft = null;
      $('#draftDetail').innerHTML = '<div class="empty">왼쪽에서 초안을 선택하세요.</div>';
      loadDrafts();
    }
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ── 발행 기록 ───────────────────────────────────────────────────────────
async function loadPublications() {
  const items = await api('/publications').catch(() => []);
  $('#pubList').innerHTML = items.length
    ? items
        .map(
          (pub) => `
        <article class="item">
          <h3>${esc(pub.title)}</h3>
          <div class="meta">
            <span class="badge ${pub.dryRun ? '' : 'published'}">${pub.dryRun ? '연습' : '발행됨'}</span>
            <span>${new Date(pub.createdAt).toLocaleString('ko-KR')}</span>
            <span>· 이미지 ${pub.imagesInserted || 0}장</span>
            ${pub.url ? `· <a href="${esc(pub.url)}" target="_blank" rel="noopener">글 보기</a>` : ''}
            ${pub.screenshot ? `· <a href="/api/screenshots/${esc(pub.screenshot)}" target="_blank" rel="noopener">화면 캡처</a>` : ''}
          </div>
        </article>`,
        )
        .join('')
    : '<div class="empty">아직 발행 기록이 없습니다.</div>';
}

// ── 설정 ────────────────────────────────────────────────────────────────
const FIELDS = [
  { key: 'blogId', label: '네이버 블로그 아이디', type: 'text', note: 'blog.naver.com/<b>아이디</b>' },
  { key: 'model', label: '글쓰기 모델', type: 'select', options: ['sonnet', 'opus', 'haiku'] },
  { key: 'visionModel', label: '이미지 판독 모델', type: 'select', options: ['sonnet', 'opus', 'haiku'] },
  { key: 'tone', label: '글의 톤', type: 'text', wide: true },
  { key: 'targetLength', label: '목표 분량 (자)', type: 'number' },
  { key: 'topicCount', label: '한 번에 뽑을 글감 수', type: 'number' },
  { key: 'newsPerKeyword', label: '키워드당 뉴스 수집 수', type: 'number' },
  { key: 'blogsPerKeyword', label: '키워드당 블로그 수집 수', type: 'number' },
  { key: 'sourcesPerTopic', label: '글 1편당 참고할 원문 수', type: 'number' },
  { key: 'imagesPerPost', label: '글 1편당 이미지 수', type: 'number' },
  { key: 'imageCandidates', label: '이미지 후보 수 (자리당)', type: 'number' },
  { key: 'imageMinScore', label: 'AI 이미지 합격 점수', type: 'number', note: '0~100. 이 점수 미만이면 본문에서 뺍니다.' },
  { key: 'defaultVisibility', label: '기본 공개 범위', type: 'select', options: ['public', 'neighbor', 'private'] },
  { key: 'defaultCategory', label: '기본 카테고리', type: 'text' },
  { key: 'unsplashAccessKey', label: 'Unsplash Access Key (선택)', type: 'password' },
  { key: 'pexelsApiKey', label: 'Pexels API Key (선택)', type: 'password' },
  { key: 'headless', label: '발행 시 브라우저 숨기기', type: 'checkbox' },
  { key: 'slowMo', label: '조작 간 지연 (ms)', type: 'number', note: '너무 빠르면 네이버가 입력을 놓칩니다. 100~200 권장.' },
];

async function renderSettings() {
  state.settings = await api('/settings');
  $('#settingsForm').innerHTML = FIELDS.map((field) => {
    const value = state.settings[field.key];
    let input;
    if (field.type === 'select') {
      input = `<select name="${field.key}">${field.options
        .map((option) => `<option value="${option}"${String(value) === option ? ' selected' : ''}>${option}</option>`)
        .join('')}</select>`;
    } else if (field.type === 'checkbox') {
      input = `<label class="check"><input type="checkbox" name="${field.key}"${value ? ' checked' : ''}> 사용</label>`;
    } else {
      input = `<input type="${field.type}" name="${field.key}" value="${esc(value ?? '')}">`;
    }
    return `<div class="field${field.wide ? ' wide' : ''}"><label>${field.label}</label>${input}${
      field.note ? `<div class="note">${field.note}</div>` : ''
    }</div>`;
  }).join('');

  // 이미지 소스는 다중 선택이라 따로 붙인다.
  const sources = state.settings.imageSources || [];
  $('#settingsForm').insertAdjacentHTML(
    'beforeend',
    `<div class="field wide"><label>이미지 검색 소스</label><div class="row">${['openverse', 'wikimedia', 'unsplash', 'pexels']
      .map(
        (source) =>
          `<label class="check"><input type="checkbox" data-source="${source}"${
            sources.includes(source) ? ' checked' : ''
          }> ${source}</label>`,
      )
      .join('')}</div><div class="note">openverse·wikimedia 는 키 없이 바로 쓸 수 있습니다.</div></div>`,
  );
}

$('#settingsSave').addEventListener('click', async () => {
  const form = $('#settingsForm');
  const patch = {};
  for (const field of FIELDS) {
    const el = form.querySelector(`[name="${field.key}"]`);
    if (!el) continue;
    if (field.type === 'checkbox') patch[field.key] = el.checked;
    else if (field.type === 'number') patch[field.key] = Number(el.value);
    else patch[field.key] = el.value;
  }
  patch.imageSources = $$('[data-source]', form)
    .filter((el) => el.checked)
    .map((el) => el.dataset.source);

  try {
    await api('/settings', { method: 'PUT', body: patch });
    toast('설정을 저장했습니다.');
    renderSettings();
    loadStatus();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ── 로그 콘솔 ───────────────────────────────────────────────────────────
function appendLog(entry) {
  const body = $('#logBody');
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
  const line = document.createElement('div');
  line.className = `log-line ${entry.level}`;
  line.innerHTML = `<span class="t">${entry.ts.slice(11, 19)}</span><span class="s">${esc(entry.scope)}</span><span class="m">${esc(
    entry.message,
  )}</span>`;
  body.append(line);
  while (body.childElementCount > 500) body.firstElementChild.remove();
  if (atBottom) body.scrollTop = body.scrollHeight;
}

$('#logToggle').addEventListener('click', () => {
  const collapsed = $('#console').classList.toggle('collapsed');
  $('#logToggle').textContent = collapsed ? '펼치기' : '접기';
});
$('#logClear').addEventListener('click', () => {
  $('#logBody').innerHTML = '';
});

function connectEvents() {
  const source = new EventSource('/api/events');
  source.addEventListener('log', (event) => appendLog(JSON.parse(event.data)));
  source.addEventListener('event', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.job) onJobUpdate(payload.job);
    if (payload.type === 'login:success' || payload.type === 'login:cleared') loadStatus();
  });
  source.onerror = () => {
    // EventSource 는 스스로 재연결한다. 끊긴 동안은 폴링으로 버틴다.
    source.close();
    setTimeout(connectEvents, 3000);
  };
}

// ── 시작 ────────────────────────────────────────────────────────────────
(async function boot() {
  const logs = await api('/logs?limit=120').catch(() => []);
  logs.forEach(appendLog);
  connectEvents();
  await loadStatus();
  await Promise.all([loadTopics(), loadDrafts(), loadPublications(), renderSettings()]);

  const running = state.status?.jobs?.find((job) => job.status === 'running');
  if (running) watchJob(running);

  const interest = state.settings?.interests?.[0] || '';
  $('#autoInterest').value = interest;
  $('#topicInterest').value = interest;

  setInterval(loadStatus, 30_000);
})();
