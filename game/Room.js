const { dealHands, sortHand } = require("./deck");
const { classify, canBeat, existsLegalPlayContainingRank } = require("./combos");

const TEAM_OF_SEAT = [0, 1, 0, 1]; // 좌석0,2 = 팀A(0) / 좌석1,3 = 팀B(1)
const TARGET_SCORE = 1000;
const TURN_SECONDS = 30;
const MAX_ABANDON = 3;
const DISCONNECT_GRACE_MS = 3 * 60 * 1000; // 접속이 끊긴 뒤 이 시간 동안은 턴 시간초과로 잠수 스택을 추가로 안 쌓음(재접속 유예기간)

function otherTeam(t) { return t === 0 ? 1 : 0; }
function teammateOf(seat) { return (seat + 2) % 4; }
function leftOf(seat) { return (seat + 1) % 4; }
function acrossOf(seat) { return (seat + 2) % 4; }
function rightOf(seat) { return (seat + 3) % 4; }

class Room {
  constructor(code, notify) {
    this.code = code;
    this.notify = notify || (() => {}); // 타이머 등 비동기 이벤트 발생 시 서버에 브로드캐스트 요청
    this.players = [null, null, null, null]; // {socketId, name, ready, connected, abandonCount}
    this.spectators = []; // {socketId, name}
    this.phase = "lobby"; // lobby, grand, exchange, play, roundEnd, gameover, aborted
    this.teamScores = [0, 0];
    this.cancelVotes = new Set();
    this.abortReason = null;
    this.turnTimer = null;
    this.turnDeadline = null;
    this.lastAction = null; // { type: 'pass', seat } 최근 이벤트(연출용)
    this.actionSeq = 0;
    this._pidCounter = 0; // 좌석이 섞이거나 옮겨져도 "이 사람"을 계속 추적하기 위한 고유 id 발급용
    this.hostPid = null; // 현재 방장의 pid (좌석 인덱스가 아니라 사람 자체를 추적)
    this.fixedSeats = false; // true면 게임 시작 시 좌석을 섞지 않고 그대로 시작
    this.ranked = false; // 등급전이면 무조건 팀 랜덤 + 종료 시 승/패 기록
    this.pendingRankedResult = null; // { winners:[nickname], losers:[nickname] } - 서버가 소비 후 null로 비움
    this.roundHistory = []; // [{ round, teamPoints: {0,1} }, ...] - 라운드별 점수 기록(게임 전체 기준)
    this.EXCHANGE_SUMMARY_DELAY_MS = 3200; // 교환 완료 후 실제 플레이 시작까지 대기(클라 요약화면과 맞춤). 테스트에서 0으로 낮춰 씀
    this.LAST_CARD_DELAY_MS = 1500; // 라운드를 끝낸 마지막 카드가 화면에 보인 뒤 결과창으로 넘어가기까지 대기
    this.ROUND_END_AUTO_MS = 10000; // 라운드 결과창에서 자동으로 다음 라운드로 넘어가기까지 대기
    this._roundEndTimer = null;
    this.roundEndDeadline = null;
    this._grandTimer = null;
    this.grandDeadline = null;
    this.lastTrickWin = null; // { seat, seq } - 방금 트릭을 가져간 사람(보드 표시용)
    this.resetHandState();
  }

  resetHandState() {
    this.hands = [[], [], [], []];
    this.first8 = [[], [], [], []];
    this.grandDecision = [null, null, null, null];
    this.tichuCalled = [null, null, null, null]; // null | 'small' | 'large'
    this.exchangeSubmit = [null, null, null, null];
    this.exchangeReceived = [[], [], [], []];
    this.wonPiles = [[], [], [], []];
    this.finishOrder = [];
    this.finished = [false, false, false, false];
    this.currentTrick = { plays: [], leaderSeat: null, lastCombo: null, lastSeat: null, passedSeats: [] };
    this.turnSeat = null;
    this.lastAction = null; // 이전 라운드 마지막 이벤트(패스 등)가 새 라운드까지 안 남게 초기화
    this.pendingDragonChoice = null;
    this.pendingDogTransfer = null; // 개를 낸 뒤 파트너에게 턴 넘기기 전 1초 대기(연출용 잠금)
    this.doubleWin = null;
    this.requestedRank = null;
    this.requestSatisfied = true;
    this.lastDragonGift = null; // { from, to } - 용으로 이긴 트릭을 누구에게 줬는지(보드 표시용)
    this.strikesThisHand = [0, 0, 0, 0]; // 이번 라운드 동안 새로 쌓인 잠수 스택 수(0이면 다음 라운드 시작 시 전체 스택 초기화)
    this.pendingRoundEnd = false; // 라운드를 끝낸 마지막 카드를 잠깐 보여주는 동안 추가 액션을 막는 잠금
    this._clearExchangeTimer();
    this._clearTimer();
    this._clearRoundEndTimer();
    this._clearGrandTimer();
  }

  /* ---------------- 좌석 / 관전자 ---------------- */

  addPlayer(socketId, name, token, memberNickname) {
    const seat = this.players.findIndex((p) => p === null);
    if (seat === -1) return null;
    const pid = ++this._pidCounter;
    this.players[seat] = { socketId, name: name || `플레이어${seat + 1}`, ready: false, connected: true, abandonCount: 0, isBot: false, token: token || null, disconnectTimer: null, memberNickname: memberNickname || null, pid };
    if (this.hostPid === null) this.hostPid = pid; // 방에 처음 들어온 사람이 방장
    return seat;
  }

  addBot(seat, actorSeat) {
    if (this.players[seat]) return false;
    if (actorSeat !== undefined && actorSeat !== null && !this.isHost(actorSeat)) return false; // 방장만 가능
    if (this.ranked) return false; // 등급전 중엔 봇을 추가할 수 없음
    const humanCount = this.players.filter((p) => p && !p.isBot).length;
    if (humanCount === 0) return false; // 최소 한 자리는 사람이어야 함(전원 봇 방지)
    this.players[seat] = { socketId: null, name: `봇${seat + 1}`, ready: true, connected: true, abandonCount: 0, isBot: true, pid: ++this._pidCounter };
    return true;
  }

  // 방장이 사라졌으면(방 나감/관전 전환 등) 남아있는 사람 중 한 명에게 방장을 넘김. 봇/관전자는 방장이 될 수 없음.
  _reassignHostIfNeeded() {
    const stillValid = this.players.some((p) => p && !p.isBot && p.pid === this.hostPid);
    if (stillValid) return;
    const candidate = this.players.find((p) => p && !p.isBot);
    this.hostPid = candidate ? candidate.pid : null;
  }

