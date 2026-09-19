/**
 * 네이버 검색 결과의 마크업 "세대"별 표본.
 *
 * ⚠️ 이 표본은 실제 캡처가 아니라, 파서가 다루기로 한 구조를 손으로 재현한 것이다.
 * 파서의 분기(세대별 카드 선택자, 폴백, 잡음 제거, 중복 제거)가 의도대로 도는지
 * 확인하는 용도다.
 *
 * 실제 네이버 HTML 검증은 `npm run capture` 로 받아서 test/fixtures/naver/ 에
 * 저장하면 되고, naver-parse.test.js 가 그 파일들을 자동으로 함께 검사한다.
 */

/** 2020~2023년경의 뉴스 탭 구조. */
export const NEWS_LEGACY = `
<ul class="list_news">
  <li class="bx" id="sp_nws1"><div class="news_wrap api_ani_send">
    <a href="https://n.news.naver.com/mnews/article/001/0014000001" class="news_tit"
       title="원두 보관법 바꾸니 커피 맛이 달라졌다">원두 보관법 바꾸니 커피 맛이 달라졌다</a>
    <div class="news_info"><div class="info_group">
      <a href="https://media.naver.com/press/001" class="info press">테스트일보<i class="spnew ico_pick">언론사 선정</i></a>
      <span class="info">2시간 전</span>
    </div></div>
    <div class="news_dsc"><div class="dsc_wrap">
      <a href="#" class="api_txt_lines dsc_txt_wrap">전문가들은 밀폐와 온도 변화 차단이 핵심이라고 말한다. 개봉 후 2주 이내 소비를 권장했다.</a>
    </div></div>
  </div></li>
  <li class="bx" id="sp_nws2"><div class="news_wrap api_ani_send">
    <a href="https://n.news.naver.com/mnews/article/002/0002000002" class="news_tit">홈카페 시장, 3년 만에 두 배로</a>
    <div class="news_info"><div class="info_group">
      <a href="https://media.naver.com/press/002" class="info press">커피경제</a>
      <span class="info">2026.09.18.</span>
    </div></div>
    <div class="news_dsc"><div class="dsc_wrap"><a class="api_txt_lines dsc_txt_wrap">가정용 에스프레소 머신 판매가 크게 늘었다.</a></div></div>
  </div></li>
</ul>`;

/** 최근 개편된 sds-comps 계열 구조. 바깥 컨테이너가 카드와 같은 클래스를 공유한다. */
export const NEWS_MODERN = `
<div class="sds-comps-base-layout sds-comps-full-layout" id="outer-wrapper">
  <div class="sds-comps-base-layout sds-comps-full-layout">
    <div class="sds-comps-profile">
      <a href="https://media.naver.com/press/011"><span class="sds-comps-profile-info-title-text">모던일보</span></a>
      <span class="sds-comps-profile-info-subtext">3시간 전</span>
    </div>
    <a href="https://n.news.naver.com/mnews/article/011/0011000001">
      <span class="sds-comps-text sds-comps-text-type-headline1">커피 산패를 늦추는 네 가지 방법</span></a>
    <a href="https://n.news.naver.com/mnews/article/011/0011000001">
      <span class="sds-comps-text sds-comps-text-type-body1">산소, 빛, 습기, 온도 변화가 원두를 상하게 하는 주범으로 꼽힌다.</span></a>
  </div>
  <div class="sds-comps-base-layout sds-comps-full-layout">
    <div class="sds-comps-profile">
      <a href="https://media.naver.com/press/012"><span class="sds-comps-profile-info-title-text">라이프뉴스</span></a>
      <span class="sds-comps-profile-info-subtext">어제</span>
    </div>
    <a href="https://n.news.naver.com/mnews/article/012/0012000002">
      <span class="sds-comps-text sds-comps-text-type-headline1">냉동 보관, 소분이 관건인 이유</span></a>
    <a href="https://n.news.naver.com/mnews/article/012/0012000002">
      <span class="sds-comps-text sds-comps-text-type-body1">한 번에 꺼내 쓸 만큼만 나눠 담아야 한다는 조언이 나온다.</span></a>
  </div>
</div>`;

