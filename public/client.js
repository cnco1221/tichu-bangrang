const socket = io();
const app = document.getElementById("app");
const APP_VERSION = "0.34"; // 수정할 때마다 0.01씩 올림

let myName = localStorage.getItem("tichu_name") || "";
let myToken = localStorage.getItem("tichu_token");
if (!myToken) {
  myToken = "t_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2);
  localStorage.setItem("tichu_token", myToken);
}
let loggedInAs = null; // 로그인한 회원 닉네임(로그인해야 방 생성/입장 가능, 관전은 게스트도 가능)
let myStats = null; // { nickname, wins, losses, rank }
let isAdminMode = false;

function setStoredSession(nickname, sessionToken) {
  if (nickname && sessionToken) {
    localStorage.setItem("tichu_session_nickname", nickname);
    localStorage.setItem("tichu_session_token", sessionToken);
  } else {
    localStorage.removeItem("tichu_session_nickname");
    localStorage.removeItem("tichu_session_token");
  }
}

function fetchMyStats(rerender) {
  if (!loggedInAs) { myStats = null; if (rerender) render(); return; }
  socket.emit("getRanking", null, (res) => {
    if (!res) return;
    const ranked = res.ranked || [], unranked = res.unranked || [];
    // "내 정보"의 승/패는 시즌초기화의 영향을 받지 않는 평생 누적 기록(lifetimeWins/lifetimeLosses)을 씀.
    // 순위(rank)는 시즌 랭킹 기준.
    const idx = ranked.findIndex((r) => r.nickname === loggedInAs);
    if (idx !== -1) {
      myStats = { nickname: loggedInAs, wins: ranked[idx].lifetimeWins, losses: ranked[idx].lifetimeLosses, rank: idx + 1 };
    } else {
      const u = unranked.find((r) => r.nickname === loggedInAs);
      myStats = { nickname: loggedInAs, wins: u ? u.lifetimeWins : 0, losses: u ? u.lifetimeLosses : 0, rank: "X" };
    }
    if (rerender) render();
  });
}
let myRoom = localStorage.getItem("tichu_room") || "";
let mySeat = null;
let isSpectator = false;
let state = null;
let selected = new Set();
let exchangeStage = { left: null, across: null, right: null };
let exchangeSelectedCardId = null;
let toastTimer = null;
let menuOpen = false;
let chatOpen = false;
let chatMessages = [];
let globalChatOpen = false;
let globalChatMessages = [];
let confirmPending = {}; // key -> timeoutId, 라지/스몰티츄 2번 눌러야 확정되는 데 씀
let timerTickHandle = null;

const RANK_LABEL = { 1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10", 11: "J", 12: "Q", 13: "K", 14: "A" };
const SUIT_SYMBOL = { jade: "◆", sword: "▲", pagoda: "●", star: "★" };
const SUIT_COLOR = { jade: "#2e8b6f", sword: "#a33b35", pagoda: "#b5892f", star: "#3b5e9c" };
const TEAM_OF_SEAT = [0, 1, 0, 1];

// 방을 나갈 때 소켓 연결은 그대로 유지해서(로그인 세션 안 끊기게) 방에서만 빠짐
function leaveCurrentRoom() {
  socket.emit("leaveRoom", null, () => {
    mySeat = null;
    isSpectator = false;
    myRoom = null;
    state = null;
    document.body.classList.remove("tichu-large-bg", "tichu-small-bg"); // 방 나갈 때 티츄 배경색 원상복구
    localStorage.removeItem("tichu_room");
    render();
  });
}

function showToast(msg) {
  clearTimeout(toastTimer);
  let el = document.querySelector(".toast");
  if (!el) { el = document.createElement("div"); el.className = "toast"; document.body.appendChild(el); }
  el.textContent = msg;
  toastTimer = setTimeout(() => el.remove(), 2600);
}

// 2번 눌러야 확정되는 버튼(라지/스몰티츄) 공용 헬퍼. 처음 누르면 대기 상태로 바뀌고,
// 3초 안에 다시 누르면 실제 액션 실행. 3초 지나면 대기 상태가 풀림.
function handleDoubleConfirm(key, action) {
  if (confirmPending[key]) {
    clearTimeout(confirmPending[key]);
    delete confirmPending[key];
    action();
  } else {
    confirmPending[key] = setTimeout(() => { delete confirmPending[key]; render(); }, 3000);
  }
  render();
}

// 용/봉황/개/새 카드 이미지: public/images/cards/{name}.png 가 있으면 그걸 쓰고,
// 없거나 로드 실패하면 이모지로 자동 대체(onerror)한다.
function specialIconHTML(name, fallbackEmoji) {
  return `<div class="center-icon">
    <img src="images/cards/${name}.png" alt="${fallbackEmoji}" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'center-icon-fallback',textContent:'${fallbackEmoji}'}))" />
  </div>`;
}

function cardHTML(card, { small = false, isSelected = false, isPicking = false } = {}) {
  const cls = ["card"];
  if (small) cls.push("small");
  if (card.special) cls.push(`special-${card.special}`);
  if (isSelected) cls.push("selected");
  if (isPicking) cls.push("picking");

  if (card.special === "sparrow") {
    return `<div class="${cls.join(" ")}" data-id="${card.id}">
      <div class="corner-tl">1</div>
      ${specialIconHTML("sparrow", "🐦")}
      <div class="corner-br">1</div>
    </div>`;
  }
  if (card.special === "dragon") {
    return `<div class="${cls.join(" ")}" data-id="${card.id}">
      ${specialIconHTML("dragon", "🐉")}
      <div class="suit" style="color:#8a5a1a">용</div>
    </div>`;
  }
  if (card.special === "phoenix") {
    return `<div class="${cls.join(" ")}" data-id="${card.id}">
      ${specialIconHTML("phoenix", "🔥")}
      <div class="suit" style="color:#a33b35">봉황</div>
    </div>`;
  }
  if (card.special === "dog") {
    return `<div class="${cls.join(" ")}" data-id="${card.id}">
      ${specialIconHTML("dog", "🐕")}
      <div class="suit" style="color:#3a6b57">개</div>
    </div>`;
  }
  const rankTxt = RANK_LABEL[card.rank], suitTxt = SUIT_SYMBOL[card.suit], color = SUIT_COLOR[card.suit];
  return `<div class="${cls.join(" ")}" data-id="${card.id}">
    <div class="rank">${rankTxt}</div>
    <div class="suit" style="color:${color}">${suitTxt}</div>
  </div>`;
}

const FOCUS_PRESERVE_IDS = ["chatInput", "globalChatInput", "nameInput", "codeInput"];

function render() {
  document.querySelectorAll(".chat-bubble-overlay").forEach((el) => el.remove());
  if (!state || state.phase !== "exchange") {
    const exModal = document.querySelector(".floating-panel-wrap.exchange-modal");
    if (exModal) exModal.remove();
  }
  if (!exchangeSummaryVisible) {
    const sumModal = document.querySelector(".modal-backdrop.summary-modal");
    if (sumModal) sumModal.remove();
  }
  if (!state || state.phase !== "roundEnd") {
    const rsModal = document.querySelector(".floating-panel-wrap.round-summary-modal");
    if (rsModal) rsModal.remove();
  }
  if (timerTickHandle && (!state || state.phase !== "play")) { clearInterval(timerTickHandle); timerTickHandle = null; }
  if (exchangeTimerTickHandle && (!state || state.phase !== "exchange")) { clearInterval(exchangeTimerTickHandle); exchangeTimerTickHandle = null; }
  if (roundEndTimerTickHandle && (!state || state.phase !== "roundEnd")) { clearInterval(roundEndTimerTickHandle); roundEndTimerTickHandle = null; }
  if (grandTimerTickHandle && (!state || state.phase !== "grand")) { clearInterval(grandTimerTickHandle); grandTimerTickHandle = null; }

  // 게임 상태가 자주 갱신돼도(다른 플레이어/봇 행동 등) 채팅 입력창 포커스/커서/내용이 안 날아가게 보존
  const active = document.activeElement;
  let saved = null;
  if (active && FOCUS_PRESERVE_IDS.includes(active.id)) {
    saved = { id: active.id, value: active.value, selStart: active.selectionStart, selEnd: active.selectionEnd };
  }

  runRenderDispatch();

  if (saved) {
    const el = document.getElementById(saved.id);
    if (el) {
      el.value = saved.value;
      el.focus({ preventScroll: true });
      try { el.setSelectionRange(saved.selStart, saved.selEnd); } catch (e) { /* 일부 input 타입은 지원 안 함 */ }
    }
  }
}

function runRenderDispatch() {
  if (!state) return renderLanding();
  if (state.phase === "lobby") return renderLobby();
  if (state.phase === "grand") return renderGrand();
  if (state.phase === "exchange") return renderExchange();
  if (state.phase === "play") return exchangeSummaryVisible ? renderExchangeSummary() : renderPlay();
  if (state.phase === "roundEnd") return renderRoundEnd();
  if (state.phase === "gameover") return renderGameOver();
  if (state.phase === "aborted") return renderAborted();
}

/* ---------------- Landing ---------------- */
function renderLanding() {
  app.innerHTML = `
    <div class="landing">
      <div class="cards-row">
        <div class="suit-chip" style="color:${SUIT_COLOR.jade}">◆</div>
        <div class="suit-chip" style="color:${SUIT_COLOR.sword}">▲</div>
        <div class="suit-chip" id="seasonModeBtn" style="color:${SUIT_COLOR.pagoda}; cursor:pointer;">●</div>
        <div class="suit-chip" id="adminModeBtn" style="color:${SUIT_COLOR.star}; cursor:pointer;">★</div>
      </div>
      <div class="title accent">방랑단 티츄</div>
      ${loggedInAs
        ? `<div class="my-info-box">
            <div class="my-info-row"><span class="label">닉네임</span><span class="value">${escapeHtml(loggedInAs)}</span></div>
            <div class="my-info-row"><span class="label">승 / 패</span><span class="value">${myStats ? `${myStats.wins} / ${myStats.losses}` : "-"}</span></div>
            <div class="my-info-row"><span class="label">랭킹</span><span class="value">${myStats ? myStats.rank : "-"}</span></div>
            <button class="small ghost" id="logoutBtn" style="margin-top:2px;">로그아웃</button>
          </div>
          <button class="primary" id="createBtn">새 방 만들기</button>`
        : `<div class="my-info-box">
            <div class="status-line">게임을 하려면 로그인이 필요해요</div>
            <div class="hand-actions">
              <button class="small primary" id="openLoginBtn">로그인</button>
              <button class="small ghost" id="openSignupBtn">회원가입</button>
            </div>
          </div>`}
      <div class="room-list-wrap">
        <div class="room-list-header">
          <span>열려있는 방 (${openRooms.length})</span>
          <button class="small ghost" id="refreshRoomsBtn">새로고침</button>
        </div>
        <div class="room-list">
          ${openRooms.length
            ? openRooms.map((r) => `<div class="room-list-row">
                <div class="room-list-info">${r.code} · ${r.playerCount}/4명${r.spectatorCount ? ` · 관전${r.spectatorCount}` : ""}</div>
                <div class="room-list-btns">
                  <button class="small primary" data-join="${r.code}" ${loggedInAs ? "" : "disabled"}>입장</button>
                  <button class="small ghost" data-spectate="${r.code}">관전 입장</button>
                </div>
              </div>`).join("")
            : `<div class="hint">참가 가능한 방이 없어요</div>`}
        </div>
      </div>
      <button class="ghost" id="openRankingBtn">🏆 랭킹</button>
    </div>
    <div class="version-badge">v${APP_VERSION}</div>
    <button class="chat-fab icon-btn" id="globalChatFab">💬</button>
    ${globalChatOpen ? renderGlobalChatPanel() : ""}
  `;
  if (!roomListFetched) { roomListFetched = true; fetchRoomList(true); }
  if (loggedInAs && !myStats) fetchMyStats(true);
  document.getElementById("globalChatFab").onclick = () => { globalChatOpen = !globalChatOpen; render(); };
  wireGlobalChatPanel();
  document.getElementById("adminModeBtn").onclick = () => openAdminLoginModal();
  document.getElementById("seasonModeBtn").onclick = () => openSeasonLoginModal();
  document.getElementById("openRankingBtn").onclick = () => openRankingModal();
  const openLoginBtn = document.getElementById("openLoginBtn");
  if (openLoginBtn) openLoginBtn.onclick = () => openLoginModal();
  const openSignupBtn = document.getElementById("openSignupBtn");
  if (openSignupBtn) openSignupBtn.onclick = () => openSignupModal();
  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) logoutBtn.onclick = () => { socket.emit("logout"); loggedInAs = null; myStats = null; setStoredSession(null, null); render(); };
  const createBtn = document.getElementById("createBtn");
  if (createBtn) createBtn.onclick = () => {
    socket.emit("createRoom", { name: loggedInAs, token: myToken }, (res) => {
      if (res.error) return showToast(res.error);
      mySeat = res.seat; myRoom = res.code; isSpectator = false;
      localStorage.setItem("tichu_room", myRoom);
    });
  };
  const doJoin = (asSpectator, code) => {
    socket.emit("joinRoom", { code, name: loggedInAs || "관전자", asSpectator, token: myToken }, (res) => {
      if (res.error) return showToast(res.error);
      mySeat = res.seat; myRoom = res.code; isSpectator = !!res.spectator;
      localStorage.setItem("tichu_room", myRoom);
    });
  };
  document.getElementById("refreshRoomsBtn").onclick = () => fetchRoomList(true);
  document.querySelectorAll("[data-join]").forEach((b) => b.onclick = () => doJoin(false, b.dataset.join));
  document.querySelectorAll("[data-spectate]").forEach((b) => b.onclick = () => doJoin(true, b.dataset.spectate));
}