  isHost(seat) {
    const p = this.players[seat];
    return !!(p && !p.isBot && p.pid === this.hostPid);
  }

  removeBot(seat) {
    if (this.phase !== "lobby") return false;
    const p = this.players[seat];
    if (!p || !p.isBot) return false;
    this.players[seat] = null;
    return true;
  }

  isBot(seat) {
    const p = this.players[seat];
    return !!(p && p.isBot);
  }

  addSpectator(socketId, name) {
    this.spectators.push({ socketId, name: name || "관전자" });
  }

  removeBySocket(socketId) {
    const seat = this.players.findIndex((p) => p && p.socketId === socketId);
    if (seat !== -1) {
      if (this.phase !== "lobby" && this.phase !== "gameover" && this.phase !== "aborted") {
        // 게임 도중 연결이 끊겨도 즉시 무효 처리하지 않고 잠수 스택만 하나 쌓음(재접속 가능)
        const p = this.players[seat];
        p.connected = false;
        p.socketId = null;
        p.disconnectedAt = Date.now();
        this._addAbandonStrike(seat);
      } else {
        this.players[seat] = null;
        this._reassignHostIfNeeded();
      }
    }
    const specIdx = this.spectators.findIndex((s) => s.socketId === socketId);
    if (specIdx !== -1) this.spectators.splice(specIdx, 1);
    return seat;
  }

  // 같은 토큰을 들고 다시 접속하면 원래 좌석으로 복귀(연결 끊긴 좌석만 대상)
  reconnectPlayer(token, newSocketId) {
    if (!token) return null;
    // 연결이 끊긴 사람만 매칭하면, 탭을 닫아도 소켓이 핑 타임아웃으로 실제 끊기기까지 수십 초의
    // 유예 시간(좀비 연결) 동안엔 서버가 아직 "연결됨"으로 보고 있어서 재입장이 관전으로 빠지는 문제가 있었음.
    // 토큰이 맞으면 기존 연결 상태와 상관없이 항상 그 좌석을 새 소켓으로 넘겨줌(좀비 연결은 나중에 실제로
    // 끊길 때 이미 socketId가 바뀌어 있어 아무 영향도 안 줌)
    const seat = this.players.findIndex((p) => p && p.token === token);
    if (seat === -1) return null;
    this.players[seat].socketId = newSocketId;
    this.players[seat].connected = true;
    this.players[seat].disconnectedAt = null;
    return seat;
  }

  _addAbandonStrike(seat) {
    const p = this.players[seat];
    if (!p) return;
    p.abandonCount = (p.abandonCount || 0) + 1;
    this.strikesThisHand[seat] = (this.strikesThisHand[seat] || 0) + 1;
    if (p.abandonCount >= MAX_ABANDON) {
      this._abort(`${p.name}님이 잠수 ${MAX_ABANDON}회로 게임이 무효 처리되었어요`);
    }
  }

  seatBySocket(socketId) {
    return this.players.findIndex((p) => p && p.socketId === socketId);
  }

  isFull() {
    return this.players.every((p) => p !== null);
  }

  takeEmptySeat(socketId, name) {
    if (!this.isFull()) {
      const seat = this.addPlayer(socketId, name);
      const idx = this.spectators.findIndex((s) => s.socketId === socketId);
      if (idx !== -1) this.spectators.splice(idx, 1);
      this._reassignHostIfNeeded(); // 방장이 없던 상태였다면 새로 들어온 사람이 방장이 될 수 있음
      return seat;
    }
    return null;
  }

  setReady(seat, ready) {
    if (!this.players[seat]) return;
    this.players[seat].ready = !!ready;
  }

  switchToSpectator(seat) {
    if (this.phase !== "lobby") return false;
    const p = this.players[seat];
    if (!p) return false;
    const humanCount = this.players.filter((x) => x && !x.isBot).length;
    if (!p.isBot && humanCount <= 1) return false; // 남은 사람이 한 명뿐이면 관전으로 못 감
    this.players[seat] = null;
    this.spectators.push({ socketId: p.socketId, name: p.name });
    this._reassignHostIfNeeded(); // 방장이 관전으로 가면 다른 사람에게 방장이 넘어감
    return true;
  }

  // 자리 교체는 사람과 맞바꾸는 게 아니라 "빈 자리로 이동"만 가능
  moveToEmptySeat(fromSeat, toSeat) {
    if (this.phase !== "lobby") return false;
    if (!this.players[fromSeat]) return false;
    if (this.players[toSeat]) return false; // 목적지가 비어있어야 함
    this.players[toSeat] = this.players[fromSeat];
    this.players[fromSeat] = null;
    return true;
  }

  setFixedSeats(enabled, actorSeat) {
    if (this.phase !== "lobby") return false;
    if (actorSeat !== undefined && !this.isHost(actorSeat)) return false; // 방장만 가능
    if (this.ranked && enabled) return false; // 등급전이면 지정석을 켤 수 없음
    this.fixedSeats = !!enabled;
    return true;
  }

  setRanked(enabled, actorSeat) {
    if (this.phase !== "lobby") return false;
    if (actorSeat !== undefined && !this.isHost(actorSeat)) return false; // 방장만 가능
    if (enabled && this.players.some((p) => p && p.isBot)) return false; // 봇이 한 명이라도 있으면 등급전 불가
    this.ranked = !!enabled;
    if (this.ranked) this.fixedSeats = false; // 등급전은 무조건 팀 랜덤(지정석 해제+잠금)
    return true;
  }

  _shuffleSeats() {
    const arr = this.players.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    this.players = arr;
  }

  /* ---------------- 게임 시작 ---------------- */

  startGame() {
    if (!this.isFull() || !this.players.every((p) => p.ready)) return false;
    if (!this.fixedSeats) this._shuffleSeats(); // 지정석이 꺼져있으면 시작할 때 좌석(팀)을 무작위로 섞음
    this.teamScores = [0, 0];
    this.roundHistory = [];
    for (const p of this.players) p.abandonCount = 0;
    this.cancelVotes.clear();
    this.abortReason = null;
    this.startHand();
    return true;
  }

  startHand() {
    // 직전 라운드 동안 잠수 스택이 하나도 안 쌓인 사람은 스택을 초기화해줌
    for (let s = 0; s < 4; s++) {
      if (this.players[s] && (this.strikesThisHand[s] || 0) === 0) {
        this.players[s].abandonCount = 0;
      }
    }
    this.resetHandState();
    const { first8, full14 } = dealHands();
    this.first8 = first8;
    this._full14 = full14;
    this.phase = "grand";
    this._armGrandTimer();
  }

