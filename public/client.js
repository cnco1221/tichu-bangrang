const socket = io();
const app = document.getElementById("app");
const APP_VERSION = "0.06"; // 수정할 때마다 0.01씩 올림

let myName = localStorage.getItem("tichu_name") || "";
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
const TEAM_NAME = ["옥·탑 팀 (A)", "검·별 팀 (B)"];
const TEAM_OF_SEAT = [0, 1, 0, 1];

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

function cardHTML(card, { small = false, isSelected = false, isPicking = false } = {}) {
  const cls = ["card"];
  if (small) cls.push("small");
  if (card.special) cls.push(`special-${card.special}`);
  if (isSelected) cls.push("selected");
  if (isPicking) cls.push("picking");

  if (card.special === "sparrow") {
    return `<div class="${cls.join(" ")}" data-id="${card.id}">
      <div class="corner-tl">1</div>
      <div class="center-icon">🐦</div>
      <div class="corner-br">1</div>
    </div>`;
  }
  if (card.special === "dragon") {
    return `<div class="${cls.join(" ")}" data-id="${card.id}">
      <div class="center-icon">🐉</div>
      <div class="suit" style="color:#8a5a1a">용</div>
    </div>`;
  }
  if (card.special === "phoenix") {
    return `<div class="${cls.join(" ")}" data-id="${card.id}">
      <div class="center-icon">🔥</div>
      <div class="suit" style="color:#a33b35">봉황</div>
    </div>`;
  }
  if (card.special === "dog") {
    return `<div class="${cls.join(" ")}" data-id="${card.id}">
      <div class="center-icon">🐕</div>
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
    const exModal = document.querySelector(".modal-backdrop.exchange-modal");
    if (exModal) exModal.remove();
  }
  if (timerTickHandle && (!state || state.phase !== "play")) { clearInterval(timerTickHandle); timerTickHandle = null; }
  if (exchangeTimerTickHandle && (!state || state.phase !== "exchange")) { clearInterval(exchangeTimerTickHandle); exchangeTimerTickHandle = null; }

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
        <div class="suit-chip" style="color:${SUIT_COLOR.pagoda}">●</div>
        <div class="suit-chip" style="color:${SUIT_COLOR.star}">★</div>
      </div>
      <div class="title accent">티츄</div>
      <div class="subtitle">TICHU · 4인 실시간 트릭테이킹</div>
      <form id="nameForm">
        <input type="text" id="nameInput" placeholder="닉네임 (최대 10자)" value="${myName}" maxlength="10" required />
        <div class="row">
          <button class="primary" type="submit" id="createBtn">새 방 만들기</button>
        </div>
      </form>
      <div class="divider">— 또는 —</div>
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
                  <button class="small" data-join="${r.code}">입장</button>
                  <button class="small ghost" data-spectate="${r.code}">관전 입장</button>
                </div>
              </div>`).join("")
            : `<div class="hint">참가 가능한 방이 없어요</div>`}
        </div>
      </div>
      <form id="joinForm">
        <input type="text" id="codeInput" placeholder="방 코드 (예: ABCD)" value="${myRoom}" maxlength="4" required />
        <div class="row">
          <button type="submit" id="joinBtn">참가하기</button>
          <button type="button" id="spectateBtn">관전하기</button>
        </div>
      </form>
    </div>
    <div class="version-badge">v${APP_VERSION}</div>
    <button class="chat-fab icon-btn" id="globalChatFab">💬</button>
    ${globalChatOpen ? renderGlobalChatPanel() : ""}
  `;
  if (!roomListFetched) { roomListFetched = true; fetchRoomList(true); }
  document.getElementById("globalChatFab").onclick = () => { globalChatOpen = !globalChatOpen; render(); };
  wireGlobalChatPanel();
  const getName = () => (document.getElementById("nameInput").value.trim() || "플레이어").slice(0, 10);
  document.getElementById("nameForm").onsubmit = (e) => {
    e.preventDefault();
    myName = getName();
    localStorage.setItem("tichu_name", myName);
    socket.emit("createRoom", { name: myName }, (res) => {
      if (res.error) return showToast(res.error);
      mySeat = res.seat; myRoom = res.code; isSpectator = false;
      localStorage.setItem("tichu_room", myRoom);
    });
  };
  const doJoin = (asSpectator, codeOverride) => {
    myName = getName();
    const code = codeOverride || document.getElementById("codeInput").value.trim().toUpperCase();
    localStorage.setItem("tichu_name", myName);
    socket.emit("joinRoom", { code, name: myName, asSpectator }, (res) => {
      if (res.error) return showToast(res.error);
      mySeat = res.seat; myRoom = res.code; isSpectator = !!res.spectator;
      localStorage.setItem("tichu_room", myRoom);
    });
  };
  document.getElementById("joinForm").onsubmit = (e) => { e.preventDefault(); doJoin(false); };
  document.getElementById("spectateBtn").onclick = () => doJoin(true);
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
      <div>${p.name}${p.isBot ? " 🤖" : ""}${i === mySeat ? " (나)" : ""}</div>
      ${p.isBot ? `<button class="small ghost" data-removebot="${i}">봇 빼기</button>` : ""}
    </div>`;
  }).join("");
  const myReady = mySeat !== null && state.players[mySeat] ? state.players[mySeat].ready : false;
  const hasEmptySeat = !state.players.every((p) => p !== null);
  const canJoinSeat = isSpectator && hasEmptySeat;
  const humanCount = state.players.filter((p) => p && !p.isBot).length;
  const canGoSpectate = !isSpectator && humanCount > 1;

  app.innerHTML = `
    <div class="lobby">
      <div>방 코드</div>
      <div class="room-code">${state.code}</div>
      <div class="seat-grid">${seats}</div>
      ${!isSpectator ? `<button class="primary" id="readyBtn">${myReady ? "준비 취소" : "준비 완료"}</button>` : ""}
      <div class="hand-actions" style="flex-wrap:wrap; justify-content:center;">
        ${hasEmptySeat ? `<button id="addBotBtn">봇 추가</button>` : ""}
        ${canJoinSeat ? `<button id="takeSeatBtn">빈 자리에 참여하기</button>` : ""}
        ${canGoSpectate ? `<button id="toSpectatorBtn" class="ghost">관전으로 전환</button>` : ""}
      </div>
      <div class="spectator-bar">
        <div class="chip">관전자 ${state.spectatorCount}명</div>
        ${state.spectatorCount > 0 ? `<button class="small" id="showSpecBtn">누구인지 보기</button>` : ""}
        <div class="chip">지정석 ${state.fixedSeats ? "켜짐" : "꺼짐"}</div>
        ${!isSpectator ? `<button class="small" id="fixedSeatBtn">지정석 ${state.fixedSeats ? "끄기" : "켜기"}</button>` : ""}
      </div>
      <div class="status-line">4명 전원이 준비 완료하면 자동으로 시작돼요 (봇은 자동 준비완료)<br/>${state.fixedSeats ? "지정석 켜짐 — 지금 앉은 자리 그대로 시작해요" : "지정석 꺼짐 — 시작할 때 자리(팀)가 무작위로 섞여요"}</div>
      <button id="leaveLobbyBtn" class="ghost danger">방 나가기</button>
    </div>
  `;
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
  if (leaveLobbyBtn) leaveLobbyBtn.onclick = () => { socket.disconnect(); localStorage.removeItem("tichu_room"); location.reload(); };
}