let openRooms = [];
let roomListFetched = false;
function fetchRoomList(rerender) {
  socket.emit("listRooms", null, (res) => {
    openRooms = (res && res.rooms) || [];
    if (rerender && !state) render();
  });
}

/* ---------------- 로그인 / 회원가입 ---------------- */
function openLoginModal() {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal" style="max-width:280px;">
      <h3 class="accent" style="font-size:24px">로그인</h3>
      <input type="text" id="loginNickname" placeholder="닉네임" maxlength="10" />
      <input type="password" id="loginPassword" placeholder="비밀번호" />
      <label class="remember-row"><input type="checkbox" id="loginRemember" checked /> 로그인 상태 유지</label>
      <div class="hand-actions">
        <button class="primary" id="loginSubmitBtn">로그인</button>
        <button class="ghost" id="loginCancelBtn">취소</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  document.getElementById("loginCancelBtn").onclick = () => backdrop.remove();
  const submit = () => {
    const nickname = document.getElementById("loginNickname").value.trim();
    const password = document.getElementById("loginPassword").value;
    const remember = document.getElementById("loginRemember").checked;
    socket.emit("login", { nickname, password }, (res) => {
      if (res.error) return showToast(res.error);
      loggedInAs = res.nickname;
      myName = res.nickname;
      setStoredSession(remember ? res.nickname : null, remember ? res.sessionToken : null);
      backdrop.remove();
      fetchMyStats(true);
    });
  };
  document.getElementById("loginSubmitBtn").onclick = submit;
  document.getElementById("loginPassword").onkeydown = (e) => { if (e.key === "Enter") submit(); };
}

function openSignupModal() {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal" style="max-width:280px;">
      <h3 class="accent" style="font-size:24px">회원가입</h3>
      <input type="text" id="signupName" placeholder="방랑단 닉네임(회원 확인용)" maxlength="20" />
      <input type="text" id="signupNickname" placeholder="닉네임" maxlength="10" />
      <input type="password" id="signupPassword" placeholder="비밀번호" />
      <div class="status-line">가입 신청 후 관리자 승인이 필요해요</div>
      <div class="hand-actions">
        <button class="primary" id="signupSubmitBtn">가입 신청</button>
        <button class="ghost" id="signupCancelBtn">취소</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  document.getElementById("signupCancelBtn").onclick = () => backdrop.remove();
  document.getElementById("signupSubmitBtn").onclick = () => {
    const name = document.getElementById("signupName").value.trim();
    const nickname = document.getElementById("signupNickname").value.trim();
    const password = document.getElementById("signupPassword").value;
    socket.emit("signup", { name, nickname, password }, (res) => {
      if (res.error) return showToast(res.error);
      showToast("가입 신청 완료! 관리자 승인을 기다려주세요");
      backdrop.remove();
    });
  };
}

/* ---------------- 관리자모드 ---------------- */
function openAdminLoginModal() {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal" style="max-width:260px;">
      <h3 class="accent" style="font-size:24px">관리자모드</h3>
      <input type="password" id="adminPassword" placeholder="관리자 비밀번호" />
      <div class="hand-actions">
        <button class="primary" id="adminLoginSubmitBtn">입장</button>
        <button class="ghost" id="adminLoginCancelBtn">취소</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  document.getElementById("adminLoginCancelBtn").onclick = () => backdrop.remove();
  const submit = () => {
    const password = document.getElementById("adminPassword").value;
    socket.emit("adminLogin", { password }, (res) => {
      if (res.error) return showToast(res.error);
      isAdminMode = true;
      backdrop.remove();
      openAdminPanel("pending");
    });
  };
  document.getElementById("adminLoginSubmitBtn").onclick = submit;
  document.getElementById("adminPassword").onkeydown = (e) => { if (e.key === "Enter") submit(); };
}

function openAdminPanel(activeTab) {
  let backdrop = document.querySelector(".modal-backdrop.admin-panel");
  if (!backdrop) {
    backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop admin-panel";
    document.body.appendChild(backdrop);
  }
  const tabs = [
    { id: "members", label: "멤버 관리" },
    { id: "pending", label: "멤버 승인" },
    { id: "record", label: "전적" },
    { id: "password", label: "비밀번호 변경" },
  ];
  backdrop.innerHTML = `
    <div class="modal" style="max-width:360px;">
      <h3 class="accent" style="font-size:24px">관리자모드</h3>
      <div class="admin-tabs">${tabs.map((t) => `<button class="small ${activeTab === t.id ? "primary" : "ghost"}" data-tab="${t.id}">${t.label}</button>`).join("")}</div>
      <div id="adminTabContent"><div class="status-line">불러오는 중...</div></div>
      <button class="ghost" id="adminCloseBtn">닫기</button>
    </div>`;
  backdrop.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => openAdminPanel(b.dataset.tab));
  document.getElementById("adminCloseBtn").onclick = () => { backdrop.remove(); isAdminMode = false; };

  const content = document.getElementById("adminTabContent");
  if (activeTab === "pending") {
    socket.emit("adminListPending", null, (res) => {
      if (res.error) { content.innerHTML = `<div class="status-line">${res.error}</div>`; return; }
      content.innerHTML = res.pending.length
        ? res.pending.map((m) => `
            <div class="admin-row">
              <div>방랑단 닉네임: ${escapeHtml(m.name)}<br/>로그인 닉네임: ${escapeHtml(m.nickname)}</div>
              <div class="hand-actions">
                <button class="small primary" data-approve="${m.nickname}">승인</button>
                <button class="small danger" data-reject="${m.nickname}">거절</button>
              </div>
            </div>`).join("")
        : `<div class="status-line">승인 대기 중인 멤버가 없어요</div>`;
      content.querySelectorAll("[data-approve]").forEach((b) => b.onclick = () => {
        socket.emit("adminApprove", { nickname: b.dataset.approve }, (r) => { if (r.error) showToast(r.error); else openAdminPanel("pending"); });
      });
      content.querySelectorAll("[data-reject]").forEach((b) => b.onclick = () => {
        socket.emit("adminReject", { nickname: b.dataset.reject }, (r) => { if (r.error) showToast(r.error); else openAdminPanel("pending"); });
      });
    });
  } else if (activeTab === "members") {
    socket.emit("adminListMembers", null, (res) => {
      if (res.error) { content.innerHTML = `<div class="status-line">${res.error}</div>`; return; }
      content.innerHTML = res.members.length
        ? res.members.map((m) => `
            <div class="admin-row">
              <div>방랑단: ${escapeHtml(m.name)}<br/>게임닉: ${escapeHtml(m.nickname)}</div>
              <div class="hand-actions">
                <button class="small" data-resetpw="${m.nickname}">비번</button>
                <button class="small" data-renamenick="${m.nickname}">닉</button>
                <button class="small danger" data-delmember="${m.nickname}">삭제</button>
              </div>
            </div>`).join("")
        : `<div class="status-line">등록된 멤버가 없어요</div>`;
      content.querySelectorAll("[data-resetpw]").forEach((b) => b.onclick = () => {
        const newPw = prompt(`${b.dataset.resetpw}님의 새 비밀번호를 입력하세요`);
        if (!newPw) return;
        socket.emit("adminResetPassword", { nickname: b.dataset.resetpw, newPassword: newPw }, (r) => {
          if (r.error) showToast(r.error); else showToast("비밀번호가 변경됐어요");
        });
      });
      content.querySelectorAll("[data-renamenick]").forEach((b) => b.onclick = () => {
        const newNick = prompt(`${b.dataset.renamenick}님의 새 게임닉을 입력하세요`);
        if (!newNick) return;
        socket.emit("adminRenameNickname", { nickname: b.dataset.renamenick, newNickname: newNick }, (r) => {
          if (r.error) showToast(r.error); else { showToast("게임닉이 변경됐어요"); openAdminPanel("members"); }
        });
      });
      content.querySelectorAll("[data-delmember]").forEach((b) => b.onclick = () => {
        if (!confirm(`${b.dataset.delmember}님을 정말 삭제할까요?`)) return;
        socket.emit("adminDeleteMember", { nickname: b.dataset.delmember }, (r) => { if (r.error) showToast(r.error); else openAdminPanel("members"); });
      });
    });
  } else if (activeTab === "record") {
    socket.emit("adminListMembers", null, (res) => {
      if (res.error) { content.innerHTML = `<div class="status-line">${res.error}</div>`; return; }
      content.innerHTML = res.members.length
        ? res.members.map((m) => `
            <div class="admin-row">
              <div>${escapeHtml(m.nickname)}</div>
              <div class="hand-actions">
                <span class="chip">승</span>
                <input type="number" min="0" class="record-input" data-wins="${m.nickname}" value="${m.wins}" />
                <span class="chip">패</span>
                <input type="number" min="0" class="record-input" data-losses="${m.nickname}" value="${m.losses}" />
                <button class="small primary" data-saverecord="${m.nickname}">저장</button>
              </div>
            </div>`).join("")
        : `<div class="status-line">등록된 멤버가 없어요</div>`;
      content.querySelectorAll("[data-saverecord]").forEach((b) => b.onclick = () => {
        const nickname = b.dataset.saverecord;
        const wins = content.querySelector(`[data-wins="${nickname}"]`).value;
        const losses = content.querySelector(`[data-losses="${nickname}"]`).value;
        socket.emit("adminSetRecord", { nickname, wins, losses }, (r) => {
          if (r.error) showToast(r.error); else showToast(`${nickname}님 전적이 저장됐어요`);
        });
      });
    });
  } else if (activeTab === "password") {
    content.innerHTML = `
      <input type="password" id="newAdminPw" placeholder="새 관리자 비밀번호" />
      <button class="primary" id="changeAdminPwBtn" style="margin-top:8px;">변경</button>
    `;
    document.getElementById("changeAdminPwBtn").onclick = () => {
      const newPassword = document.getElementById("newAdminPw").value;
      socket.emit("adminChangePassword", { newPassword }, (r) => {
        if (r.error) showToast(r.error); else showToast("관리자 비밀번호가 변경됐어요");
      });
    };
  }
}