  _armGrandTimer() {
    this._clearGrandTimer();
    const ms = 30000; // 라지티츄 결정 제한시간 30초
    this.grandDeadline = Date.now() + ms;
    const room = this;
    this._grandTimer = setTimeout(() => room._onGrandTimeout(), ms);
  }

  _clearGrandTimer() {
    if (this._grandTimer) clearTimeout(this._grandTimer);
    this._grandTimer = null;
    this.grandDeadline = null;
  }

  _onGrandTimeout() {
    if (this.phase !== "grand") return;
    for (let s = 0; s < 4; s++) {
      if (this.phase !== "grand") break; // 도중에 잠수 스택으로 게임이 무효 처리됐으면 중단
      if (this.grandDecision[s] === null) {
        this._addAbandonStrike(s);
        if (this.phase !== "grand") break;
        this.callGrandTichu(s, false); // 시간 초과 시 자동 패스
      }
    }
    this.notify(this.code);
  }

  callGrandTichu(seat, wantsLarge) {
    if (this.phase !== "grand" || this.grandDecision[seat] !== null) return;
    if (wantsLarge && this.tichuCalled[seat] === "small") return; // 이미 스몰티츄를 선언했으면 라지티츄로 바꿀 수 없음
    this.grandDecision[seat] = !!wantsLarge;
    if (wantsLarge) this.tichuCalled[seat] = "large";
    if (this.grandDecision.every((d) => d !== null)) {
      this._clearGrandTimer();
      this.hands = this._full14.map((h) => sortHand(h));
      this.phase = "exchange";
      this._armExchangeTimer();
    }
  }

  _armExchangeTimer() {
    this._clearExchangeTimer();
    const ms = 60000; // 카드 교환 제한시간 1분
    this.exchangeDeadline = Date.now() + ms;
    const room = this;
    this._exchangeTimer = setTimeout(() => room._onExchangeTimeout(), ms);
  }

  _clearExchangeTimer() {
    if (this._exchangeTimer) clearTimeout(this._exchangeTimer);
    this._exchangeTimer = null;
    this.exchangeDeadline = null;
  }

  _onExchangeTimeout() {
    if (this.phase !== "exchange") return;
    for (let s = 0; s < 4; s++) {
      if (this.phase !== "exchange") break; // 도중에 전원 제출 완료되거나 잠수 스택으로 무효 처리됐으면 중단
      if (this.exchangeSubmit[s]) continue;
      this._addAbandonStrike(s);
      if (this.phase !== "exchange") break;
      this.submitExchange(s, this._autoExchangePicks(s));
    }
    this.notify(this.code);
  }

  submitExchange(seat, { left, across, right }) {
    if (this.phase !== "exchange" || this.exchangeSubmit[seat]) return;
    const hand = this.hands[seat];
    const ids = [left, across, right];
    if (new Set(ids).size !== 3) return;
    for (const id of ids) if (!hand.find((c) => c.id === id)) return;
    this.exchangeSubmit[seat] = { left, across, right };
    if (this.exchangeSubmit.every((e) => e !== null)) this._resolveExchange();
  }

  _resolveExchange() {
    this._clearExchangeTimer();
    const takeOut = (seat, id) => {
      const hand = this.hands[seat];
      const idx = hand.findIndex((c) => c.id === id);
      return hand.splice(idx, 1)[0];
    };
    const incoming = [[], [], [], []];
    for (let seat = 0; seat < 4; seat++) {
      const sub = this.exchangeSubmit[seat];
      const cLeft = takeOut(seat, sub.left);
      const cAcross = takeOut(seat, sub.across);
      const cRight = takeOut(seat, sub.right);
      incoming[leftOf(seat)].push({ from: seat, card: cLeft });
      incoming[acrossOf(seat)].push({ from: seat, card: cAcross });
      incoming[rightOf(seat)].push({ from: seat, card: cRight });
    }
    for (let seat = 0; seat < 4; seat++) {
      for (const { card } of incoming[seat]) this.hands[seat].push(card);
      this.hands[seat] = sortHand(this.hands[seat]);
      this.exchangeReceived[seat] = incoming[seat].map((x) => ({ from: x.from, card: x.card }));
    }
    const starter = this.hands.findIndex((h) => h.some((c) => c.special === "sparrow"));
    const startSeat = starter === -1 ? 0 : starter;
    this.phase = "play";
    this.turnSeat = null; // 클라이언트가 "받은 카드" 요약을 보여주는 동안 아무도(봇 포함) 못 내게 잠금
    this.currentTrick.leaderSeat = startSeat;
    const room = this;
    setTimeout(() => {
      if (room.phase !== "play" || room.turnSeat !== null) return; // 그 사이 취소/무효 처리됐으면 무시
      room.turnSeat = startSeat;
      room._armTimer();
      room.notify(room.code);
    }, this.EXCHANGE_SUMMARY_DELAY_MS); // 클라이언트의 3초 요약 화면보다 살짝 길게
  }

  callTichu(seat) {
    if (this.finished[seat]) return false;
    if (this.tichuCalled[seat]) return false; // 이미 라지/스몰 중 하나를 선언함
    if (this.phase === "play") {
      if (this.hands[seat].length !== 14) return false; // 플레이 단계에선 아직 한 장도 안 낸 상태(14장)여야 함
    } else if (this.phase !== "grand" && this.phase !== "exchange") {
      return false;
    }
    this.tichuCalled[seat] = "small";
    if (this.phase === "grand" && this.grandDecision[seat] === null) {
      this.grandDecision[seat] = false; // 스몰티츄를 선언하면 라지티츄는 자동으로 패스 처리
      if (this.grandDecision.every((d) => d !== null)) {
        this._clearGrandTimer();
        this.hands = this._full14.map((h) => sortHand(h));
        this.phase = "exchange";
        this._armExchangeTimer();
      }
    }
    return true;
  }

  /* ---------------- 카드 플레이 ---------------- */