/** 알려진 어떤 세대에도 걸리지 않는 구조 — 폴백이 받아 줘야 한다. */
export const NEWS_UNKNOWN = `
<main><section class="brand-new-layout-2027">
  <article><a href="https://n.news.naver.com/mnews/article/099/0099000001">완전히 새로운 레이아웃의 뉴스 제목입니다</a></article>
  <article><a href="https://n.news.naver.com/mnews/article/099/0099000002">두 번째 새로운 레이아웃 뉴스 제목입니다</a></article>
  <nav><a href="https://n.news.naver.com/mnews/hotissue">연예</a></nav>
</section></main>`;

/** 광고·연관검색어 등 잡음이 섞인 뉴스 결과. */
export const NEWS_NOISY = `
<ul class="list_news">
  <li class="bx"><div class="news_wrap api_ani_send">
    <a href="https://adcr.naver.com/adcr?x=abc" class="news_tit">광고</a>
  </div></li>
  <li class="bx"><div class="news_wrap api_ani_send">
    <a href="https://n.news.naver.com/mnews/article/003/0003000003" class="news_tit">정상적인 기사 제목입니다</a>
    <div class="news_info"><div class="info_group">
      <a href="#" class="info press">정상일보</a><span class="info">1일 전</span></div></div>
  </div></li>
  <li class="bx"><div class="news_wrap api_ani_send">
    <a href="https://n.news.naver.com/mnews/article/003/0003000003" class="news_tit">정상적인 기사 제목입니다</a>
  </div></li>
</ul>`;

/** 2020~2023년경의 블로그 탭 구조. */
export const BLOG_LEGACY = `
<ul class="lst_total">
  <li class="bx _svp_item"><div class="view_wrap">
    <div class="user_info">
      <a href="https://blog.naver.com/homecafe" class="name">홈카페러</a>
      <span class="sub">2026.09.10.</span>
    </div>
    <div class="title_area">
      <a href="https://blog.naver.com/homecafe/223000111" class="title_link">원두 3개월 써보고 남기는 보관 후기</a>
    </div>
    <div class="dsc_area">
      <a href="https://blog.naver.com/homecafe/223000111" class="dsc_link">상온 밀폐용기와 냉동 소분을 나란히 두고 비교해 봤습니다. 향 유지에는 소분 냉동이 나았습니다.</a>
    </div>
  </div></li>
  <li class="bx _svp_item"><div class="view_wrap">
    <div class="user_info"><a href="https://bean.tistory.com" class="name">빈스</a><span class="sub">2026.08.29.</span></div>
    <div class="title_area"><a href="https://bean.tistory.com/42" class="title_link">에스프레소 머신 3종 비교기</a></div>
    <div class="dsc_area"><a href="#" class="dsc_link">가정용 머신을 직접 써 보고 정리했습니다.</a></div>
  </div></li>
</ul>`;

export const BLOG_MODERN = `
<div class="sds-comps-base-layout sds-comps-full-layout">
  <div class="sds-comps-profile">
    <a href="https://blog.naver.com/modernbean"><span class="sds-comps-profile-info-title-text">모던빈</span></a>
    <span class="sds-comps-profile-info-subtext">1일 전</span>
  </div>
  <a href="https://blog.naver.com/modernbean/223999001">
    <span class="sds-comps-text sds-comps-text-type-headline1">드립 커피 입문 6개월 기록</span></a>
  <a href="https://blog.naver.com/modernbean/223999001">
    <span class="sds-comps-text sds-comps-text-type-body1">그라인더부터 물 온도까지 바꿔 가며 남긴 기록입니다.</span></a>
</div>`;

/** 카드는 있지만 제목 링크가 블로그가 아닌 경우 — 걸러져야 한다. */
export const BLOG_OFFSITE = `
<ul class="lst_total">
  <li class="bx _svp_item"><div class="view_wrap">
    <div class="title_area"><a href="https://search.naver.com/search.naver?query=원두" class="title_link">연관 검색어 더보기</a></div>
  </div></li>
  <li class="bx _svp_item"><div class="view_wrap">
    <div class="user_info"><a href="https://blog.naver.com/real" class="name">진짜블로거</a></div>
    <div class="title_area"><a href="https://blog.naver.com/real/223777001" class="title_link">진짜 블로그 글 제목</a></div>
  </div></li>
</ul>`;

export const BLOG_UNKNOWN = `
<main><div class="unknown-2027">
  <a href="https://blog.naver.com/future/224000001">미래 레이아웃 블로그 글 제목</a>
  <a href="https://blog.naver.com/future">홈</a>
</div></main>`;