/* ---------------- 랭킹 시즌 설정 ---------------- */
function openSeasonLoginModal() {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal" style="max-width:260px;">
      <h3 class="accent" style="font-size:24px">시즌 설정</h3>
      <input type="password" id="seasonAdminPassword" placeholder="관리자 비밀번호" />
      <div class="hand-actions">
        <button class="primary" id="seasonLoginSubmitBtn">입장</button>
        <button class="ghost" id="seasonLoginCancelBtn">취소</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  document.getElementById("seasonLoginCancelBtn").onclick = () => backdrop.remove();
  const submit = () => {
    const password = document.getElementById("seasonAdminPassword").value;
    socket.emit("adminLogin", { password }, (res) => {
      if (res.error) return showToast(res.error);
      isAdminMode = true;
      backdrop.remove();
      openSeasonSettingsModal();
    });
  };
  document.getElementById("seasonLoginSubmitBtn").onclick = submit;
  document.getElementById("seasonAdminPassword").onkeydown = (e) => { if (e.key === "Enter") submit(); };
}

let seasonResetConfirm = false;
let seasonResetConfirmTimeout = null;

function openSeasonSettingsModal(activeTab) {
  activeTab = activeTab || "settings";
  let backdrop = document.querySelector(".modal-backdrop.season-panel");
  if (!backdrop) {
    backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop season-panel";
    document.body.appendChild(backdrop);
  }
  const tabs = [
    { id: "settings", label: "시즌 설정" },
    { id: "hof", label: "명예의 전당 관리" },
  ];
  backdrop.innerHTML = `
    <div class="modal" style="max-width:300px;">
      <h3 class="accent" style="font-size:22px">시즌 설정</h3>
      <div class="admin-tabs">${tabs.map((t) => `<button class="small ${activeTab === t.id ? "primary" : "ghost"}" data-stab="${t.id}">${t.label}</button>`).join("")}</div>
      <div id="seasonTabContent"><div class="status-line">불러오는 중...</div></div>
      <button class="ghost" id="seasonCloseBtn">닫기</button>
    </div>`;
  backdrop.querySelectorAll("[data-stab]").forEach((b) => b.onclick = () => openSeasonSettingsModal(b.dataset.stab));
  document.getElementById("seasonCloseBtn").onclick = () => backdrop.remove();

  const content = document.getElementById("seasonTabContent");
  if (activeTab === "hof") {
    socket.emit("getHallOfFame", null, (res) => {
      const hof = (res && res.hof) || [];
      content.innerHTML = hof.length
        ? hof.map((h) => `
            <div class="admin-row">
              <div>${escapeHtml(h.seasonName)} - ${escapeHtml(h.nickname)}</div>
              <button class="small danger" data-delhof="${h.id}">삭제</button>
            </div>`).join("")
        : `<div class="status-line">아직 명예의 전당에 오른 사람이 없어요</div>`;
      content.querySelectorAll("[data-delhof]").forEach((b) => b.onclick = () => {
        socket.emit("adminDeleteHof", { id: b.dataset.delhof }, (r) => {
          if (r.error) showToast(r.error); else openSeasonSettingsModal("hof");
        });
      });
    });
    return;
  }

  socket.emit("getSeason", null, (res) => {
    if (!document.getElementById("seasonTabContent")) return; // 불러오는 사이 창이 닫혔을 수 있음
    content.innerHTML = `
      <input type="text" id="seasonNameInput" placeholder="시즌 이름 (예: 2026 시즌 1)" maxlength="30" value="${escapeHtml((res && res.name) || "")}" />
      <div class="my-info-row"><span class="label">시작일</span><input type="date" id="seasonStartInput" value="${(res && res.startDate) || ""}" /></div>
      <div class="my-info-row"><span class="label">종료일</span><input type="date" id="seasonEndInput" value="${(res && res.endDate) || ""}" /></div>
      <div class="hint">시작일 00시 00분 ~ 종료일 00시 00분 기준으로 적용돼요. 종료일이 지나면 그 시즌 랭킹 1등이 자동으로 명예의 전당에 올라가요</div>
      <button class="primary" id="seasonSaveBtn" style="margin-top:2px;">저장</button>
      <button class="${seasonResetConfirm ? "danger" : "ghost"}" id="seasonResetBtn" style="margin-top:2px;">${seasonResetConfirm ? "정말요? 다시 눌러서 시즌 초기화" : "시즌 초기화 (모든 유저 랭킹 승/패를 0으로)"}</button>`;
    document.getElementById("seasonSaveBtn").onclick = () => {
      const name = document.getElementById("seasonNameInput").value.trim();
      const startDate = document.getElementById("seasonStartInput").value;
      const endDate = document.getElementById("seasonEndInput").value;
      socket.emit("adminSetSeason", { name, startDate, endDate }, (r) => {
        if (r.error) return showToast(r.error);
        showToast("시즌 정보가 저장됐어요");
      });
    };
    const resetBtn = document.getElementById("seasonResetBtn");
    const paintResetBtn = () => {
      resetBtn.className = seasonResetConfirm ? "danger" : "ghost";
      resetBtn.textContent = seasonResetConfirm ? "정말요? 다시 눌러서 시즌 초기화" : "시즌 초기화 (모든 유저 랭킹 승/패를 0으로)";
    };
    resetBtn.onclick = () => {
      clearTimeout(seasonResetConfirmTimeout);
      if (seasonResetConfirm) {
        seasonResetConfirm = false;
        paintResetBtn();
        socket.emit("adminResetSeasonRankings", null, (r) => {
          if (r.error) return showToast(r.error);
          showToast("시즌 랭킹이 초기화됐어요");
        });
      } else {
        seasonResetConfirm = true;
        paintResetBtn();
        seasonResetConfirmTimeout = setTimeout(() => {
          seasonResetConfirm = false;
          const b = document.getElementById("seasonResetBtn");
          if (b) { b.className = "ghost"; b.textContent = "시즌 초기화 (모든 유저 랭킹 승/패를 0으로)"; }
        }, 3000);
      }
    };
  });
}