  // cardIds: 배열, opts: { requestRank } (참새를 리드로 낼 때 요청할 숫자)
  playCards(seat, cardIds, opts = {}) {
    if (this.phase !== "play") return { error: "지금은 낼 수 없어요" };
    if (this.pendingDragonChoice !== null) return { error: "용 카드를 받을 사람을 먼저 정해주세요" };
    if (this.pendingDogTransfer !== null) return { error: "개 카드가 전달되는 중이에요" };
    if (this.pendingRoundEnd) return { error: "라운드가 곧 종료돼요" };
    if (this.finished[seat]) return { error: "이미 낸 사람이에요" };

    const hand = this.hands[seat];
    const cards = cardIds.map((id) => hand.find((c) => c.id === id)).filter(Boolean);
    if (cards.length !== cardIds.length) return { error: "카드를 찾을 수 없어요" };

    const combo = classify(cards);
    if (!combo) return { error: "족보가 성립하지 않아요" };
    const isBombCombo = combo.type === "bomb4" || combo.type === "bombStraight";
    const trickHasCards = this.currentTrick.plays.length > 0;

    if (seat !== this.turnSeat) {
      // 자기 차례가 아닐 때는 폭탄 인터럽트만 허용
      if (!isBombCombo) return { error: "당신 차례가 아니에요" };
      if (!trickHasCards) return { error: "아직 아무 카드도 안 나온 트릭에는 폭탄을 낼 수 없어요" };
      if (!canBeat(combo, this.currentTrick.lastCombo)) return { error: "이 폭탄으로는 이길 수 없어요" };
      return this._commitPlay(seat, combo, cards, { interrupt: true });
    }

    const isLeading = this.currentTrick.lastCombo === null;

    // 봉황 싱글 파워 재계산: 리드면 1.5(참새보다 살짝 높음), 따라갈 때는 직전 싱글보다 +0.5
    if (combo.isPhoenix && combo.type === "single") {
      if (isLeading) {
        combo.power = 1.5;
      } else if (this.currentTrick.lastCombo.type === "single") {
        // 용(200) 다음에 나와도 봉황이 용을 이길 수는 없어야 하므로 199로 상한을 둠
        combo.power = Math.min(this.currentTrick.lastCombo.power + 0.5, 199);
      }
    }

    if (combo.type === "dog" && !isLeading) return { error: "개는 리드할 때만 낼 수 있어요" };

    if (!isLeading && !isBombCombo) {
      if (!canBeat(combo, this.currentTrick.lastCombo)) return { error: "이전 조합보다 강하지 않아요(같은 족보·같은 장수여야 해요)" };
    }
    if (!isLeading && isBombCombo) {
      if (!canBeat(combo, this.currentTrick.lastCombo)) return { error: "이 폭탄으로는 이길 수 없어요" };
    }

    // 참새 요청 강제 이행 체크
    if (this.requestedRank !== null && !this.requestSatisfied) {
      const forced = existsLegalPlayContainingRank(hand, this.requestedRank, isLeading ? null : this.currentTrick.lastCombo);
      if (forced) {
        const includesRank = cards.some((c) => !c.special && c.rank === this.requestedRank);
        if (!includesRank) return { error: `참새가 요청한 숫자(${this.requestedRank})를 반드시 포함해서 내야 해요` };
      }
    }

    // 참새를 리드로 낼 때 요청 등록 (싱글 또는 스트레이트에 포함해서)
    // 주의: _commitPlay보다 먼저 등록해버리면, 지금 내는 바로 그 조합 안에 요청 숫자가 포함돼 있을 때
    // (예: 참새 포함 12345 스트레이트를 내면서 "5"를 콜) 자기 자신의 플레이로 즉시 이행 처리되는 버그가 생김.
    // 그래서 등록은 _commitPlay가 끝난 뒤로 미룸.
    let pendingRequestRank = null;
    if (isLeading && this.requestedRank === null && cards.some((c) => c.special === "sparrow")) {
      const r = opts.requestRank;
      if (r && r >= 2 && r <= 14) pendingRequestRank = r;
    }

    const result = this._commitPlay(seat, combo, cards, { interrupt: false });

    if (pendingRequestRank !== null) {
      this.requestedRank = pendingRequestRank;
      this.requestSatisfied = false;
    }

    return result;
  }

  _commitPlay(seat, combo, cards, { interrupt }) {
    const hand = this.hands[seat];
    for (const c of cards) {
      const idx = hand.findIndex((h) => h.id === c.id);
      hand.splice(idx, 1);
    }
    this.hands[seat] = hand;

    // 요청 이행 여부 갱신
    if (this.requestedRank !== null && !this.requestSatisfied) {
      if (cards.some((c) => !c.special && c.rank === this.requestedRank)) this.requestSatisfied = true;
    }

    this.currentTrick.plays.push({ seat, combo, cards });
    this.currentTrick.passCount = 0;
    this.currentTrick.passedSeats = this.currentTrick.passedSeats.filter((s) => s !== seat); // 다시 냈으니 그 사람의 "패스" 표시는 사라짐
    this.lastAction = { type: "play", seat }; // 누군가 패스한 뒤에 다른 사람이 카드를 내면, 그 패스 연출(사분면 회색)이 사라지게 함

    const wentOut = hand.length === 0;
    if (wentOut && !this.finished[seat]) {
      this.finished[seat] = true;
      this.finishOrder.push(seat);
    }

    if (combo.type === "dog") {
      const mate = teammateOf(seat);
      this.turnSeat = null; // 1초간 아무도 못 냄 (개는 어차피 아무도 못 막음)
      this.pendingDogTransfer = mate;
      this._clearTimer();
      const room = this;
      setTimeout(() => {
        if (room.phase !== "play" || room.pendingDogTransfer !== mate || room.pendingRoundEnd) return; // 그 사이 라운드/게임이 끝났으면 무시
        room.pendingDogTransfer = null;
        room._finishTrickAndLead(mate, { skipScoring: true, silent: true });
        room.notify(room.code);
      }, 1000);
      return this._afterPlayResult();
    }

    this.currentTrick.lastCombo = combo;
    this.currentTrick.lastSeat = seat;

    if (interrupt) {
      // 인터럽트 후에는 인터럽트한 사람 다음 순서부터 대응
      this.turnSeat = this._nextActiveSeat(seat);
    } else {
      this.turnSeat = this._nextActiveSeat(seat);
    }
    this._armTimer();
    return this._afterPlayResult();
  }