/* ---------------- Grand(라지) Tichu ---------------- */
function renderGrand() {
  const myHand = (state.first8 || []).map((c) => cardHTML(c, { small: true })).join("");
  const decided = !isSpectator && state.grandDecision[mySeat] !== null;
  const waitingOn = state.players.map((p, i) => p && state.grandDecision[i] === null ? p.name : null).filter(Boolean);
  const isPendingLarge = !!confirmPending.largeTichu;

  const centerHtml = `<div class="trick-empty">라지티츄 여부를 결정하는 중...</div>${waitingOn.length ? `<div class="chip" style="margin-top:6px;">대기: ${waitingOn.join(", ")}</div>` : ""}`;
  const bottomHtml = isSpectator ? "" : `
    <div class="hand-cards">${myHand}</div>
    <div class="hand-actions">
      <button class="${isPendingLarge ? "danger" : "primary"}" id="grandYes" ${decided ? "disabled" : ""}>${isPendingLarge ? "정말요? 다시 눌러서 확정" : "라지티츄 콜! (+200/-200)"}</button>
      <button id="grandNo" ${decided ? "disabled" : ""}>패스</button>
    </div>
  `;
  const statusLine = isSpectator ? "관전 중 — 라지티츄 결정 대기" : (decided ? "선택 완료 — 다른 플레이어를 기다리는 중" : "처음 8장을 보고 라지티츄를 부를지 결정하세요");

  renderGameFrame({ centerHtml, bottomHtml, statusLine });

  const y = document.getElementById("grandYes"), n = document.getElementById("grandNo");
  if (y) y.onclick = () => handleDoubleConfirm("largeTichu", () => socket.emit("callGrandTichu", { wantsLarge: true }));
  if (n) n.onclick = () => socket.emit("callGrandTichu", { wantsLarge: false });
}

