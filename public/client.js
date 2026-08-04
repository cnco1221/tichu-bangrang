const socket = io();
const app = document.getElementById("app");

let myName = localStorage.getItem("tichu_name") || "";
let myRoom = localStorage.getItem("tichu_room") || "";
let mySeat = null;
let isSpectator = false;
let state = null;
let selected = new Set();
let exchangeStage = { left: null, across: null, right: null };
let toastTimer = null;
let menuOpen = false;
let chatOpen = false;
let chatMessages = [];
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

function cardHTML(card, { small = false, isSelected = false } = {}) {
  const cls = ["card"];
  if (small) cls.push("small");
  if (card.special) cls.push(`special-${card.special}`);
  if (isSelected) cls.push("selected");

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

function render() {
  if (timerTickHandle && (!state || state.phase !== "play")) { clearInterval(timerTickHandle); timerTickHandle = null; }
  if (!state) return renderLanding();
  if (state.phase === "lobby") return renderLobby();
  if (state.phase === "grand") return renderGrand();
  if (state.phase === "exchange") return renderExchange();
  if (state.phase === "play") return renderPlay();
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
      <form id="joinForm">
        <input type="text" id="codeInput" placeholder="방 코드 (예: ABCD)" value="${myRoom}" maxlength="4" required />
        <div class="row">
          <button type="submit" id="joinBtn">참가하기</button>
          <button type="button" id="spectateBtn">관전하기</button>
        </div>
      </form>
    </div>
  `;
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
  const doJoin = (asSpectator) => {
    myName = getName();
    const code = document.getElementById("codeInput").value.trim().toUpperCase();
    localStorage.setItem("tichu_name", myName);
    socket.emit("joinRoom", { code, name: myName, asSpectator }, (res) => {
      if (res.error) return showToast(res.error);
      mySeat = res.seat; myRoom = res.code; isSpectator = !!res.spectator;
      localStorage.setItem("tichu_room", myRoom);
    });
  };
  document.getElementById("joinForm").onsubmit = (e) => { e.preventDefault(); doJoin(false); };
  document.getElementById("spectateBtn").onclick = () => doJoin(true);
}

/* ---------------- Lobby ---------------- */
function renderLobby() {
  const seats = state.players.map((p, i) => `
    <div class="seat-card ${p ? "filled" : ""} ${p && p.ready ? "ready" : ""}">
      ${p && p.ready ? `<div class="ready-tag">준비완료</div>` : ""}
      <div class="team-tag">${i % 2 === 0 ? "팀 A" : "팀 B"} · 좌석 ${i + 1}</div>
      <div>${p ? p.name + (p.isBot ? " 🤖" : "") + (i === mySeat ? " (나)" : "") : "대기 중..."}</div>
    </div>
  `).join("");
  const myReady = mySeat !== null && state.players[mySeat] ? state.players[mySeat].ready : false;
  const hasEmptySeat = !state.players.every((p) => p !== null);
  const canJoinSeat = isSpectator && hasEmptySeat;

  app.innerHTML = `
    <div class="lobby">
      <div>방 코드</div>
      <div class="room-code">${state.code}</div>
      <div class="seat-grid">${seats}</div>
      ${!isSpectator ? `<button class="primary" id="readyBtn">${myReady ? "준비 취소" : "준비 완료"}</button>` : ""}
      ${hasEmptySeat ? `<button id="addBotBtn">봇 추가</button>` : ""}
      ${canJoinSeat ? `<button id="takeSeatBtn">빈 자리에 참여하기</button>` : ""}
      <div class="spectator-bar">
        <div class="chip">관전자 ${state.spectatorCount}명</div>
        ${state.spectatorCount > 0 ? `<button class="small" id="showSpecBtn">누구인지 보기</button>` : ""}
      </div>
      <div class="status-line">4명 전원이 준비 완료하면 자동으로 시작돼요 (봇은 자동 준비완료)</div>
    </div>
  `;
  const readyBtn = document.getElementById("readyBtn");
  if (readyBtn) readyBtn.onclick = () => socket.emit("setReady", { ready: !myReady });
  const addBotBtn = document.getElementById("addBotBtn");
  if (addBotBtn) addBotBtn.onclick = () => socket.emit("addBot", null, (res) => { if (res && res.error) showToast(res.error); });
  const takeSeatBtn = document.getElementById("takeSeatBtn");
  if (takeSeatBtn) takeSeatBtn.onclick = () => socket.emit("takeSeat", null, (res) => {
    if (res && res.ok) { mySeat = res.seat; isSpectator = false; }
    else showToast("빈 자리가 없어요");
  });
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
}

/* ---------------- Grand(라지) Tichu ---------------- */
function renderGrand() {
  if (isSpectator) return renderSpectatorWait("라지티츄 콜 여부를 결정하는 중...");
  const myHand = (state.first8 || []).map((c) => cardHTML(c)).join("");
  const decided = state.grandDecision[mySeat] !== null;
  const waitingOn = state.players.map((p, i) => p && state.grandDecision[i] === null ? p.name : null).filter(Boolean);
  app.innerHTML = `
    <div class="lobby">
      <h2 class="accent" style="font-size:32px">라지티츄?</h2>
      <div class="status-line">처음 8장을 보고 라지티츄를 부를지 결정하세요 (성공 +200 / 실패 -200)</div>
      <div class="hand-cards" style="max-width:520px">${myHand}</div>
      <div class="hand-actions">
        <button class="primary" id="grandYes" ${decided ? "disabled" : ""}>라지티츄 콜!</button>
        <button id="grandNo" ${decided ? "disabled" : ""}>패스</button>
      </div>
      <div class="status-line">${decided ? "선택 완료 — 다른 플레이어를 기다리는 중" : ""}</div>
      ${waitingOn.length ? `<div class="chip">대기: ${waitingOn.join(", ")}</div>` : ""}
    </div>
  `;
  const y = document.getElementById("grandYes"), n = document.getElementById("grandNo");
  if (y) y.onclick = () => socket.emit("callGrandTichu", { wantsLarge: true });
  if (n) n.onclick = () => socket.emit("callGrandTichu", { wantsLarge: false });
}

function renderSpectatorWait(msg) {
  app.innerHTML = `<div class="lobby"><h2 class="accent" style="font-size:30px">관전 중</h2><div class="status-line">${msg}</div></div>`;
}

/* ---------------- Exchange ---------------- */
function renderExchange() {
  if (isSpectator) return renderSpectatorWait("카드 교환 중...");
  const submitted = state.exchangeSubmitted[mySeat];
  const hand = state.myHand || [];
  const staged = new Set([exchangeStage.left, exchangeStage.across, exchangeStage.right].filter(Boolean));
  const handHTML = hand.map((c) => cardHTML(c, { isSelected: staged.has(c.id) })).join("");

  const slot = (key, label) => {
    const id = exchangeStage[key];
    const card = id ? hand.find((c) => c.id === id) : null;
    return `<div class="exchange-slot ${card ? "filled" : ""}" data-slot="${key}">
      <div class="label">${label}</div>
      ${card ? cardHTML(card, { small: true }) : "탭해서 배치"}
    </div>`;
  };
  const waitingOn = state.players.map((p, i) => p && !state.exchangeSubmitted[i] ? p.name : null).filter(Boolean);

  app.innerHTML = `
    <div class="lobby">
      <h2 class="accent" style="font-size:32px">카드 교환</h2>
      <div class="status-line">카드 3장을 골라 세 사람에게 한 장씩 나눠주세요</div>
      <div class="exchange-slots">
        ${slot("right", "왼쪽 사람")}
        ${slot("across", "파트너")}
        ${slot("left", "오른쪽 사람")}
      </div>
      <div class="hand-cards" style="max-width:640px">${handHTML}</div>
      <button class="primary" id="submitExchange" ${submitted || staged.size !== 3 ? "disabled" : ""}>${submitted ? "제출 완료 — 대기 중" : "교환 확정"}</button>
      ${waitingOn.length ? `<div class="chip">대기: ${waitingOn.join(", ")}</div>` : ""}
    </div>
  `;

  if (!submitted) {
    document.querySelectorAll(".hand-cards .card").forEach((el) => {
      el.onclick = () => {
        const id = el.dataset.id;
        for (const k of ["left", "across", "right"]) {
          if (exchangeStage[k] === id) { exchangeStage[k] = null; render(); return; }
        }
        const emptyKey = ["left", "across", "right"].find((k) => !exchangeStage[k]);
        if (!emptyKey) return showToast("이미 3장을 다 배치했어요. 슬롯을 눌러 해제하세요");
        exchangeStage[emptyKey] = id;
        render();
      };
    });
    document.querySelectorAll(".exchange-slot").forEach((el) => {
      el.onclick = () => { const key = el.dataset.slot; if (exchangeStage[key]) { exchangeStage[key] = null; render(); } };
    });
    const btn = document.getElementById("submitExchange");
    if (btn) btn.onclick = () => socket.emit("submitExchange", { left: exchangeStage.left, across: exchangeStage.across, right: exchangeStage.right });
  }
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
  return `<div class="seat-box ${posClass} ${isTurn ? "turn" : ""} ${connected === false ? "disconnected" : ""}">
    <div class="role">${role}</div>
    <div class="nick">${seatLabel(seat)}${finished}</div>
    <div class="count">${count}장</div>
    ${badge}
  </div>`;
}

function comboLabel(combo) {
  if (!combo) return "";
  if (combo.type === "dog") return "개";
  if (combo.type === "single") {
    const c = combo.cards[0];
    if (c.special === "dragon") return "용 싱글";
    if (c.special === "phoenix") return "봉황 싱글";
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
  const viewerSeat = isSpectator ? 0 : mySeat; // 관전자는 임의 기준(회전 없음) - 좌석0을 남으로 고정
  const rightSeat = (viewerSeat + 1) % 4; // 동(상대)
  const topSeat = (viewerSeat + 2) % 4;   // 북(아군)
  const leftSeat = (viewerSeat + 3) % 4;  // 서(상대)

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
  const requestedTag = state.requestedRank
    ? `<div class="requested-tag ${state.requestSatisfied ? "satisfied" : ""}">콜 : ${RANK_LABEL[state.requestedRank]}${state.requestSatisfied ? " ✓" : ""}</div>`
    : "";

  const myHand = state.myHand || [];
  const handHTML = myHand.map((c) => cardHTML(c, { isSelected: selected.has(c.id) })).join("");

  const isMyTurn = !isSpectator && state.turnSeat === mySeat && state.pendingDragonChoice === null;
  const isLeading = trick.lastCombo === null;
  const canCallSmall = !isSpectator && !state.tichuCalled[mySeat] && myHand.length === 14 && !state.finished[mySeat];

  const cancelVotes = state.cancelVotes || [];
  const iVoted = mySeat !== null && cancelVotes.includes(mySeat);

  const primaryLabel = selected.size > 0 ? "내기" : "패스";
  const canAttemptPlay = !isSpectator && !state.finished[mySeat] && state.pendingDragonChoice === null;
  const primaryEnabled = selected.size > 0 ? canAttemptPlay : (isMyTurn && !isLeading);

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
        <div class="seat-center trick-area">
          ${requestedTag}
          <div class="trick-plays">${plays || `<div class="trick-empty">${isLeading ? "리드를 기다리는 중" : ""}</div>`}</div>
          ${lastPlay ? `<div class="combo-label"><div class="who">${seatLabel(lastPlay.seat)}</div><div class="what">${comboLabelText}</div></div>` : ""}
        </div>
        ${seatBoxHTML(rightSeat, "seat-east", "상대")}
        ${seatBoxHTML(viewerSeat, "seat-south", isSpectator ? "관전" : "나")}
      </div>
      <div class="hand-wrap">
        <div class="status-line">${isSpectator ? "관전 중" : isMyTurn ? (isLeading ? "당신 차례입니다 — 리드하세요" : "당신 차례입니다") : `${seatLabel(state.turnSeat)}의 차례...`}</div>
        <div class="hand-actions">
          <button id="smallTichuBtn" class="ghost" ${canCallSmall ? "" : "disabled"}>스몰티츄 콜! (+100/-100)</button>
        </div>
        <div class="hand-cards">${isSpectator ? "" : handHTML}</div>
        <div class="hand-actions">
          <button id="primaryActionBtn" class="primary" ${primaryEnabled ? "" : "disabled"}>${primaryLabel}</button>
        </div>
      </div>
    </div>
    ${menuOpen ? `<div class="menu-dropdown">
      <button id="voteCancelMenuBtn" class="danger">게임 취소 제안</button>
      <button id="leaveBtn">방 나가기</button>
    </div>` : ""}
    <button class="chat-fab icon-btn" id="chatFab">💬</button>
    ${chatOpen ? renderChatPanel() : ""}
  `;

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
  if (smallBtn) smallBtn.onclick = () => socket.emit("callTichu");
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
  wireChatPanel();

  if (state.pendingDragonChoice === mySeat) openDragonModal();

  startTimerTick();
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
      ${chatMessages.map((m) => `<div class="msg"><span class="who">${m.name || "?"}</span>${m.text}</div>`).join("")}
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
  };
  const sendBtn = document.getElementById("chatSendBtn");
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

let lastTrickPlayCount = 0;
function checkPlaySound(newState) {
  if (newState && newState.currentTrick) {
    const n = newState.currentTrick.plays.length;
    if (n > lastTrickPlayCount) playCardSound();
    lastTrickPlayCount = n;
  }
}

function applyTichuBackground(s) {
  const anyLarge = s && s.tichuCalled && s.tichuCalled.some((t) => t === "large");
  const anySmall = s && s.tichuCalled && s.tichuCalled.some((t) => t === "small");
  document.body.classList.toggle("tichu-large-bg", !!anyLarge);
  document.body.classList.toggle("tichu-small-bg", !anyLarge && !!anySmall);
}

socket.on("state", (s) => {
  checkPlaySound(s);
  state = s;
  applyTichuBackground(s);
  render();
});
socket.on("chatMessage", (m) => { chatMessages.push(m); if (chatOpen) render(); });
socket.on("connect", () => render());

render();