/* ---------------- 랭킹 ---------------- */
function openRankingModal(activeTab) {
  activeTab = activeTab || "ranking";
  let backdrop = document.querySelector(".modal-backdrop.ranking-panel");
  if (!backdrop) {
    backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop ranking-panel";
    document.body.appendChild(backdrop);
  }
  backdrop.innerHTML = `
    <div class="modal" style="max-width:340px;">
      <div id="rankingHeader" class="ranking-header"><h3 class="accent" style="font-size:20px">불러오는 중...</h3></div>
      <div class="admin-tabs">
        <button class="small ${activeTab === "ranking" ? "primary" : "ghost"}" data-rtab="ranking">랭킹</button>
        <button class="small ${activeTab === "hof" ? "primary" : "ghost"}" data-rtab="hof">명예의 전당</button>
      </div>
      <div id="rankingTabContent"><div class="status-line">불러오는 중...</div></div>
      <button class="ghost" id="rankingCloseBtn">닫기</button>
    </div>`;
  backdrop.querySelectorAll("[data-rtab]").forEach((b) => b.onclick = () => openRankingModal(b.dataset.rtab));
  document.getElementById("rankingCloseBtn").onclick = () => backdrop.remove();

  socket.emit("getSeason", null, (res) => {
    const header = document.getElementById("rankingHeader");
    if (!header) return; // 응답 오는 사이 창이 닫혔을 수 있음
    const name = (res && res.name) || "시즌 미설정";
    const period = (res && res.startDate && res.endDate)
      ? `<div class="season-period">${res.startDate.replace(/-/g, ".")} ~ ${res.endDate.replace(/-/g, ".")}</div>`
      : "";
    header.innerHTML = `<h3 class="accent" style="font-size:20px">${escapeHtml(name)}</h3>${period}`;
  });

  const content = document.getElementById("rankingTabContent");
  if (activeTab === "hof") {
    socket.emit("getHallOfFame", null, (res) => {
      const hof = (res && res.hof) || [];
      content.innerHTML = hof.length
        ? hof.map((h) => `<div class="admin-row">${escapeHtml(h.seasonName)} - ${escapeHtml(h.nickname)}</div>`).join("")
        : `<div class="status-line">아직 명예의 전당에 오른 사람이 없어요</div>`;
    });
    return;
  }
  socket.emit("getRanking", null, (res) => {
    const ranked = res.ranked || [], unranked = res.unranked || [];
    content.innerHTML = `
      <table class="summary-table">
        <tr><th>순위</th><th>닉네임</th><th>승</th><th>패</th><th>승점</th></tr>
        ${ranked.map((r, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(r.nickname)}</td><td>${r.wins}</td><td>${r.losses}</td><td>${r.score > 0 ? "+" : ""}${r.score}</td></tr>`).join("")}
        ${unranked.map((r) => `<tr><td>X</td><td>${escapeHtml(r.nickname)}</td><td>-</td><td>-</td><td>-</td></tr>`).join("")}
      </table>
      ${unranked.length ? `<div class="hint">X는 등급전 전적이 아직 없는 멤버예요</div>` : ""}
      ${!ranked.length && !unranked.length ? `<div class="status-line">등록된 멤버가 없어요</div>` : ""}
    `;
  });
}

/* ---------------- Lobby ---------------- */
function renderLobby() {
  const canMove = !isSpectator && mySeat !== null;
  const seats = state.players.map((p, i) => {
    if (!p) {
      return `<div class="seat-card">
        <div class="team-tag">${i % 2 === 0 ? "팀 A" : "팀 B"} · 좌석 ${i + 1}</div>
        <div>대기 중...</div>
        ${canMove ? `<button class="small ghost" data-move="${i}">이 자리로 이동</button>` : ""}
      </div>`;
    }
    return `<div class="seat-card filled ${p.ready ? "ready" : ""}">
      ${p.ready ? `<div class="ready-tag">준비완료</div>` : ""}
      <div class="team-tag">${i % 2 === 0 ? "팀 A" : "팀 B"} · 좌석 ${i + 1}</div>
      <div class="seat-name">${state.hostSeat === i ? "👑 " : ""}${p.name}${p.isBot ? " 🤖" : ""}${i === mySeat ? " (나)" : ""}</div>
      ${p.isBot ? `<button class="small ghost" data-removebot="${i}">봇 빼기</button>` : ""}
    </div>`;
  }).join("");
  const myReady = mySeat !== null && state.players[mySeat] ? state.players[mySeat].ready : false;
  const hasEmptySeat = !state.players.every((p) => p !== null);
  const canJoinSeat = isSpectator && hasEmptySeat;
  const humanCount = state.players.filter((p) => p && !p.isBot).length;
  const hasBot = state.players.some((p) => p && p.isBot);
  const canGoSpectate = !isSpectator && humanCount > 1;
  const isHost = !isSpectator && mySeat !== null && state.hostSeat === mySeat;

  app.innerHTML = `
    <div class="lobby">
      <div class="seat-grid">${seats}</div>
      <div class="hand-actions" style="flex-wrap:wrap; justify-content:center;">
        ${!isSpectator ? `<button class="primary" id="readyBtn">${myReady ? "준비 취소" : "준비 완료"}</button>` : ""}
        <button class="ghost" id="leaveLobbyBtn">방 나가기</button>
      </div>
      <div class="hand-actions" style="flex-wrap:wrap; justify-content:center;">
        ${hasEmptySeat ? `<button id="addBotBtn" ${state.ranked || !isHost ? "disabled" : ""}>봇 추가</button>` : ""}
        ${!isSpectator ? `<button class="${state.fixedSeats ? "primary" : ""}" id="fixedSeatBtn" ${state.ranked || !isHost ? "disabled" : ""}>지정석 ${state.fixedSeats ? "끄기" : "켜기"}</button>` : ""}
        ${!isSpectator ? `<button class="${state.ranked ? "primary" : ""}" id="rankedBtn" ${hasBot || !isHost ? "disabled" : ""}>등급전 ${state.ranked ? "끄기" : "켜기"}</button>` : ""}
      </div>
      ${!isSpectator && !isHost ? `<div class="hint">봇 추가·지정석·등급전은 방장만 바꿀 수 있어요</div>` : ""}
      <div class="hand-actions" style="flex-wrap:wrap; justify-content:center;">
        ${canJoinSeat ? `<button id="takeSeatBtn">빈 자리에 참여하기</button>` : ""}
        ${canGoSpectate ? `<button id="toSpectatorBtn" class="ghost">관전으로 전환</button>` : ""}
      </div>
      <div class="spectator-bar">
        <div class="chip">관전자 ${state.spectatorCount}명</div>
        ${state.spectatorCount > 0 ? `<button class="small" id="showSpecBtn">누구인지 보기</button>` : ""}
        <div class="chip">지정석 ${state.fixedSeats ? "켜짐" : "꺼짐"}</div>
        <div class="chip">등급전 ${state.ranked ? "켜짐" : "꺼짐"}</div>
      </div>
      <div class="status-line">4명 전원이 준비 완료하면 자동으로 시작돼요 (봇은 자동 준비완료)<br/>${state.ranked ? "등급전 켜짐 — 팀은 무조건 무작위, 1000점 게임, 종료 시 승패가 기록돼요" : (state.fixedSeats ? "지정석 켜짐 — 지금 앉은 자리 그대로 시작해요" : "지정석 꺼짐 — 시작할 때 자리(팀)가 무작위로 섞여요")}${hasBot && !state.ranked ? "<br/>봇이 있으면 등급전을 켤 수 없어요" : ""}</div>
    </div>
    ${chatPreviewHTML()}
    <button class="chat-fab icon-btn" id="chatFab">💬</button>
    ${chatOpen ? renderChatPanel() : ""}
  `;
  const chatFab = document.getElementById("chatFab");
  if (chatFab) chatFab.onclick = () => { chatOpen = !chatOpen; render(); };
  const chatPreview = document.getElementById("chatPreview");
  if (chatPreview) chatPreview.onclick = () => { chatOpen = true; render(); };
  wireChatPanel();
  document.querySelectorAll("[data-move]").forEach((b) => b.onclick = () => {
    const targetSeat = Number(b.dataset.move);
    socket.emit("moveSeat", { targetSeat }, (res) => {
      if (res && res.ok) { mySeat = targetSeat; render(); }
      else if (res && res.error) showToast(res.error);
    });
  });
  document.querySelectorAll("[data-removebot]").forEach((b) => b.onclick = () => {
    socket.emit("removeBot", { seat: Number(b.dataset.removebot) }, (res) => { if (res && res.error) showToast(res.error); });
  });
  const readyBtn = document.getElementById("readyBtn");
  if (readyBtn) readyBtn.onclick = () => socket.emit("setReady", { ready: !myReady });
  const addBotBtn = document.getElementById("addBotBtn");
  if (addBotBtn) addBotBtn.onclick = () => socket.emit("addBot", null, (res) => { if (res && res.error) showToast(res.error); });
  const takeSeatBtn = document.getElementById("takeSeatBtn");
  if (takeSeatBtn) takeSeatBtn.onclick = () => socket.emit("takeSeat", null, (res) => {
    if (res && res.ok) { mySeat = res.seat; isSpectator = false; render(); }
    else showToast("빈 자리가 없어요");
  });
  const toSpectatorBtn = document.getElementById("toSpectatorBtn");
  if (toSpectatorBtn) toSpectatorBtn.onclick = () => socket.emit("switchToSpectator", null, (res) => {
    if (res && res.ok) { isSpectator = true; mySeat = null; render(); }
    else if (res && res.error) showToast(res.error);
  });
  const fixedSeatBtn = document.getElementById("fixedSeatBtn");
  if (fixedSeatBtn) fixedSeatBtn.onclick = () => socket.emit("setFixedSeats", { enabled: !state.fixedSeats });
  const rankedBtn = document.getElementById("rankedBtn");
  if (rankedBtn) rankedBtn.onclick = () => socket.emit("setRanked", { enabled: !state.ranked }, (res) => { if (res && res.error) showToast(res.error); });
  const showSpecBtn = document.getElementById("showSpecBtn");
  if (showSpecBtn) showSpecBtn.onclick = () => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `<div class="modal"><h3>관전자 (${state.spectatorNames.length}명)</h3>
      <div>${state.spectatorNames.map((n) => `<div class="chip">${n}</div>`).join(" ") || "없음"}</div>
      <button id="closeSpec">닫기</button></div>`;
    document.body.appendChild(backdrop);
    document.getElementById("closeSpec").onclick = () => backdrop.remove();
  };
  const leaveLobbyBtn = document.getElementById("leaveLobbyBtn");
  if (leaveLobbyBtn) leaveLobbyBtn.onclick = () => leaveCurrentRoom();
}

/* ---------------- Grand(라지) Tichu ---------------- */
function renderGrand() {
  const myHand = (state.first8 || []).map((c) => cardHTML(c, { small: true })).join("");
  const alreadyCalled = !isSpectator && !!state.tichuCalled[mySeat];
  const decided = !isSpectator && state.grandDecision[mySeat] !== null;
  const locked = decided || alreadyCalled; // 라지 결정했거나 스몰을 이미 선언했으면 더 이상 못 바꿈
  const waitingOn = state.players.map((p, i) => p && state.grandDecision[i] === null ? p.name : null).filter(Boolean);
  const isPendingLarge = !!confirmPending.largeTichu;
  const isPendingSmall = !!confirmPending.smallTichu;

  const centerHtml = `<div class="trick-empty">라지티츄 여부를 결정하는 중...</div>${waitingOn.length ? `<div class="chip" style="margin-top:6px;">대기: ${waitingOn.join(", ")}</div>` : ""}<div class="chip" id="grandTimerChip" style="margin-top:6px;"></div>`;
  const bottomHtml = isSpectator ? "" : `
    <div class="hand-actions">
      <button class="${isPendingLarge ? "danger" : "primary"}" id="grandYes" ${locked ? "disabled" : ""}>${isPendingLarge ? "정말요? 다시 눌러서 확정" : "라지티츄 콜! (+200/-200)"}</button>
      <button class="${isPendingSmall ? "danger" : "ghost"}" id="grandSmall" ${locked ? "disabled" : ""}>${isPendingSmall ? "정말요? 다시 눌러서 확정" : "스몰티츄 콜! (+100/-100)"}</button>
      <button id="grandNo" ${locked ? "disabled" : ""}>패스</button>
    </div>
    <div class="hand-cards">${myHand}</div>
  `;
  const statusLine = isSpectator ? "관전 중 — 라지티츄 결정 대기" : (locked ? "선택 완료 — 다른 플레이어를 기다리는 중" : "처음 8장을 보고 라지티츄·스몰티츄·패스 중 하나를 고르세요");

  renderGameFrame({ centerHtml, bottomHtml, statusLine });

  const y = document.getElementById("grandYes"), n = document.getElementById("grandNo"), sm = document.getElementById("grandSmall");
  if (y) y.onclick = () => handleDoubleConfirm("largeTichu", () => socket.emit("callGrandTichu", { wantsLarge: true }));
  if (sm) sm.onclick = () => handleDoubleConfirm("smallTichu", () => socket.emit("callTichu"));
  if (n) n.onclick = () => socket.emit("callGrandTichu", { wantsLarge: false });
  startGrandTimerTick();
}

/* ---------------- Exchange (보드는 그대로, 교환 UI는 모달로) ---------------- */
function renderExchange() {
  const waitingOn = state.players.map((p, i) => p && !state.exchangeSubmitted[i] ? p.name : null).filter(Boolean);
  const centerHtml = `<div class="trick-empty">카드 교환 중...</div>${waitingOn.length ? `<div class="chip" style="margin-top:6px;">대기: ${waitingOn.join(", ")}</div>` : ""}`;

  if (isSpectator) {
    renderGameFrame({ centerHtml, bottomHtml: "", statusLine: "관전 중 — 카드 교환 대기" });
    return;
  }

  const submitted = state.exchangeSubmitted[mySeat];
  const hand = state.myHand || [];
  const staged = new Set([exchangeStage.left, exchangeStage.across, exchangeStage.right].filter(Boolean));
  const handHTML = hand.map((c) => cardHTML(c, { isSelected: staged.has(c.id), isPicking: c.id === exchangeSelectedCardId })).join("");
  const bottomHtml = `<div class="hand-cards">${handHTML}</div>`;
  const statusLine = submitted ? "제출 완료 — 대기 중" : "카드를 탭해서 고르고, 위 창에서 줄 사람을 선택하세요";

  renderGameFrame({ centerHtml, bottomHtml, statusLine });

  if (!submitted) {
    document.querySelectorAll(".hand-cards .card").forEach((el) => {
      el.onclick = () => {
        const id = el.dataset.id;
        for (const k of ["left", "across", "right"]) {
          if (exchangeStage[k] === id) { exchangeStage[k] = null; render(); return; }
        }
        exchangeSelectedCardId = exchangeSelectedCardId === id ? null : id;
        render();
      };
    });
  }
  openExchangeModal();
}

function openExchangeModal() {
  const submitted = state.exchangeSubmitted[mySeat];
  const hand = state.myHand || [];
  const staged = new Set([exchangeStage.left, exchangeStage.across, exchangeStage.right].filter(Boolean));

  const slot = (key, label) => {
    const id = exchangeStage[key];
    const card = id ? hand.find((c) => c.id === id) : null;
    const hint = card ? "" : (exchangeSelectedCardId ? "여기로 배치" : "카드 선택");
    return `<div class="exchange-slot compact ${card ? "filled" : ""} ${!card && exchangeSelectedCardId ? "awaiting" : ""}" data-slot="${key}">
      <div class="label">${label}</div>
      ${card ? cardHTML(card, { small: true }) : hint}
    </div>`;
  };

  let backdrop = document.querySelector(".floating-panel-wrap.exchange-modal");
  if (!backdrop) {
    backdrop = document.createElement("div");
    backdrop.className = "floating-panel-wrap exchange-modal";
    document.body.appendChild(backdrop);
  }
  backdrop.innerHTML = `
    <div class="modal exchange-modal-compact">
      <div class="chip" id="exchangeTimerChip"></div>
      <div class="exchange-slots">
        ${slot("right", "왼쪽")}
        ${slot("across", "파트너")}
        ${slot("left", "오른쪽")}
      </div>
      <button class="primary" id="submitExchange" ${submitted || staged.size !== 3 ? "disabled" : ""}>${submitted ? "제출 완료" : "교환 확정"}</button>
    </div>
  `;
  startExchangeTimerTick();

  if (!submitted) {
    backdrop.querySelectorAll(".exchange-slot").forEach((el) => {
      el.onclick = () => {
        const key = el.dataset.slot;
        if (exchangeSelectedCardId) {
          for (const k of ["left", "across", "right"]) if (exchangeStage[k] === exchangeSelectedCardId) exchangeStage[k] = null;
          exchangeStage[key] = exchangeSelectedCardId;
          exchangeSelectedCardId = null;
          render();
        } else if (exchangeStage[key]) {
          exchangeStage[key] = null;
          render();
        }
      };
    });
    const btn = document.getElementById("submitExchange");
    if (btn) btn.onclick = () => socket.emit("submitExchange", { left: exchangeStage.left, across: exchangeStage.across, right: exchangeStage.right });
  }
}


function renderExchangeSummary() {
  renderPlay(); // 뒤에 게임 보드가 그대로 보이게(이 시점엔 turnSeat이 잠겨있어 조작은 막혀 있음)

  const rightSeat = (mySeat + 1) % 4;
  const topSeat = (mySeat + 2) % 4;
  const leftSeat = (mySeat + 3) % 4;
  const labelFor = (s) => s === topSeat ? "팀원" : s === rightSeat ? "오른쪽" : s === leftSeat ? "왼쪽" : "?";
  const data = exchangeSummaryData || [];
  const find = (s) => data.find((d) => d.from === s);
  // 왼쪽 - 팀원 - 오른쪽 순서로 배치해서 아군(팀원)이 준 카드가 항상 가운데 오게 함
  const ordered = [find(leftSeat), find(topSeat), find(rightSeat)].filter(Boolean);
  const items = ordered.map(({ from, card }) => `
    <div class="received-item ${from === topSeat ? "partner-gift" : ""}">
      <div class="label">${labelFor(from)}</div>
      ${cardHTML(card, { small: true })}
    </div>`).join("");

  let backdrop = document.querySelector(".modal-backdrop.summary-modal");
  if (!backdrop) {
    backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop summary-modal";
    document.body.appendChild(backdrop);
  }
  backdrop.innerHTML = `
    <div class="modal exchange-modal-compact">
      <h3 class="accent" style="font-size:20px">교환한 카드</h3>
      <div class="hand-actions" style="flex-wrap:wrap; gap:10px; justify-content:center;">${items}</div>
    </div>
  `;
}

/* ---------------- 공용 보드 셸 (play/grand/exchange가 함께 씀) ---------------- */
function chatPreviewHTML() {
  if (!chatMessages.length || chatOpen) return "";
  const last = chatMessages[chatMessages.length - 1];
  return `<div class="chat-preview" id="chatPreview"><span class="who">${escapeHtml(last.name || "?")}</span>${escapeHtml(last.text)}</div>`;
}

function chatRowInlineHTML() {
  const last = chatMessages.length ? chatMessages[chatMessages.length - 1] : null;
  const preview = last ? `<span class="who">${escapeHtml(last.name || "?")}</span>${escapeHtml(last.text)}` : "채팅 없음";
  return `<div class="chat-row">
    <button class="icon-btn small" id="chatFab">💬</button>
    <div class="chat-preview-inline" id="chatPreview">${preview}</div>
  </div>`;
}

function renderGameFrame({ centerHtml, bottomHtml, statusLine = "" }) {
  const viewerSeat = isSpectator ? 0 : mySeat;
  const rightSeat = (viewerSeat + 1) % 4;
  const topSeat = (viewerSeat + 2) % 4;
  const leftSeat = (viewerSeat + 3) % 4;
  const cancelVotes = state.cancelVotes || [];
  const iVoted = mySeat !== null && cancelVotes.includes(mySeat);
  const myTeam = (!isSpectator && mySeat !== null) ? TEAM_OF_SEAT[mySeat] : 0;
  const myScore = state.teamScores[myTeam];
  const oppScore = state.teamScores[1 - myTeam];
  const showTimer = state.phase === "play" && state.turnSeat !== null && state.pendingDragonChoice === null;

  app.innerHTML = `
    <div class="table-wrap">
      <div class="topbar">
        <div class="scoreboard" id="scoreboardBtn">
          <div class="team a">내팀 ${myScore}</div>
          <div class="team b">상대팀 ${oppScore}</div>
        </div>
        <div class="topbar-right">
          <button class="icon-btn" id="menuBtn">⋮</button>
        </div>
      </div>
      <div class="board-area">
        ${playLogHTML()}
        <div class="compass">
          ${seatBoxHTML(topSeat, "seat-north")}
          ${seatBoxHTML(leftSeat, "seat-west")}
          <div class="seat-center trick-area">${centerHtml}</div>
          ${seatBoxHTML(rightSeat, "seat-east")}
          ${seatBoxHTML(viewerSeat, "seat-south")}
        </div>
        ${showTimer ? `<div class="turn-timer-corner" id="turnTimerChip">차례</div>` : ""}
      </div>
      ${cancelVotes.length > 0 ? `<div class="cancel-bar">게임 취소 투표 ${cancelVotes.length}/4
        ${!iVoted && !isSpectator ? `<button class="small danger" id="voteCancelBtn">나도 취소 동의</button>` : ""}
      </div>` : ""}
      <div class="hand-wrap">
        ${statusLine ? `<div class="status-line">${statusLine}</div>` : ""}
        ${bottomHtml}
        ${chatRowInlineHTML()}
      </div>
    </div>
    ${menuOpen ? `<div class="menu-dropdown">
      ${!isSpectator ? `<button id="voteCancelMenuBtn" class="danger">게임 취소 제안</button>` : ""}
      <button id="leaveBtn" class="${confirmPending.leaveGame ? "danger" : "ghost"}">${confirmPending.leaveGame ? "정말요? 다시 눌러서 나가기" : "방 나가기"}</button>
    </div>` : ""}
    ${chatOpen ? renderChatPanel() : ""}
  `;

  const scoreboardBtn = document.getElementById("scoreboardBtn");
  if (scoreboardBtn) scoreboardBtn.onclick = () => openRoundHistoryModal();
  const menuBtn = document.getElementById("menuBtn");
  if (menuBtn) menuBtn.onclick = () => { menuOpen = !menuOpen; render(); };
  const leaveBtn = document.getElementById("leaveBtn");
  if (leaveBtn) leaveBtn.onclick = () => handleDoubleConfirm("leaveGame", () => leaveCurrentRoom());
  const voteCancelMenuBtn = document.getElementById("voteCancelMenuBtn");
  if (voteCancelMenuBtn) voteCancelMenuBtn.onclick = () => { socket.emit("requestCancel"); menuOpen = false; render(); };
  const voteCancelBtn = document.getElementById("voteCancelBtn");
  if (voteCancelBtn) voteCancelBtn.onclick = () => socket.emit("requestCancel");
  const chatFab = document.getElementById("chatFab");
  if (chatFab) chatFab.onclick = () => { chatOpen = !chatOpen; render(); };
  const chatPreview = document.getElementById("chatPreview");
  if (chatPreview) chatPreview.onclick = () => { chatOpen = true; render(); };
  wireChatPanel();
  renderChatBubbles();

  return { viewerSeat, rightSeat, topSeat, leftSeat };
}

/* ---------------- Play (나침반 UI) ---------------- */
function seatLabel(seat) { const p = state.players[seat]; return p ? p.name : `좌석${seat + 1}`; }

function seatBoxHTML(seat, posClass) {
  const isTurn = state.turnSeat === seat && state.pendingDragonChoice === null;
  const tichu = state.tichuCalled[seat];
  const badge = tichu === "large" ? `<span class="badge tichu-large">라지티츄</span>` : tichu === "small" ? `<span class="badge tichu-small">스몰티츄</span>` : "";
  const finished = state.finished[seat] ? " ✓" : "";
  const count = state.handCounts[seat];
  const p = state.players[seat];
  const connected = p && p.connected;
  const abandonCount = p ? (p.abandonCount || 0) : 0;
  const hasPassed = state.currentTrick && state.currentTrick.passedSeats && state.currentTrick.passedSeats.includes(seat) && state.turnSeat !== seat;
  return `<div class="seat-box ${posClass} ${isTurn ? "turn" : ""} ${connected === false ? "disconnected" : ""}" data-seat="${seat}">
    ${abandonCount > 0 ? `<div class="abandon-tag">잠수 ${abandonCount}/3</div>` : ""}
    <div class="nick">${seatLabel(seat)}${finished}</div>
    ${hasPassed ? `<div class="pass-tag">패스</div>` : ""}
    <div class="count">${count}장</div>
    ${badge}
  </div>`;
}

function isLikelyBomb(cards) {
  if (!cards || cards.length === 0) return false;
  if (cards.some((c) => c.special)) return false; // 봄에는 특수카드(참새/봉황/용/개) 포함 불가
  if (cards.length === 4) {
    return new Set(cards.map((c) => c.rank)).size === 1; // 포카드
  }
  if (cards.length >= 5) {
    const suits = new Set(cards.map((c) => c.suit));
    if (suits.size !== 1) return false;
    const ranks = cards.map((c) => c.rank).sort((a, b) => a - b);
    if (new Set(ranks).size !== ranks.length) return false;
    for (let i = 1; i < ranks.length; i++) if (ranks[i] !== ranks[i - 1] + 1) return false;
    return true; // 스트레이트 플러시 봄
  }
  return false;
}

function formatPhoenixValue(power) {
  const whole = Math.floor(power);
  const label = whole >= 2 ? RANK_LABEL[whole] : String(whole);
  return `${label}.5`;
}

function playLogHTML() {
  if (playLogEntries.length === 0) return "";
  const lines = playLogEntries.slice(-1).map((e) => `<div class="play-log-line">${e.text}</div>`).join("");
  return `<div class="play-log">${lines}</div>`;
}

function comboLabel(combo) {
  if (!combo) return "";
  if (combo.type === "dog") return "개";
  if (combo.type === "single") {
    const c = combo.cards[0];
    if (c.special === "dragon") return "용 싱글";
    if (c.special === "phoenix") return `봉황 싱글 (${formatPhoenixValue(combo.power)})`;
    if (c.special === "sparrow") return "참새 싱글";
    return `${RANK_LABEL[c.rank]} 싱글`;
  }
  if (combo.type === "pair") return `${RANK_LABEL[combo.power]} 페어`;
  if (combo.type === "triple") return `${RANK_LABEL[combo.power]} 트리플`;
  if (combo.type === "fullhouse") return `${RANK_LABEL[combo.power]} 풀하우스`;
  if (combo.type === "straight") return `${combo.len}장 스트레이트`;
  if (combo.type === "pairSequence") return `${combo.len}장 연속페어`;
  if (combo.type === "bomb4") return `${RANK_LABEL[combo.power]} 포카드 봄!`;
  if (combo.type === "bombStraight") return `${combo.len}장 스트레이트 봄!`;
  return "";
}

let animatedPlayKey = null;

function renderPlay() {
  const viewerSeat = isSpectator ? 0 : mySeat;
  const rightSeat = (viewerSeat + 1) % 4;
  const topSeat = (viewerSeat + 2) % 4;
  const leftSeat = (viewerSeat + 3) % 4;

  const trick = state.currentTrick;
  const lastPlay = trick.plays.length > 0 ? trick.plays[trick.plays.length - 1] : null;

  let fromClass = "";
  let isNewPlay = false;
  if (lastPlay) {
    const playKey = `${trick.plays.length}_${lastPlay.seat}_${lastPlay.cards.map((c) => c.id).join(",")}`;
    isNewPlay = playKey !== animatedPlayKey;
    animatedPlayKey = playKey;
    fromClass = lastPlay.seat === topSeat ? "from-north" : lastPlay.seat === rightSeat ? "from-east" : lastPlay.seat === leftSeat ? "from-west" : "from-south";
  }
  const plays = lastPlay ? `<div class="mini-combo ${isNewPlay ? "play-anim " + fromClass : ""} ${lastPlay.combo.cards.length >= 6 ? "long-combo" : ""}">${lastPlay.combo.cards.map((c) => cardHTML(c, { small: true })).join("")}</div>` : "";
  const comboTypeText = lastPlay ? comboLabel(lastPlay.combo) : "";
  const requestedTag = (state.requestedRank && !state.requestSatisfied)
    ? `<div class="requested-tag">콜 : ${RANK_LABEL[state.requestedRank]}</div>`
    : "";
  const dragonGiftTag = (state.lastDragonGift && Date.now() < dragonGiftVisibleUntil)
    ? `<div class="dragon-gift-tag">용 → ${seatLabel(state.lastDragonGift.to)}</div>`
    : "";
  const centerHtml = `
    ${lastPlay ? `<div class="trick-direction dir-${fromClass.replace("from-", "")}"></div>` : ""}
    ${requestedTag}
    ${dragonGiftTag}
    <div class="trick-plays">${plays || `<div class="trick-empty">${trick.lastCombo === null ? "리드를 기다리는 중" : ""}</div>`}</div>
    ${comboTypeText ? `<div class="combo-type-label">${comboTypeText}</div>` : ""}
  `;

  const myHand = state.myHand || [];
  const handHTML = myHand.map((c) => cardHTML(c, { isSelected: selected.has(c.id) })).join("");

  const isMyTurn = !isSpectator && state.turnSeat === mySeat && state.pendingDragonChoice === null;
  const isLeading = trick.lastCombo === null;
  const canCallSmall = !isSpectator && !state.tichuCalled[mySeat] && myHand.length === 14 && !state.finished[mySeat];

  const selectedCards = Array.from(selected).map((id) => myHand.find((c) => c.id === id)).filter(Boolean);
  const selectedIsBomb = selectedCards.length > 0 && isLikelyBomb(selectedCards);
  const canAttemptPlay = selected.size > 0 && !isSpectator && !state.finished[mySeat] && state.pendingDragonChoice === null && (isMyTurn || selectedIsBomb);
  const canPass = !isSpectator && isMyTurn && !isLeading;

  const statusLine = isSpectator ? "관전 중" : isMyTurn ? (isLeading ? "당신 차례입니다 — 리드하세요" : "당신 차례입니다") : (selected.size > 0 && !selectedIsBomb ? "내 차례가 아니에요 (폭탄만 낼 수 있어요)" : `${seatLabel(state.turnSeat)}의 차례...`);
  const bottomHtml = `
    <div class="hand-actions">
      <button id="smallTichuBtn" class="${confirmPending.smallTichu ? "danger" : "ghost"}" ${canCallSmall ? "" : "disabled"}>${confirmPending.smallTichu ? "정말요? 다시 눌러서 확정" : "스몰티츄 콜! (+100/-100)"}</button>
      <button id="passBtn" ${canPass ? "" : "disabled"}>패스</button>
      <button id="playBtn" class="primary" ${canAttemptPlay ? "" : "disabled"}>내기</button>
    </div>
    <div class="hand-cards">${isSpectator ? "" : handHTML}</div>
  `;

  renderGameFrame({ centerHtml, bottomHtml, statusLine });

  document.querySelectorAll(".hand-cards .card").forEach((el) => {
    el.onclick = () => { const id = el.dataset.id; if (selected.has(id)) selected.delete(id); else selected.add(id); render(); };
  });
  const playBtn = document.getElementById("playBtn");
  if (playBtn) playBtn.onclick = () => {
    const ids = Array.from(selected);
    const cards = ids.map((id) => myHand.find((c) => c.id === id));
    const isSparrowLead = isLeading && cards.some((c) => c.special === "sparrow");
    if (isSparrowLead) openSparrowModal((rank) => submitPlay(ids, rank));
    else submitPlay(ids, null);
  };
  const passBtn = document.getElementById("passBtn");
  if (passBtn) passBtn.onclick = () => socket.emit("passTurn", null, (res) => { if (res && res.error) showToast(res.error); });
  const smallBtn = document.getElementById("smallTichuBtn");
  if (smallBtn) smallBtn.onclick = () => handleDoubleConfirm("smallTichu", () => socket.emit("callTichu"));

  if (!isSpectator && mySeat !== null && state.pendingDragonChoice === mySeat) openDragonModal();

  startTimerTick();
}

function renderChatBubbles() {
  Object.keys(chatBubbles).forEach((seatStr) => {
    const seat = Number(seatStr);
    const boxEl = document.querySelector(`.seat-box[data-seat="${seat}"]`);
    if (!boxEl) return;
    const rect = boxEl.getBoundingClientRect();
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble-overlay";
    bubble.textContent = chatBubbles[seat].text;
    bubble.style.left = `${rect.left + rect.width / 2}px`;
    bubble.style.top = `${rect.top - 6}px`;
    document.body.appendChild(bubble);
  });
}

function startTimerTick() {
  if (timerTickHandle) clearInterval(timerTickHandle);
  const tick = () => {
    const chip = document.getElementById("turnTimerChip");
    if (!chip || !state || state.phase !== "play") return;
    if (!state.turnDeadline || state.pendingDragonChoice !== null) { chip.textContent = "차례"; return; }
    const remain = Math.max(0, Math.ceil((state.turnDeadline - Date.now()) / 1000));
    chip.textContent = `차례 · ${remain}초`;
  };
  tick();
  timerTickHandle = setInterval(tick, 1000);
}

let exchangeTimerTickHandle = null;
function startExchangeTimerTick() {
  if (exchangeTimerTickHandle) clearInterval(exchangeTimerTickHandle);
  const tick = () => {
    const chip = document.getElementById("exchangeTimerChip");
    if (!chip || !state || state.phase !== "exchange") return;
    if (!state.exchangeDeadline) { chip.textContent = ""; return; }
    const remain = Math.max(0, Math.ceil((state.exchangeDeadline - Date.now()) / 1000));
    chip.textContent = `남은 시간 ${remain}초`;
  };
  tick();
  exchangeTimerTickHandle = setInterval(tick, 1000);
}

let grandTimerTickHandle = null;
function startGrandTimerTick() {
  if (grandTimerTickHandle) clearInterval(grandTimerTickHandle);
  const tick = () => {
    const chip = document.getElementById("grandTimerChip");
    if (!chip || !state || state.phase !== "grand") return;
    if (!state.grandDeadline) { chip.textContent = ""; return; }
    const remain = Math.max(0, Math.ceil((state.grandDeadline - Date.now()) / 1000));
    chip.textContent = `남은 시간 ${remain}초`;
  };
  tick();
  grandTimerTickHandle = setInterval(tick, 1000);
}

let roundEndTimerTickHandle = null;
function startRoundEndTimerTick() {
  if (roundEndTimerTickHandle) clearInterval(roundEndTimerTickHandle);
  const tick = () => {
    const chip = document.getElementById("roundEndTimerChip");
    if (!chip || !state || state.phase !== "roundEnd") return;
    if (!state.roundEndDeadline) { chip.textContent = ""; return; }
    const remain = Math.max(0, Math.ceil((state.roundEndDeadline - Date.now()) / 1000));
    chip.textContent = `${remain}초 후 다음 라운드로 자동 진행`;
  };
  tick();
  roundEndTimerTickHandle = setInterval(tick, 1000);
}

function submitPlay(ids, requestRank) {
  socket.emit("playCards", { cardIds: ids, requestRank }, (res) => {
    if (res && res.error) return showToast(res.error);
    selected.clear();
  });
}

function openSparrowModal(onPick) {
  const ranks = [2,3,4,5,6,7,8,9,10,11,12,13,14];
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal">
      <h3>참새 요청</h3>
      <div class="status-line">받고 싶은 카드 숫자를 요청하세요 (요청하면 다음 플레이어들이 낼 수 있는 한 반드시 내야 해요)</div>
      <div class="rank-grid">${ranks.map((r) => `<button data-r="${r}">${RANK_LABEL[r]}</button>`).join("")}</div>
      <button id="skipReq" class="ghost">요청 안 함</button>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelectorAll("[data-r]").forEach((b) => b.onclick = () => { onPick(Number(b.dataset.r)); backdrop.remove(); });
  document.getElementById("skipReq").onclick = () => { onPick(null); backdrop.remove(); };
}

function openDragonModal() {
  if (document.querySelector(".modal-backdrop")) return;
  const myTeam = TEAM_OF_SEAT[mySeat];
  const rightSeat = (mySeat + 1) % 4;
  const leftSeat = (mySeat + 3) % 4;
  const orderedOpponents = [leftSeat, rightSeat]; // 왼쪽 사람 버튼이 왼쪽에, 오른쪽 사람 버튼이 오른쪽에 오도록 순서 고정
  const labelFor = (s) => {
    const pos = s === rightSeat ? "오른쪽 사람" : s === leftSeat ? "왼쪽 사람" : "상대";
    return `${pos} (${seatLabel(s)})`;
  };
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal dragon-modal">
      <h3 class="accent">용을 누구에게 주시겠습니까?</h3>
      <div class="hand-actions">${orderedOpponents.map((s) => `<button data-s="${s}">${labelFor(s)}</button>`).join("")}</div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelectorAll("[data-s]").forEach((b) => b.onclick = () => {
    socket.emit("chooseDragonRecipient", { recipientSeat: Number(b.dataset.s) }, (res) => { if (res && res.error) showToast(res.error); });
    backdrop.remove();
  });
}

/* ---------------- Chat ---------------- */
function renderChatPanel() {
  return `<div class="chat-panel">
    <div class="chat-messages" id="chatMessages">
      ${chatMessages.map((m) => `<div class="msg"><span class="who">${escapeHtml(m.name || "?")}</span>${escapeHtml(m.text)}</div>`).join("")}
    </div>
    <div class="chat-input-row">
      <input type="text" id="chatInput" maxlength="200" placeholder="메시지 입력..." />
      <button id="chatSendBtn">전송</button>
    </div>
  </div>`;
}
function wireChatPanel() {
  const box = document.getElementById("chatMessages");
  if (box) box.scrollTop = box.scrollHeight;
  const input = document.getElementById("chatInput");
  const send = () => {
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    socket.emit("chatMessage", { text });
    input.value = "";
    if (!isSpectator) { chatOpen = false; render(); } // 플레이어는 채팅 보내면 창이 닫힘(관전자는 계속 열어둠)
  };
  const sendBtn = document.getElementById("chatSendBtn");
  if (sendBtn) sendBtn.onclick = send;
  if (input) input.onkeydown = (e) => { if (e.key === "Enter") send(); };
}

function renderGlobalChatPanel() {
  return `<div class="chat-panel">
    <div class="chat-messages" id="globalChatMessages">
      ${globalChatMessages.map((m) => `<div class="msg"><span class="who">${escapeHtml(m.name || "?")}</span>${escapeHtml(m.text)}</div>`).join("")}
    </div>
    <div class="chat-input-row">
      <input type="text" id="globalChatInput" maxlength="200" placeholder="메시지 입력..." />
      <button id="globalChatSendBtn">전송</button>
    </div>
  </div>`;
}
function wireGlobalChatPanel() {
  const box = document.getElementById("globalChatMessages");
  if (box) box.scrollTop = box.scrollHeight;
  const input = document.getElementById("globalChatInput");
  const send = () => {
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    socket.emit("globalChatMessage", { text, name: myName || "익명" });
    input.value = "";
  };
  const sendBtn = document.getElementById("globalChatSendBtn");
  if (sendBtn) sendBtn.onclick = send;
  if (input) input.onkeydown = (e) => { if (e.key === "Enter") send(); };
}

/* ---------------- Round End ---------------- */
function renderRoundEnd() {
  const s = state.lastHandSummary || { teamPoints: { 0: 0, 1: 0 }, bonuses: { 0: 0, 1: 0 }, doubleWin: null };
  const myTeam = (!isSpectator && mySeat !== null) ? TEAM_OF_SEAT[mySeat] : 0;
  const oppTeam = 1 - myTeam;
  const centerHtml = `<div class="trick-empty">라운드 종료</div>`;
  const bottomHtml = !isSpectator
    ? `<div class="hand-actions"><button class="primary" id="nextHandBtn">다음 라운드</button></div>`
    : `<div class="status-line">관전 중</div>`;
  renderGameFrame({ centerHtml, bottomHtml, statusLine: "" });
  const btn = document.getElementById("nextHandBtn");
  if (btn) btn.onclick = () => socket.emit("nextHand");

  let backdrop = document.querySelector(".floating-panel-wrap.round-summary-modal");
  if (!backdrop) {
    backdrop = document.createElement("div");
    backdrop.className = "floating-panel-wrap round-summary-modal";
    document.body.appendChild(backdrop);
  }
  backdrop.innerHTML = `
    <div class="modal exchange-modal-compact">
      <h3 class="accent" style="font-size:20px">${state.roundHistory ? state.roundHistory.length : ""}라운드 결과</h3>
      ${s.doubleWin !== null ? `<div class="status-line">${s.doubleWin === myTeam ? "내팀" : "상대팀"} 더블윈! (+200)</div>` : ""}
      <table class="summary-table">
        <tr><th></th><th>내팀</th><th>상대팀</th></tr>
        <tr><td>이번 점수</td><td>${s.teamPoints[myTeam]}</td><td>${s.teamPoints[oppTeam]}</td></tr>
        <tr><td>티츄점수</td><td>${s.bonuses[myTeam]}</td><td>${s.bonuses[oppTeam]}</td></tr>
        <tr><td><b>누적</b></td><td><b>${state.teamScores[myTeam]}</b></td><td><b>${state.teamScores[oppTeam]}</b></td></tr>
      </table>
      <div class="chip" id="roundEndTimerChip" style="margin-top:6px;"></div>
    </div>
  `;
  startRoundEndTimerTick();
}

function openRoundHistoryModal() {
  const history = state.roundHistory || [];
  const myTeam = (!isSpectator && mySeat !== null) ? TEAM_OF_SEAT[mySeat] : 0;
  const oppTeam = 1 - myTeam;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal" style="max-width:280px;">
      <h3 class="accent" style="font-size:22px">라운드별 점수</h3>
      <table class="summary-table">
        <tr><th>라운드</th><th>내팀</th><th>상대팀</th></tr>
        ${history.length
          ? history.map((h) => `<tr><td>${h.round}</td><td>${h.teamPoints[myTeam]}</td><td>${h.teamPoints[oppTeam]}</td></tr>`).join("")
          : `<tr><td colspan="3">아직 끝난 라운드가 없어요</td></tr>`}
      </table>
      <button id="closeHistory" class="ghost">닫기</button>
    </div>`;
  document.body.appendChild(backdrop);
  document.getElementById("closeHistory").onclick = () => backdrop.remove();
}