/* ---------------- Exchange (보드는 그대로, 교환 UI는 모달로) ---------------- */
function renderExchange() {
  const waitingOn = state.players.map((p, i) => p && !state.exchangeSubmitted[i] ? p.name : null).filter(Boolean);
  const centerHtml = `<div class="trick-empty">카드 교환 중...</div>${waitingOn.length ? `<div class="chip" style="margin-top:6px;">대기: ${waitingOn.join(", ")}</div>` : ""}`;
  renderGameFrame({ centerHtml, bottomHtml: "", statusLine: isSpectator ? "관전 중 — 카드 교환 대기" : "" });
  if (!isSpectator) openExchangeModal();
}

function openExchangeModal() {
  const submitted = state.exchangeSubmitted[mySeat];
  const hand = state.myHand || [];
  const staged = new Set([exchangeStage.left, exchangeStage.across, exchangeStage.right].filter(Boolean));
  const handHTML = hand.map((c) => cardHTML(c, { isSelected: staged.has(c.id), isPicking: c.id === exchangeSelectedCardId })).join("");

  const slot = (key, label) => {
    const id = exchangeStage[key];
    const card = id ? hand.find((c) => c.id === id) : null;
    const hint = card ? "" : (exchangeSelectedCardId ? "여기로 배치" : "카드 먼저 선택");
    return `<div class="exchange-slot ${card ? "filled" : ""} ${!card && exchangeSelectedCardId ? "awaiting" : ""}" data-slot="${key}">
      <div class="label">${label}</div>
      ${card ? cardHTML(card, { small: true }) : hint}
    </div>`;
  };

  let backdrop = document.querySelector(".modal-backdrop.exchange-modal");
  if (!backdrop) {
    backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop exchange-modal";
    document.body.appendChild(backdrop);
  }
  backdrop.innerHTML = `
    <div class="modal">
      <h3 class="accent" style="font-size:26px">카드 교환</h3>
      <div class="chip" id="exchangeTimerChip"></div>
      <div class="status-line">카드를 탭해서 고른 다음, 줄 사람 칸을 탭하세요</div>
      <div class="exchange-slots">
        ${slot("right", "왼쪽 사람")}
        ${slot("across", "파트너")}
        ${slot("left", "오른쪽 사람")}
      </div>
      <div class="hand-cards" style="max-width:520px">${handHTML}</div>
      <button class="primary" id="submitExchange" ${submitted || staged.size !== 3 ? "disabled" : ""}>${submitted ? "제출 완료 — 대기 중" : "교환 확정"}</button>
    </div>
  `;
  startExchangeTimerTick();

  if (!submitted) {
    backdrop.querySelectorAll(".hand-cards .card").forEach((el) => {
      el.onclick = () => {
        const id = el.dataset.id;
        for (const k of ["left", "across", "right"]) {
          if (exchangeStage[k] === id) { exchangeStage[k] = null; openExchangeModal(); return; }
        }
        exchangeSelectedCardId = exchangeSelectedCardId === id ? null : id;
        openExchangeModal();
      };
    });
    backdrop.querySelectorAll(".exchange-slot").forEach((el) => {
      el.onclick = () => {
        const key = el.dataset.slot;
        if (exchangeSelectedCardId) {
          for (const k of ["left", "across", "right"]) if (exchangeStage[k] === exchangeSelectedCardId) exchangeStage[k] = null;
          exchangeStage[key] = exchangeSelectedCardId;
          exchangeSelectedCardId = null;
          openExchangeModal();
        } else if (exchangeStage[key]) {
          exchangeStage[key] = null;
          openExchangeModal();
        }
      };
    });
    const btn = document.getElementById("submitExchange");
    if (btn) btn.onclick = () => socket.emit("submitExchange", { left: exchangeStage.left, across: exchangeStage.across, right: exchangeStage.right });
  }
}