  pass(seat) {
    if (this.phase !== "play") return { error: "지금은 패스할 수 없어요" };
    if (this.pendingRoundEnd) return { error: "라운드가 곧 종료돼요" };
    if (this.turnSeat !== seat) return { error: "당신 차례가 아니에요" };
    if (this.currentTrick.lastCombo === null) return { error: "리드할 때는 패스할 수 없어요" };

    if (this.requestedRank !== null && !this.requestSatisfied) {
      const forced = existsLegalPlayContainingRank(this.hands[seat], this.requestedRank, this.currentTrick.lastCombo);
      if (forced) return { error: `참새가 요청한 숫자(${this.requestedRank})를 낼 수 있으면 패스할 수 없어요` };
    }

    this.currentTrick.passCount = (this.currentTrick.passCount || 0) + 1;
    if (!this.currentTrick.passedSeats.includes(seat)) this.currentTrick.passedSeats.push(seat);
    this.lastAction = { type: "pass", seat };
    this.actionSeq++;

    const activePlayers = [0, 1, 2, 3].filter((s) => !this.finished[s]);
    const needed = activePlayers.length - 1;
    if (this.currentTrick.passCount >= needed) {
      const winner = this.currentTrick.lastSeat;
      const winCombo = this.currentTrick.lastCombo;
      if (winCombo.isDragon) {
        this.pendingDragonChoice = winner;
        this._clearTimer();
        return { ok: true, needDragonChoice: winner };
      }
      this._finishTrickAndLead(winner);
      return { ok: true };
    }
    this.turnSeat = this._nextActiveSeat(seat);
    this._armTimer();
    return { ok: true };
  }

  chooseDragonRecipient(seat, recipientSeat) {
    if (this.pendingDragonChoice !== seat) return { error: "지금은 선택할 수 없어요" };
    const myTeam = TEAM_OF_SEAT[seat];
    if (TEAM_OF_SEAT[recipientSeat] === myTeam) return { error: "상대팀에게 줘야 해요" };
    const pile = this.currentTrick.plays.flatMap((p) => p.cards);
    this.wonPiles[recipientSeat].push(...pile);
    this.lastDragonGift = { from: seat, to: recipientSeat };
    this.pendingDragonChoice = null;
    this._leadNext(seat);
    return { ok: true };
  }

  _finishTrickAndLead(winnerSeat, { skipScoring, silent } = {}) {
    if (!skipScoring && !this.currentTrick.plays.some((p) => p.combo.isDragon)) {
      const pile = this.currentTrick.plays.flatMap((p) => p.cards);
      this.wonPiles[winnerSeat].push(...pile);
      this.actionSeq++;
      this.lastTrickWin = { seat: winnerSeat, seq: this.actionSeq };
    }
    this._leadNext(winnerSeat, { silent });
  }

  _leadNext(seat, opts = {}) {
    this.currentTrick = { plays: [], leaderSeat: null, lastCombo: null, lastSeat: null, passedSeats: [] };
    // 참새 요청은 라운드(핸드) 전체에 걸쳐 이행될 때까지 유지되어야 하므로 여기서 지우지 않는다.
    if (this.phase !== "play") return;
    let leader = seat;
    if (this.finished[leader]) leader = this._nextActiveSeat(leader);
    if (leader === null) return;
    this.turnSeat = leader;
    this.currentTrick.leaderSeat = leader;
    if (!opts.silent) {
      this.lastAction = { type: "trickStart", seat: leader };
      this.actionSeq++;
    }
    this._armTimer();
  }

  _nextActiveSeat(fromSeat) {
    for (let i = 1; i <= 4; i++) {
      const s = (fromSeat + i) % 4;
      if (!this.finished[s]) return s;
    }
    return null;
  }

  _afterPlayResult() {
    if (this.finishOrder.length === 2) {
      const [a, b] = this.finishOrder;
      if (TEAM_OF_SEAT[a] === TEAM_OF_SEAT[b]) {
        this.doubleWin = TEAM_OF_SEAT[a];
        this._scheduleRoundEnd();
        return { ok: true, roundOver: true };
      }
    }
    if (this.finishOrder.length === 3 && !this.doubleWin) {
      this._scheduleRoundEnd();
      return { ok: true, roundOver: true };
    }
    return { ok: true };
  }

  // 라운드를 끝낸 마지막 카드가 보드에 잠깐 보이도록, 실제 라운드 종료 처리를 살짝 늦춤
  _scheduleRoundEnd() {
    if (this.pendingRoundEnd) return;
    this._clearTimer();
    this.turnSeat = null; // 그 사이 아무도 못 냄
    this.pendingRoundEnd = true;
    const room = this;
    setTimeout(() => {
      if (room.phase !== "play" || !room.pendingRoundEnd) return; // 그 사이 취소/무효 처리됐으면 무시
      room.pendingRoundEnd = false;
      room._endHand();
      room.notify(room.code);
    }, this.LAST_CARD_DELAY_MS);
  }

  /* ---------------- 라운드 종료 / 점수 계산 ---------------- */

  _resolvePendingTrickForRoundEnd() {
    if (this.currentTrick.plays.length === 0) return;
    const pile = this.currentTrick.plays.flatMap((p) => p.cards);
    const lastCombo = this.currentTrick.lastCombo;
    if (lastCombo && lastCombo.isDragon) {
      const winner = this.currentTrick.lastSeat;
      const myTeam = TEAM_OF_SEAT[winner];
      const opp = [0, 1, 2, 3].find((s) => TEAM_OF_SEAT[s] !== myTeam);
      this.wonPiles[opp].push(...pile);
      this.lastDragonGift = { from: winner, to: opp };
    } else if (lastCombo) {
      this.wonPiles[this.currentTrick.lastSeat].push(...pile);
    }
    this.currentTrick = { plays: [], leaderSeat: null, lastCombo: null, lastSeat: null, passedSeats: [] };
    this.pendingDragonChoice = null;
  }