/**
 * 2026-09 실제 캡처에서 확인된 구조.
 *
 * 핵심: 언론사·날짜를 담은 `sds-comps-profile` 은 제목이 들어 있는
 * `sds-comps-base-layout` 의 **형제**다. 감싸는 컨테이너의 클래스는 해시라서
 * (v33RoPVqTTc4AJaM) 선택자로 박을 수 없다. 제목에서 위로 올라가 찾아야 한다.
 * 제목·출처 링크 끝에는 낭독기용 "새 창 열림" 이 붙어 나온다.
 */
export const NEWS_SDS_2026 = `
<div id="main_pack"><div class="sds-comps-vertical-layout sds-comps-full-layout fds-news-item-list-tab">

  <div class="sds-comps-vertical-layout sds-comps-full-layout v33RoPVqTTc4AJaM">
    <div class="sds-comps-horizontal-layout sds-comps-full-layout sds-comps-profile type-basic">
      <div class="sds-comps-horizontal-layout sds-comps-inline-layout sds-comps-profile-source">
        <div class="sds-comps-horizontal-layout sds-comps-inline-layout sds-comps-profile-info-title">
          <span class="sds-comps-text sds-comps-text-ellipsis-1 sds-comps-text-type-body2">
            <a class="fender-ui_a82de4df" href="https://media.naver.com/press/015">한국경제</a></span>
        </div>
        <div class="sds-comps-horizontal-layout sds-comps-inline-layout sds-comps-profile-info-subtexts">
          <span class="sds-comps-text sds-comps-text-type-body2 sds-comps-profile-info-subtext">6시간 전</span>
          <span class="sds-comps-text sds-comps-text-type-body2 sds-comps-profile-info-subtext">
            <a class="fender-ui_a82de4df hoUJt4M_1EFcn64D" href="https://n.news.naver.com/mnews/article/015/0005193000">네이버뉴스<span class="blind">새 창 열림</span></a></span>
        </div>
      </div>
    </div>
    <div class="sds-comps-base-layout sds-comps-full-layout">
      <div class="sds-comps-vertical-layout sds-comps-full-layout">
        <a class="fender-ui_a82de4df" title="북적이는 축제속 고요한 커피머신 작동음…카누가 만든 홈카페 [2026청춘커피페스티벌]" href="https://www.hankyung.com/article/202609195237i">
          <span class="sds-comps-text sds-comps-text-type-headline1">북적이는 축제속 고요한 커피머신 작동음…카누가 만든 홈카페 [2026청춘...</span><span class="blind">새 창 열림</span></a>
        <a class="fender-ui_a82de4df" href="https://www.hankyung.com/article/202609195237i">
          <span class="sds-comps-text sds-comps-text-type-body1">기존 캡슐보다 1.7배 많은 9.5g의 원두를 전용 용기에 담아냈다.</span></a>
      </div>
    </div>
  </div>

  <div class="sds-comps-vertical-layout sds-comps-full-layout v33RoPVqTTc4AJaM">
    <div class="sds-comps-horizontal-layout sds-comps-full-layout sds-comps-profile type-basic">
      <div class="sds-comps-horizontal-layout sds-comps-inline-layout sds-comps-profile-source">
        <div class="sds-comps-horizontal-layout sds-comps-inline-layout sds-comps-profile-info-title">
          <span class="sds-comps-text sds-comps-text-type-body2"><a href="https://media.naver.com/press/018">에너지경제</a></span>
        </div>
        <div class="sds-comps-horizontal-layout sds-comps-inline-layout sds-comps-profile-info-subtexts">
          <span class="sds-comps-text sds-comps-text-type-body2 sds-comps-profile-info-subtext">2026.09.19.</span>
        </div>
      </div>
    </div>
    <div class="sds-comps-base-layout sds-comps-full-layout">
      <div class="sds-comps-vertical-layout sds-comps-full-layout">
        <a href="https://www.ekn.kr/web/view.php?key=20260919027564379">
          <span class="sds-comps-text sds-comps-text-type-headline1">추석 선물, 취향 저격 홈카페 용품이 뜬다</span><span class="blind">새 창 열림</span></a>
        <a href="https://www.ekn.kr/web/view.php?key=20260919027564379">
          <span class="sds-comps-text sds-comps-text-type-body1">10만원 안팎의 작은 머신부터 우유 스팀 기능을 갖춘 제품까지.</span></a>
      </div>
    </div>
  </div>

</div></div>`;