function renderExchangeSummary() {
  const rightSeat = (mySeat + 1) % 4;
  const topSeat = (mySeat + 2) % 4;
  const leftSeat = (mySeat + 3) % 4;
  const labelFor = (s) => s === topSeat ? "파트너" : s === rightSeat ? "오른쪽 사람" : s === leftSeat ? "왼쪽 사람" : "?";
  const data = exchangeSummaryData || [];
  const find = (s) => data.find((d) => d.from === s);
  // 왼쪽 사람 - 파트너 - 오른쪽 사람 순서로 배치해서 아군(파트너)이 준 카드가 항상 가운데 오게 함
  const ordered = [find(leftSeat), find(topSeat), find(rightSeat)].filter(Boolean);
  const items = ordered.map(({ from, card }) => `
    <div class="received-item ${from === topSeat ? "partner-gift" : ""}">
      <div class="label">${labelFor(from)}에게 받음</div>
      ${cardHTML(card)}
    </div>`).join("");
  app.innerHTML = `
    <div class="lobby">
      <h2 class="accent" style="font-size:30px">받은 카드</h2>
      <div class="hand-actions" style="flex-wrap:wrap; gap:16px; justify-content:center;">${items}</div>
      <div class="status-line">잠시 후 게임이 시작돼요...</div>
    </div>
  `;
}

/* ---------------- 공용 보드 셸 (play/grand/exchange가 함께 씀) ---------------- */
function chatPreviewHTML() {
  if (!chatMessages.length || chatOpen) return "";
  const last = chatMessages[chatMessages.length - 1];
  return `<div class="chat-preview" id="chatPreview"><span class="who">${escapeHtml(last.name || "?")}</span>${escapeHtml(last.text)}</div>`;
}