  _endHand() {
    this._clearTimer();
    this._resolvePendingTrickForRoundEnd();
    this.phase = "roundEnd";
    const bonuses = { 0: 0, 1: 0 };
    for (let s = 0; s < 4; s++) {
      const call = this.tichuCalled[s];
      if (!call) continue;
      const success = this.finishOrder[0] === s;
      const val = call === "large" ? 200 : 100;
      bonuses[TEAM_OF_SEAT[s]] += success ? val : -val;
    }

    let teamPoints = { 0: 0, 1: 0 };

    if (this.doubleWin !== null) {
      teamPoints[this.doubleWin] += 200;
    } else {
      const lastSeat = [0, 1, 2, 3].find((s) => !this.finished[s]);
      const firstSeat = this.finishOrder[0];

      for (let s = 0; s < 4; s++) {
        if (s === lastSeat) continue;
        const pts = this.wonPiles[s].reduce((sum, c) => sum + c.points, 0);
        teamPoints[TEAM_OF_SEAT[s]] += pts;
      }
      if (lastSeat !== undefined) {
        const handPts = this.hands[lastSeat].reduce((sum, c) => sum + c.points, 0);
        teamPoints[otherTeam(TEAM_OF_SEAT[lastSeat])] += handPts;
        const lastPiles = this.wonPiles[lastSeat].reduce((sum, c) => sum + c.points, 0);
        teamPoints[TEAM_OF_SEAT[firstSeat]] += lastPiles;
      }
    }

    teamPoints[0] += bonuses[0];
    teamPoints[1] += bonuses[1];

    this.teamScores[0] += teamPoints[0];
    this.teamScores[1] += teamPoints[1];
    this.lastHandSummary = { teamPoints, bonuses, doubleWin: this.doubleWin, finishOrder: this.finishOrder.slice() };
    this.roundHistory.push({ round: this.roundHistory.length + 1, teamPoints: { 0: teamPoints[0], 1: teamPoints[1] } });

    if (this.teamScores[0] >= TARGET_SCORE || this.teamScores[1] >= TARGET_SCORE) {
      this.phase = "gameover";
      if (this.ranked) {
        const winningTeam = this.teamScores[0] > this.teamScores[1] ? 0 : 1;
        const winners = [], losers = [];
        for (let s = 0; s < 4; s++) {
          const p = this.players[s];
          if (!p || !p.memberNickname) continue;
          (TEAM_OF_SEAT[s] === winningTeam ? winners : losers).push(p.memberNickname);
        }
        if (winners.length || losers.length) this.pendingRankedResult = { winners, losers };
      }
    }

    if (this.phase === "roundEnd") this._armRoundEndTimer();
  }

  nextHand() {
    if (this.phase !== "roundEnd") return;
    this._clearRoundEndTimer();
    this.startHand();
  }

  /* ---------------- 턴 타이머 / 잠수(탈주) 처리 ---------------- */

  _armRoundEndTimer() {
    this._clearRoundEndTimer();
    this.roundEndDeadline = Date.now() + this.ROUND_END_AUTO_MS;
    const room = this;
    this._roundEndTimer = setTimeout(() => {
      if (room.phase !== "roundEnd") return;
      room.nextHand();
      room.notify(room.code);
    }, this.ROUND_END_AUTO_MS);
  }

  _clearRoundEndTimer() {
    if (this._roundEndTimer) clearTimeout(this._roundEndTimer);
    this._roundEndTimer = null;
    this.roundEndDeadline = null;
  }

  _clearTimer() {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
    this.turnDeadline = null;
  }

  _armTimer() {
    this._clearTimer();
    if (this.phase !== "play" || this.turnSeat === null || this.pendingDragonChoice !== null) return;
    this.turnDeadline = Date.now() + TURN_SECONDS * 1000;
    this.turnTimer = setTimeout(() => this._onTimeout(), TURN_SECONDS * 1000);
  }

  _onTimeout() {
    const seat = this.turnSeat;
    if (seat === null || this.phase !== "play") return;
    const p = this.players[seat];
    // 연결이 끊긴 사람은 끊긴 직후 DISCONNECT_GRACE_MS 동안은 턴 시간초과로 추가 스택을 안 쌓아서 재접속할 시간을 줌
    // (유예기간이 지나면 다시 정상적으로 스택이 쌓여서, 정말 안 돌아오는 사람 때문에 게임이 무한정 붙잡혀 있지는 않음)
    const withinGrace = p && !p.connected && p.disconnectedAt && (Date.now() - p.disconnectedAt < DISCONNECT_GRACE_MS);
    if (!withinGrace) {
      this._addAbandonStrike(seat);
      if (this.phase !== "play") { this.notify(this.code); return; } // 스택 3회로 방금 무효 처리됐으면 더 진행하지 않음
    }

    const hand = this.hands[seat];
    if (!hand || hand.length === 0) { this.notify(this.code); return; } // 방어적 가드 (정상 플로우에선 발생 안 함)
    const isLeading = this.currentTrick.lastCombo === null;

    let acted = false;
    if (this.requestedRank !== null && !this.requestSatisfied) {
      const forced = existsLegalPlayContainingRank(hand, this.requestedRank, isLeading ? null : this.currentTrick.lastCombo);
      if (forced) {
        this._commitPlay(seat, forced, forced.cards, { interrupt: false });
        acted = true;
      }
    }
    if (!acted) {
      if (isLeading) {
        const nonDog = hand.filter((c) => c.special !== "dog");
        const pool = nonDog.length > 0 ? nonDog : hand;
        const lowest = pool.slice().sort((a, b) => a.rank - b.rank)[0];
        const combo = classify([lowest]);
        this._commitPlay(seat, combo, [lowest], { interrupt: false });
      } else {
        this.pass(seat);
      }
    }

    this.notify(this.code);
  }

  _abort(reason) {
    this._clearTimer();
    this._clearRoundEndTimer();
    this._clearGrandTimer();
    this._clearExchangeTimer();
    this.phase = "aborted";
    this.abortReason = reason;
  }

  /* ---------------- 게임 취소 투표 ---------------- */

  requestCancel(seat) {
    if (this.phase === "lobby" || this.phase === "gameover" || this.phase === "aborted") return;
    this.cancelVotes.add(seat);
    for (let s = 0; s < 4; s++) {
      if (this.isBot(s)) this.cancelVotes.add(s); // 봇은 게임 취소 제안에 항상 동의
    }
    if (this.cancelVotes.size >= 4) {
      this._clearTimer();
      this._clearRoundEndTimer();
      this._clearGrandTimer();
      this._clearExchangeTimer();
      this.phase = "lobby";
      for (const p of this.players) if (p) p.ready = p.isBot; // 봇은 항상 준비완료 상태 유지, 사람만 다시 준비해야 함
      this.cancelVotes.clear();
      this.abortReason = null;
    }
  }

  clearCancelVote(seat) {
    this.cancelVotes.delete(seat);
  }

  /* ---------------- 규칙 기반 봇 ---------------- */