/* ---------------- Game Over ---------------- */
function renderGameOver() {
  const myTeam = (!isSpectator && mySeat !== null) ? TEAM_OF_SEAT[mySeat] : 0;
  const oppTeam = 1 - myTeam;
  const winner = state.teamScores[0] > state.teamScores[1] ? 0 : 1;
  app.innerHTML = `
    <div class="lobby">
      <h2 class="accent" style="font-size:40px">${winner === myTeam ? "내팀" : "상대팀"} 승리!</h2>
      <table class="summary-table">
        <tr><th>내팀</th><th>상대팀</th></tr>
        <tr><td>${state.teamScores[myTeam]}</td><td>${state.teamScores[oppTeam]}</td></tr>
      </table>
      <div class="status-line">새로고침하면 처음 화면으로 돌아가요</div>
    </div>
  `;
}

/* ---------------- Aborted ---------------- */
function renderAborted() {
  app.innerHTML = `
    <div class="lobby">
      <h2 class="accent" style="font-size:34px">게임 무효</h2>
      <div class="status-line">${state.abortReason || "게임이 중단되었어요"}</div>
      <button class="primary" id="backBtn">처음으로</button>
    </div>
  `;
  document.getElementById("backBtn").onclick = () => { localStorage.removeItem("tichu_room"); location.reload(); };
}