export const BLOG_SDS_2026 = `
<div id="main_pack"><div class="sds-comps-vertical-layout sds-comps-full-layout fds-ugc-single-intention-item-list-tab">

  <div class="sds-comps-vertical-layout sds-comps-full-layout nrOx_btSWTA8aZLR">
    <div class="sds-comps-vertical-layout sds-comps-full-layout A5Z8LBOa3AtkVTtc _fe_view_power_content">
      <div class="sds-comps-horizontal-layout sds-comps-full-layout sds-comps-profile type-basic">
        <div class="sds-comps-horizontal-layout sds-comps-inline-layout sds-comps-profile-source">
          <div class="sds-comps-horizontal-layout sds-comps-inline-layout sds-comps-profile-info-title">
            <span class="sds-comps-text sds-comps-text-ellipsis sds-comps-text-ellipsis-1 sds-comps-text-type-body2">
              <a class="fender-ui_a82de4df fender-ui_475445f0" href="https://blog.naver.com/sina1310">우당탕탕 지구여행<span class="blind">새 창 열림</span></a></span>
          </div>
          <div class="sds-comps-horizontal-layout sds-comps-inline-layout sds-comps-profile-info-subtexts">
            <span class="sds-comps-text sds-comps-text-type-body2 sds-comps-profile-info-subtext">3일 전</span>
          </div>
        </div>
      </div>
      <div class="sds-comps-vertical-layout sds-comps-full-layout WLbzTADKKK803lX9">
        <div class="sds-comps-base-layout sds-comps-full-layout HgcVGkusjngBkaeZ">
          <div class="sds-comps-vertical-layout sds-comps-full-layout caO6YazRLWkrKrW3">
            <a class="fender-ui_a82de4df Fgpgc4i25zYbDnpH" href="https://blog.naver.com/sina1310/224413619068">
              <span class="sds-comps-text sds-comps-text-type-headline1">홈카페 원두 추천 커피 입문자라면 그냥 외우세요</span><span class="blind">새 창 열림</span></a>
            <a href="https://blog.naver.com/sina1310/224413619068">
              <span class="sds-comps-text sds-comps-text-type-body1">고소한 커피의 풍미, 풍성하고 쫀득한 크레마를 찾는다면.</span></a>
          </div>
        </div>
        <div class="sds-comps-base-layout sds-comps-full-layout">
          <img src="thumb.jpg" alt="">
        </div>
      </div>
    </div>
  </div>

  <div class="sds-comps-vertical-layout sds-comps-full-layout nrOx_btSWTA8aZLR">
    <div class="sds-comps-vertical-layout sds-comps-full-layout A5Z8LBOa3AtkVTtc _fe_view_power_content">
      <div class="sds-comps-horizontal-layout sds-comps-full-layout sds-comps-profile type-basic">
        <div class="sds-comps-horizontal-layout sds-comps-inline-layout sds-comps-profile-source">
          <div class="sds-comps-horizontal-layout sds-comps-inline-layout sds-comps-profile-info-title">
            <span class="sds-comps-text sds-comps-text-type-body2"><a href="https://blog.naver.com/tennislee-">테니스리</a></span>
          </div>
          <div class="sds-comps-horizontal-layout sds-comps-inline-layout sds-comps-profile-info-subtexts">
            <span class="sds-comps-text sds-comps-text-type-body2 sds-comps-profile-info-subtext">2026.09.01.</span>
          </div>
        </div>
      </div>
      <div class="sds-comps-vertical-layout sds-comps-full-layout WLbzTADKKK803lX9">
        <div class="sds-comps-base-layout sds-comps-full-layout HgcVGkusjngBkaeZ">
          <div class="sds-comps-vertical-layout sds-comps-full-layout caO6YazRLWkrKrW3">
            <a href="https://blog.naver.com/tennislee-/224394886019">
              <span class="sds-comps-text sds-comps-text-type-headline1">홈카페 원두 추천 실패 없는 에스프레소 베스트</span><span class="blind">새 창 열림</span></a>
            <a href="https://blog.naver.com/tennislee-/224394886019">
              <span class="sds-comps-text sds-comps-text-type-body1">내 추출 기구와 취향에 맞는 원두를 찾는 방법입니다.</span></a>
          </div>
        </div>
      </div>
    </div>
  </div>

</div></div>`;