  // 파트너에게는 항상 최고패(용>봉황>A>K>...)를 줌.
  // 상대에게는 단순히 숫자가 낮은 패가 아니라, 내 손패 안에서 쓸모없는 패(페어/스트레이트로 이어지지 않는 외톨이 패)를 우선해서 줌
  // (봇 교환 및 교환 타임아웃 자동제출 둘 다 여기서 공유)
  _autoExchangePicks(seat) {
    const hand = this.hands[seat];
    const giveRank = (c) => {
      if (c.special === "dragon") return 1000;
      if (c.special === "phoenix") return 999;
      if (c.special === "sparrow") return 0.5;
      if (c.special === "dog") return -1;
      return c.rank;
    };
    const byHighest = hand.slice().sort((a, b) => giveRank(b) - giveRank(a));
    const partnerCard = byHighest[0];
    const rest = hand.filter((c) => c.id !== partnerCard.id);

    // 낮을수록 "줘도 되는" 패: 랭크가 낮을수록 기본적으로 내주기 좋지만,
    // 같은 랭크가 더 있어 페어/트리플/포카드로 쓸 수 있거나 연속된 랭크가 있어 스트레이트로 이어질 수 있으면 남겨두는 게 유리하므로 가중치를 더함
    const keepValue = (c) => {
      const sameRankCount = rest.filter((x) => !x.special && x.rank === c.rank).length;
      const hasNeighbor = rest.some((x) => !x.special && (x.rank === c.rank - 1 || x.rank === c.rank + 1));
      let v = c.rank;
      if (sameRankCount >= 2) v += 40;
      if (hasNeighbor) v += 15;
      return v;
    };
    const restLowFirst = rest.slice().sort((a, b) => keepValue(a) - keepValue(b));
    const nonSpecialRest = restLowFirst.filter((c) => !c.special);
    const pickForOpponents = (nonSpecialRest.length >= 2 ? nonSpecialRest : restLowFirst).slice(0, 2);
    return { left: pickForOpponents[0].id, across: partnerCard.id, right: pickForOpponents[1].id };
  }

  botAct() {
    if (this.phase === "grand") {
      const seat = this.grandDecision.findIndex((d, i) => d === null && this.isBot(i));
      if (seat !== -1) { this.callGrandTichu(seat, false); return true; }
    }
    if (this.phase === "exchange") {
      const seat = this.exchangeSubmit.findIndex((e, i) => !e && this.isBot(i));
      if (seat !== -1) {
        this.submitExchange(seat, this._autoExchangePicks(seat));
        return true;
      }
    }
    if (this.phase === "play") {
      if (this.pendingDragonChoice !== null && this.isBot(this.pendingDragonChoice)) {
        const seat = this.pendingDragonChoice;
        const myTeam = TEAM_OF_SEAT[seat];
        const opp = [0, 1, 2, 3].find((s) => TEAM_OF_SEAT[s] !== myTeam);
        this.chooseDragonRecipient(seat, opp);
        return true;
      }
      if (this.turnSeat !== null && this.isBot(this.turnSeat) && this.pendingDragonChoice === null) {
        this._botPlayTurn(this.turnSeat);
        return true;
      }
    }
    return false;
  }

  _botPlayTurn(seat) {
    const hand = this.hands[seat];
    if (!hand || hand.length === 0) { this.pass(seat); return; }
    const isLeading = this.currentTrick.lastCombo === null;

    if (this.requestedRank !== null && !this.requestSatisfied) {
      const forced = existsLegalPlayContainingRank(hand, this.requestedRank, isLeading ? null : this.currentTrick.lastCombo);
      if (forced) { this.playCards(seat, forced.cards.map((c) => c.id), {}); return; }
    }

    if (isLeading) {
      const leadCombo = this._findBotLeadCombo(hand) || (() => {
        const nonDog = hand.filter((c) => c.special !== "dog");
        const pool = nonDog.length > 0 ? nonDog : hand;
        const lowest = pool.slice().sort((a, b) => a.rank - b.rank)[0];
        return classify([lowest]);
      })();
      const opts = {};
      if (leadCombo.cards.some((c) => c.special === "sparrow")) {
        const myRanks = new Set(hand.filter((c) => !c.special).map((c) => c.rank));
        const candidates = [];
        for (let r = 2; r <= 14; r++) if (!myRanks.has(r)) candidates.push(r);
        const pickPool = candidates.length ? candidates : Array.from({ length: 13 }, (_, i) => i + 2);
        opts.requestRank = pickPool[Math.floor(Math.random() * pickPool.length)];
      }
      this.playCards(seat, leadCombo.cards.map((c) => c.id), opts);
      return;
    }

    const partnerSeat = teammateOf(seat);
    if (this.currentTrick.lastSeat === partnerSeat) {
      // 이미 우리 팀 파트너가 트릭을 이기고 있으면 굳이 넘길 필요 없이 패스
      this.pass(seat);
      return;
    }

    const beating = this._findBotBeatingCombo(hand, this.currentTrick.lastCombo);
    if (beating) {
      const res = this.playCards(seat, beating.cards.map((c) => c.id), {});
      if (res.ok) return;
    }
    this.pass(seat);
  }

  // 현재 트릭(prevCombo)을 이길 수 있는 조합을 손에서 찾음. 같은 족보·장수를 우선 찾고, 안 되면 포카드 봄까지 고려.
  // 이길 수 있는 것 중 가장 낮은(약한) 걸 고름(불필요하게 좋은 패를 낭비하지 않도록).
  _findBotBeatingCombo(hand, prevCombo) {
    if (!prevCombo) return null;
    const nonSpecial = hand.filter((c) => !c.special);
    const byRank = {};
    for (const c of nonSpecial) (byRank[c.rank] = byRank[c.rank] || []).push(c);
    const ranksAsc = Object.keys(byRank).map(Number).sort((a, b) => a - b);

    let best = null;
    const consider = (combo) => {
      if (combo && canBeat(combo, prevCombo) && (!best || combo.power < best.power)) best = combo;
    };

    if (prevCombo.type === "single") {
      for (const c of hand) {
        if (c.special === "dragon") continue; // 봇은 용은 아껴둠(단순화)
        consider(classify([c]));
      }
    } else if (prevCombo.type === "pair" || prevCombo.type === "triple") {
      const need = prevCombo.type === "pair" ? 2 : 3;
      for (const rank in byRank) {
        if (byRank[rank].length >= need) consider(classify(byRank[rank].slice(0, need)));
      }
    } else if (prevCombo.type === "straight") {
      for (const run of this._consecutiveRuns(ranksAsc)) {
        if (run.length < prevCombo.len) continue;
        for (let s = 0; s + prevCombo.len <= run.length; s++) {
          const runRanks = run.slice(s, s + prevCombo.len);
          consider(classify(runRanks.map((r) => byRank[r][0])));
        }
      }
    } else if (prevCombo.type === "pairSequence") {
      const needPairs = prevCombo.len / 2;
      const pairRanks = ranksAsc.filter((r) => byRank[r].length >= 2);
      for (const run of this._consecutiveRuns(pairRanks)) {
        if (run.length < needPairs) continue;
        for (let s = 0; s + needPairs <= run.length; s++) {
          const runRanks = run.slice(s, s + needPairs);
          consider(classify(runRanks.flatMap((r) => byRank[r].slice(0, 2))));
        }
      }
    } else if (prevCombo.type === "fullhouse") {
      for (const r of ranksAsc) {
        if (byRank[r].length < 3) continue;
        for (const r2 of ranksAsc) {
          if (r2 === r || byRank[r2].length < 2) continue;
          consider(classify([...byRank[r].slice(0, 3), ...byRank[r2].slice(0, 2)]));
        }
      }
    }
    // 스트레이트플러시 봄은 봇이 직접 구성하진 않고, 아래 포카드 봄으로만 대응 시도

    // 포카드 봄(모든 상황에서 이 조합 하나로 대응 가능한지도 확인)
    for (const rank in byRank) {
      if (byRank[rank].length === 4) consider(classify(byRank[rank]));
    }

    return best;
  }