/* ---------------- 사운드 & 티츄 배경색 ---------------- */
let audioCtx = null;
function playCardSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const ctx = audioCtx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "triangle";
    o.frequency.value = 540;
    g.gain.setValueAtTime(0.001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.38, ctx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.16);
    o.connect(g); g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.17);
  } catch (e) { /* 오디오 미지원 환경은 조용히 무시 */ }
}

function playTrickStartSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const ctx = audioCtx;
    const now = ctx.currentTime;
    [660, 880].forEach((freq, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      const t0 = now + i * 0.09;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.32, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
      o.connect(g); g.connect(ctx.destination);
      o.start(t0); o.stop(t0 + 0.18);
    });
  } catch (e) { /* 오디오 미지원 환경은 조용히 무시 */ }
}

function playPassSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const ctx = audioCtx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "triangle";
    o.frequency.setValueAtTime(320, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(200, ctx.currentTime + 0.12);
    g.gain.setValueAtTime(0.001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.5, ctx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.14);
    o.connect(g); g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.15);
  } catch (e) { /* 오디오 미지원 환경은 조용히 무시 */ }
}

function playBombSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const ctx = audioCtx;
    const now = ctx.currentTime;
    // 저음 폭발음
    const o1 = ctx.createOscillator();
    const g1 = ctx.createGain();
    o1.type = "sawtooth";
    o1.frequency.setValueAtTime(180, now);
    o1.frequency.exponentialRampToValueAtTime(40, now + 0.35);
    g1.gain.setValueAtTime(0.0001, now);
    g1.gain.exponentialRampToValueAtTime(0.55, now + 0.02);
    g1.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
    o1.connect(g1); g1.connect(ctx.destination);
    o1.start(now); o1.stop(now + 0.42);
    // 날카로운 타격음
    const o2 = ctx.createOscillator();
    const g2 = ctx.createGain();
    o2.type = "square";
    o2.frequency.setValueAtTime(900, now);
    o2.frequency.exponentialRampToValueAtTime(120, now + 0.09);
    g2.gain.setValueAtTime(0.0001, now);
    g2.gain.exponentialRampToValueAtTime(0.4, now + 0.005);
    g2.gain.exponentialRampToValueAtTime(0.0001, now + 0.1);
    o2.connect(g2); g2.connect(ctx.destination);
    o2.start(now); o2.stop(now + 0.11);
  } catch (e) { /* 오디오 미지원 환경은 조용히 무시 */ }
}

function playSmallTichuSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const ctx = audioCtx;
    const now = ctx.currentTime;
    [520, 780].forEach((freq, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      const t0 = now + i * 0.1;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.32, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
      o.connect(g); g.connect(ctx.destination);
      o.start(t0); o.stop(t0 + 0.22);
    });
  } catch (e) { /* 오디오 미지원 환경은 조용히 무시 */ }
}

function playLargeTichuSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const ctx = audioCtx;
    const now = ctx.currentTime;
    [520, 660, 780, 1040].forEach((freq, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "triangle";
      o.frequency.value = freq;
      const t0 = now + i * 0.09;
      const dur = i === 3 ? 0.36 : 0.16;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.42, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(ctx.destination);
      o.start(t0); o.stop(t0 + dur + 0.02);
    });
  } catch (e) { /* 오디오 미지원 환경은 조용히 무시 */ }
}

function playClickSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const ctx = audioCtx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = 720;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.06);
    o.connect(g); g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.07);
  } catch (e) { /* 오디오 미지원 환경은 조용히 무시 */ }
}
document.addEventListener("click", (e) => {
  if (e.target.closest("button, .card")) playClickSound();
}, true);

let lastTrickPlayCount = 0;
function checkPlaySound(newState) {
  if (newState && newState.currentTrick) {
    const plays = newState.currentTrick.plays;
    const n = plays.length;
    if (n > lastTrickPlayCount) {
      const lastPlay = plays[n - 1];
      const comboType = lastPlay && lastPlay.combo && lastPlay.combo.type;
      if (comboType === "bomb4" || comboType === "bombStraight") playBombSound();
      else playCardSound();
    }
    lastTrickPlayCount = n;
  }
}