function renderGameFrame({ centerHtml, bottomHtml, statusLine = "" }) {
  const viewerSeat = isSpectator ? 0 : mySeat;
  const rightSeat = (viewerSeat + 1) % 4;
  const topSeat = (viewerSeat + 2) % 4;
  const leftSeat = (viewerSeat + 3) % 4;
  const cancelVotes = state.cancelVotes || [];
  const iVoted = mySeat !== null && cancelVotes.includes(mySeat);

  app.innerHTML = `
    <div class="table-wrap">
      <div class="topbar">
        <div class="scoreboard">
          <div class="team a">팀A ${state.teamScores[0]}</div>
          <div class="team b">팀B ${state.teamScores[1]}</div>
        </div>
        <div class="topbar-right">
          <div class="chip" id="turnTimerChip"></div>
          <button class="icon-btn" id="menuBtn">⋮</button>
        </div>
      </div>
      ${cancelVotes.length > 0 ? `<div class="cancel-bar">게임 취소 투표 ${cancelVotes.length}/4
        ${!iVoted && !isSpectator ? `<button class="small danger" id="voteCancelBtn">나도 취소 동의</button>` : ""}
      </div>` : ""}
      <div class="compass">
        ${seatBoxHTML(topSeat, "seat-north", "아군")}
        ${seatBoxHTML(leftSeat, "seat-west", "상대")}
        <div class="seat-center trick-area">${centerHtml}</div>
        ${seatBoxHTML(rightSeat, "seat-east", "상대")}
        ${seatBoxHTML(viewerSeat, "seat-south", isSpectator ? "관전" : "나")}
      </div>
      <div class="hand-wrap">
        ${statusLine ? `<div class="status-line">${statusLine}</div>` : ""}
        ${bottomHtml}
      </div>
    </div>
    ${menuOpen ? `<div class="menu-dropdown">
      ${!isSpectator ? `<button id="voteCancelMenuBtn" class="danger">게임 취소 제안</button>` : ""}
      <button id="leaveBtn">방 나가기</button>
    </div>` : ""}
    ${chatPreviewHTML()}
    <button class="chat-fab icon-btn" id="chatFab">💬</button>
    ${chatOpen ? renderChatPanel() : ""}
  `;

  const menuBtn = document.getElementById("menuBtn");
  if (menuBtn) menuBtn.onclick = () => { menuOpen = !menuOpen; render(); };
  const leaveBtn = document.getElementById("leaveBtn");
  if (leaveBtn) leaveBtn.onclick = () => { socket.disconnect(); localStorage.removeItem("tichu_room"); location.reload(); };
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

function seatBoxHTML(seat, posClass, role) {
  const isTurn = state.turnSeat === seat && state.pendingDragonChoice === null;
  const tichu = state.tichuCalled[seat];
  const badge = tichu === "large" ? `<span class="badge large">라지</span>` : tichu === "small" ? `<span class="badge">스몰</span>` : "";
  const finished = state.finished[seat] ? " ✓" : "";
  const count = state.handCounts[seat];
  const connected = state.players[seat] && state.players[seat].connected;
  const hasPassed = state.currentTrick && state.currentTrick.passedSeats && state.currentTrick.passedSeats.includes(seat);
  return `<div class="seat-box ${posClass} ${isTurn ? "turn" : ""} ${connected === false ? "disconnected" : ""}" data-seat="${seat}">
    <div class="role">${role}</div>
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
  const plays = lastPlay ? `<div class="mini-combo ${isNewPlay ? "play-anim " + fromClass : ""}">${lastPlay.combo.cards.map((c) => cardHTML(c, { small: true })).join("")}</div>` : "";
  const comboLabelText = lastPlay ? comboLabel(lastPlay.combo) : "";
  const requestedTag = (state.requestedRank && !state.requestSatisfied)
    ? `<div class="requested-tag">콜 : ${RANK_LABEL[state.requestedRank]}</div>`
    : "";
  const dragonGiftTag = state.lastDragonGift
    ? `<div class="dragon-gift-tag">용 → ${seatLabel(state.lastDragonGift.to)}</div>`
    : "";
  const centerHtml = `
    ${requestedTag}
    ${dragonGiftTag}
    <div class="trick-plays">${plays || `<div class="trick-empty">${trick.lastCombo === null ? "리드를 기다리는 중" : ""}</div>`}</div>
    ${lastPlay ? `<div class="combo-label"><div class="who">${seatLabel(lastPlay.seat)}</div><div class="what">${comboLabelText}</div></div>` : ""}
  `;

  const myHand = state.myHand || [];
  const handHTML = myHand.map((c) => cardHTML(c, { isSelected: selected.has(c.id) })).join("");

  const isMyTurn = !isSpectator && state.turnSeat === mySeat && state.pendingDragonChoice === null;
  const isLeading = trick.lastCombo === null;
  const canCallSmall = !isSpectator && !state.tichuCalled[mySeat] && myHand.length === 14 && !state.finished[mySeat];

  const primaryLabel = selected.size > 0 ? "내기" : "패스";
  const selectedCards = Array.from(selected).map((id) => myHand.find((c) => c.id === id)).filter(Boolean);
  const selectedIsBomb = selectedCards.length > 0 && isLikelyBomb(selectedCards);
  const canAttemptPlay = !isSpectator && !state.finished[mySeat] && state.pendingDragonChoice === null && (isMyTurn || selectedIsBomb);
  const primaryEnabled = selected.size > 0 ? canAttemptPlay : (isMyTurn && !isLeading);

  const statusLine = isSpectator ? "관전 중" : isMyTurn ? (isLeading ? "당신 차례입니다 — 리드하세요" : "당신 차례입니다") : (selected.size > 0 && !selectedIsBomb ? "내 차례가 아니에요 (폭탄만 낼 수 있어요)" : `${seatLabel(state.turnSeat)}의 차례...`);
  const bottomHtml = `
    <div class="hand-actions">
      <button id="smallTichuBtn" class="${confirmPending.smallTichu ? "danger" : "ghost"}" ${canCallSmall ? "" : "disabled"}>${confirmPending.smallTichu ? "정말요? 다시 눌러서 확정" : "스몰티츄 콜! (+100/-100)"}</button>
    </div>
    <div class="hand-cards">${isSpectator ? "" : handHTML}</div>
    <div class="hand-actions">
      <button id="primaryActionBtn" class="primary" ${primaryEnabled ? "" : "disabled"}>${primaryLabel}</button>
    </div>
  `;

  renderGameFrame({ centerHtml, bottomHtml, statusLine });

  document.querySelectorAll(".hand-cards .card").forEach((el) => {
    el.onclick = () => { const id = el.dataset.id; if (selected.has(id)) selected.delete(id); else selected.add(id); render(); };
  });
  const primaryBtn = document.getElementById("primaryActionBtn");
  if (primaryBtn) primaryBtn.onclick = () => {
    if (selected.size > 0) {
      const ids = Array.from(selected);
      const cards = ids.map((id) => myHand.find((c) => c.id === id));
      const isSparrowLead = isLeading && cards.some((c) => c.special === "sparrow");
      if (isSparrowLead) openSparrowModal((rank) => submitPlay(ids, rank));
      else submitPlay(ids, null);
    } else {
      socket.emit("passTurn", null, (res) => { if (res && res.error) showToast(res.error); });
    }
  };
  const smallBtn = document.getElementById("smallTichuBtn");
  if (smallBtn) smallBtn.onclick = () => handleDoubleConfirm("smallTichu", () => socket.emit("callTichu"));

  if (state.pendingDragonChoice === mySeat) openDragonModal();

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
    if (!state.turnDeadline || state.pendingDragonChoice !== null) { chip.textContent = ""; return; }
    const remain = Math.max(0, Math.ceil((state.turnDeadline - Date.now()) / 1000));
    chip.textContent = `${seatLabel(state.turnSeat)} · ${remain}초`;
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
    <div class="modal">
      <h3 class="accent" style="font-size:26px">용(龍)이 이겼습니다</h3>
      <div class="status-line">이 트릭의 카드를 상대팀 누구에게 줄까요?</div>
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
  app.innerHTML = `
    <div class="lobby">
      <h2 class="accent" style="font-size:32px">라운드 결과</h2>
      ${s.doubleWin !== null ? `<div class="status-line">${TEAM_NAME[s.doubleWin]} 더블윈! (+200)</div>` : ""}
      <table class="summary-table">
        <tr><th></th><th>${TEAM_NAME[0]}</th><th>${TEAM_NAME[1]}</th></tr>
        <tr><td>이번 라운드 점수</td><td>${s.teamPoints[0]}</td><td>${s.teamPoints[1]}</td></tr>
        <tr><td>티츄 보너스</td><td>${s.bonuses[0]}</td><td>${s.bonuses[1]}</td></tr>
        <tr><td><b>누적 점수</b></td><td><b>${state.teamScores[0]}</b></td><td><b>${state.teamScores[1]}</b></td></tr>
      </table>
      ${!isSpectator ? `<button class="primary" id="nextHandBtn">다음 라운드</button>` : `<div class="status-line">관전 중</div>`}
    </div>
  `;
  const btn = document.getElementById("nextHandBtn");
  if (btn) btn.onclick = () => socket.emit("nextHand");
}

/* ---------------- Game Over ---------------- */
function renderGameOver() {
  const winner = state.teamScores[0] > state.teamScores[1] ? 0 : 1;
  app.innerHTML = `
    <div class="lobby">
      <h2 class="accent" style="font-size:40px">${TEAM_NAME[winner]} 승리!</h2>
      <table class="summary-table">
        <tr><th>${TEAM_NAME[0]}</th><th>${TEAM_NAME[1]}</th></tr>
        <tr><td>${state.teamScores[0]}</td><td>${state.teamScores[1]}</td></tr>
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
    g.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + 0.01);
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
      g.gain.exponentialRampToValueAtTime(0.13, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
      o.connect(g); g.connect(ctx.destination);
      o.start(t0); o.stop(t0 + 0.18);
    });
  } catch (e) { /* 오디오 미지원 환경은 조용히 무시 */ }
}

let lastTrickPlayCount = 0;
function checkPlaySound(newState) {
  if (newState && newState.currentTrick) {
    const n = newState.currentTrick.plays.length;
    if (n > lastTrickPlayCount) playCardSound();
    lastTrickPlayCount = n;
  }
}

let lastSeenActionSeq = 0;
function checkActionEvents(s) {
  if (s && typeof s.actionSeq === "number" && s.actionSeq > lastSeenActionSeq) {
    lastSeenActionSeq = s.actionSeq;
    if (s.lastAction && s.lastAction.type === "trickStart") playTrickStartSound();
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

socket.on("state", (s) => {
  checkPlaySound(s);
  checkActionEvents(s);
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
socket.on("connect", () => render());
socket.on("globalChatMessage", (m) => {
  globalChatMessages.push(m);
  if (globalChatMessages.length > 100) globalChatMessages.shift();
  if (!state) render(); // 메인화면(방 밖)에 있을 때만 즉시 반영
});

render();