  // 정렬된 랭크 배열에서 연속된 구간들을 뽑아냄 (예: [2,3,4,7,8] -> [[2,3,4],[7,8]])
  _consecutiveRuns(sortedRanks) {
    const runs = [];
    let current = [];
    for (const r of sortedRanks) {
      if (current.length && r !== current[current.length - 1] + 1) {
        runs.push(current);
        current = [];
      }
      current.push(r);
    }
    if (current.length) runs.push(current);
    return runs;
  }

  // 리드할 때 낼 조합을 손에서 찾음: 페어/트리플/풀하우스/스트레이트/연속페어 중
  // 가장 많은 장수를 한 번에 처리할 수 있는 조합을 우선 고름(패를 계속 싱글로만 내지 않도록).
  // 마땅한 조합이 없으면 null을 반환하고, 호출부에서 최저 싱글로 대체함.
  _findBotLeadCombo(hand) {
    const nonDog = hand.filter((c) => c.special !== "dog");
    const pool = nonDog.length > 0 ? nonDog : hand;
    const groups = {};
    for (const c of pool) {
      if (c.special === "phoenix" || c.special === "dragon") continue; // 봉황/용은 단순화를 위해 리드 조합 구성에서 제외
      const r = c.special === "sparrow" ? 1 : c.rank;
      (groups[r] = groups[r] || []).push(c);
    }
    const ranksAsc = Object.keys(groups).map(Number).sort((a, b) => a - b);
    const candidates = [];

    for (const r of ranksAsc) {
      const cards = groups[r];
      if (r === 1) continue; // 참새는 페어/트리플 불가
      if (cards.length >= 2) {
        const combo = classify(cards.slice(0, 2));
        if (combo) candidates.push(combo);
      }
      if (cards.length >= 3) {
        const combo = classify(cards.slice(0, 3));
        if (combo) candidates.push(combo);
      }
    }

    // 풀하우스: 트리플 랭크 + 다른 페어 랭크
    for (const r of ranksAsc) {
      if (r === 1 || groups[r].length < 3) continue;
      for (const r2 of ranksAsc) {
        if (r2 === r || r2 === 1 || groups[r2].length < 2) continue;
        const combo = classify([...groups[r].slice(0, 3), ...groups[r2].slice(0, 2)]);
        if (combo && combo.type === "fullhouse") candidates.push(combo);
      }
    }

    // 스트레이트 (연속 랭크, 랭크당 1장씩; 참새를 1로 사용 가능)
    for (const run of this._consecutiveRuns(ranksAsc)) {
      for (let len = 5; len <= run.length; len++) {
        for (let s = 0; s + len <= run.length; s++) {
          const runRanks = run.slice(s, s + len);
          const combo = classify(runRanks.map((r) => groups[r][0]));
          if (combo && (combo.type === "straight" || combo.type === "bombStraight")) candidates.push(combo);
        }
      }
    }

    // 연속페어(계단)
    const pairRanks = ranksAsc.filter((r) => r !== 1 && groups[r].length >= 2);
    for (const run of this._consecutiveRuns(pairRanks)) {
      for (let len = 2; len <= run.length; len++) {
        for (let s = 0; s + len <= run.length; s++) {
          const runRanks = run.slice(s, s + len);
          const combo = classify(runRanks.flatMap((r) => groups[r].slice(0, 2)));
          if (combo && combo.type === "pairSequence") candidates.push(combo);
        }
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.cards.length - a.cards.length || a.power - b.power);
    return candidates[0];
  }

  /* ---------------- 상태 직렬화 ---------------- */

  getStateFor(viewerSeat, isSpectator) {
    const seeHand = !isSpectator && viewerSeat !== null && viewerSeat !== -1;
    return {
      code: this.code,
      phase: this.phase,
      players: this.players.map((p, i) => (p ? { name: p.name, seat: i, connected: p.connected, ready: p.ready, abandonCount: p.abandonCount, isBot: !!p.isBot } : null)),
      spectatorCount: this.spectators.length,
      spectatorNames: this.spectators.map((s) => s.name),
      teamScores: this.teamScores,
      myHand: seeHand ? this.hands[viewerSeat] : [],
      first8: seeHand ? this.first8[viewerSeat] : [],
      handCounts: this.hands.map((h) => h.length),
      grandDecision: this.grandDecision,
      tichuCalled: this.tichuCalled,
      exchangeSubmitted: this.exchangeSubmit.map((e) => !!e),
      exchangeReceived: seeHand ? this.exchangeReceived[viewerSeat] : [],
      currentTrick: this.currentTrick,
      requestedRank: this.requestedRank,
      requestSatisfied: this.requestSatisfied,
      turnSeat: this.turnSeat,
      turnDeadline: this.turnDeadline,
      exchangeDeadline: this.exchangeDeadline,
      grandDeadline: this.grandDeadline,
      finished: this.finished,
      finishOrder: this.finishOrder,
      pendingDragonChoice: this.pendingDragonChoice,
      pendingDogTransfer: this.pendingDogTransfer,
      lastHandSummary: this.lastHandSummary || null,
      wonPileCounts: this.wonPiles.map((w) => w.length),
      cancelVotes: Array.from(this.cancelVotes),
      abortReason: this.abortReason,
      lastAction: this.lastAction,
      actionSeq: this.actionSeq,
      lastDragonGift: this.lastDragonGift,
      lastTrickWin: this.lastTrickWin,
      roundEndDeadline: this.roundEndDeadline,
      fixedSeats: this.fixedSeats,
      hostSeat: this.players.findIndex((p) => p && !p.isBot && p.pid === this.hostPid),
      ranked: this.ranked,
      roundHistory: this.roundHistory,
    };
  }
}

module.exports = { Room, TEAM_OF_SEAT, teammateOf };