let lastTichuCalled = [null, null, null, null];
function checkTichuSound(s) {
  if (!s || !s.tichuCalled) return;
  for (let i = 0; i < 4; i++) {
    const prev = lastTichuCalled[i];
    const cur = s.tichuCalled[i];
    if (prev === null && cur === "small") playSmallTichuSound();
    else if (prev === null && cur === "large") playLargeTichuSound();
  }
  lastTichuCalled = s.tichuCalled.slice();
}

let lastSeenActionSeq = 0;
function checkActionEvents(s) {
  if (s && typeof s.actionSeq === "number" && s.actionSeq > lastSeenActionSeq) {
    lastSeenActionSeq = s.actionSeq;
    if (s.lastAction && s.lastAction.type === "trickStart") playTrickStartSound();
    if (s.lastAction && s.lastAction.type === "pass") playPassSound();
  }
}

function applyTichuBackground(s) {
  const anyLarge = s && s.tichuCalled && s.tichuCalled.some((t) => t === "large");
  const anySmall = s && s.tichuCalled && s.tichuCalled.some((t) => t === "small");
  document.body.classList.toggle("tichu-large-bg", !!anyLarge);
  document.body.classList.toggle("tichu-small-bg", !anyLarge && !!anySmall);
}

let exchangeSummaryData = null;
let exchangeSummaryVisible = false;

let chatBubbles = {}; // seat -> { text, id }

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

let dragonGiftVisibleUntil = 0;
let lastSeenDragonGiftKey = null;
function checkDragonGift(s) {
  if (!s.lastDragonGift) return;
  const key = `${s.lastDragonGift.from}_${s.lastDragonGift.to}`;
  if (key !== lastSeenDragonGiftKey) {
    lastSeenDragonGiftKey = key;
    dragonGiftVisibleUntil = Date.now() + 10000;
    setTimeout(() => render(), 10000); // 10초 후 사라지도록 재렌더
  }
}

// 왼쪽 상단 플레이 로그: 이번 트릭에서 나온 카드 + 트릭을 가져간 사람까지 함께 쌓인다.
// 새 트릭의 첫 수가 나오는 순간(= 사람이든 봇이든 리드) 이전 트릭 내용을 지우고 새로 쌓기 시작한다.
let playLogEntries = []; // { key, text }
let playLogPlaysSeen = 0;
let playLogSeenWinSeq = 0;
let playLogPendingClear = false;
function updatePlayLog(s) {
  const trick = s.currentTrick;
  if (!trick) return;
  const playsLen = trick.plays.length;

  if (playLogPendingClear && playsLen > 0) {
    playLogEntries = [];
    playLogPlaysSeen = 0;
    playLogPendingClear = false;
  }

  if (playsLen > playLogPlaysSeen) {
    for (let i = playLogPlaysSeen; i < playsLen; i++) {
      const p = trick.plays[i];
      playLogEntries.push({ key: `p${s.actionSeq}_${i}`, text: `${escapeHtml(seatLabel(p.seat))} - ${comboLabel(p.combo)}` });
    }
    playLogPlaysSeen = playsLen;
  } else if (playsLen === 0 && playLogPlaysSeen > 0) {
    playLogPlaysSeen = 0;
    playLogPendingClear = true; // 다음 리드가 나올 때까지는 지금까지의 로그(승자 포함)를 유지
  }

  if (s.lastTrickWin && s.lastTrickWin.seq > playLogSeenWinSeq) {
    playLogSeenWinSeq = s.lastTrickWin.seq;
    playLogEntries.push({ key: `win${s.lastTrickWin.seq}`, text: `${escapeHtml(seatLabel(s.lastTrickWin.seat))} 트릭 획득` });
  }

  if (playLogEntries.length > 20) playLogEntries = playLogEntries.slice(-20);
}

socket.on("state", (s) => {
  checkPlaySound(s);
  checkActionEvents(s);
  checkDragonGift(s);
  updatePlayLog(s);
  checkTichuSound(s);
  if (s.phase === "grand" && (!state || state.phase !== "grand")) {
    exchangeStage = { left: null, across: null, right: null };
    exchangeSelectedCardId = null;
  }
  if (!isSpectator && s.phase === "play" && state && state.phase === "exchange") {
    exchangeSummaryData = s.exchangeReceived;
    exchangeSummaryVisible = true;
    setTimeout(() => { exchangeSummaryVisible = false; render(); }, 3000);
  }
  state = s;
  applyTichuBackground(s);
  render();
});
socket.on("yourSeat", ({ seat }) => {
  if (!isSpectator && seat !== -1 && mySeat !== seat) { mySeat = seat; render(); }
});
socket.on("chatMessage", (m) => {
  chatMessages.push(m);
  if (m.seat !== null && m.seat !== undefined && m.seat !== -1) {
    const bubbleId = Symbol();
    chatBubbles[m.seat] = { text: m.text, id: bubbleId };
    setTimeout(() => {
      if (chatBubbles[m.seat] && chatBubbles[m.seat].id === bubbleId) {
        delete chatBubbles[m.seat];
        render();
      }
    }, 4000);
  }
  render(); // 채팅창이 닫혀있어도 말풍선 갱신을 위해 항상 리렌더
});
socket.on("forceLogout", ({ reason }) => {
  loggedInAs = null;
  myStats = null;
  setStoredSession(null, null);
  showToast(reason || "다른 기기에서 로그인해서 로그아웃됐어요");
  render();
});
socket.on("connect", () => {
  // "로그인 상태 유지"를 체크했었다면 저장해둔 세션 토큰으로 자동 로그인 시도
  if (!loggedInAs) {
    const sNick = localStorage.getItem("tichu_session_nickname");
    const sTok = localStorage.getItem("tichu_session_token");
    if (sNick && sTok) {
      socket.emit("loginWithToken", { nickname: sNick, sessionToken: sTok }, (res) => {
        if (res && res.ok) {
          loggedInAs = res.nickname;
          myName = res.nickname;
          fetchMyStats(true);
        } else {
          setStoredSession(null, null);
        }
      });
    }
  }
  // 네트워크가 잠깐 끊겼다가 소켓이 자동 재연결된 경우: 원래 있던 방/좌석으로 자동 복귀 시도
  if (myRoom && (mySeat !== null || isSpectator)) {
    socket.emit("joinRoom", { code: myRoom, name: myName, asSpectator: isSpectator, token: myToken }, (res) => {
      if (res && res.ok) {
        if (typeof res.seat === "number") mySeat = res.seat;
        isSpectator = !!res.spectator;
      }
      render();
    });
  } else {
    render();
  }
});
socket.on("globalChatMessage", (m) => {
  globalChatMessages.push(m);
  if (globalChatMessages.length > 100) globalChatMessages.shift();
  if (!state) render(); // 메인화면(방 밖)에 있을 때만 즉시 반영
});

render();
