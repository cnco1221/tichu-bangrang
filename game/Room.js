const { dealHands, sortHand } = require("./deck");
const { classify, canBeat, existsLegalPlayContainingRank } = require("./combos");

const TEAM_OF_SEAT = [0, 1, 0, 1]; // 좌석0,2 = 팀A(0) / 좌석1,3 = 팀B(1)
const TARGET_SCORE = 1000;
const TURN_SECONDS = 30;
const MAX_ABANDON = 3;

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
    this.fixedSeats = false; // true면 게임 시작 시 좌석을 섞지 않고 그대로 시작
    this.EXCHANGE_SUMMARY_DELAY_MS = 3200; // 교환 완료 후 실제 플레이 시작까지 대기(클라 요약화면과 맞춤). 테스트에서 0으로 낮춰 씀
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
    this.pendingDragonChoice = null;
    this.pendingDogTransfer = null; // 개를 낸 뒤 파트너에게 턴 넘기기 전 1초 대기(연출용 잠금)
    this.doubleWin = null;
    this.requestedRank = null;
    this.requestSatisfied = true;
    this.lastDragonGift = null; // { from, to } - 용으로 이긴 트릭을 누구에게 줬는지(보드 표시용)
    this._clearExchangeTimer();
    this._clearTimer();
  }

  /* ---------------- 좌석 / 관전자 ---------------- */

  addPlayer(socketId, name) {
    const seat = this.players.findIndex((p) => p === null);
    if (seat === -1) return null;
    this.players[seat] = { socketId, name: name || `플레이어${seat + 1}`, ready: false, connected: true, abandonCount: 0, isBot: false };
    return seat;
  }

  addBot(seat) {
    if (this.players[seat]) return false;
    const humanCount = this.players.filter((p) => p && !p.isBot).length;
    if (humanCount === 0) return false; // 최소 한 자리는 사람이어야 함(전원 봇 방지)
    this.players[seat] = { socketId: null, name: `봇${seat + 1}`, ready: true, connected: true, abandonCount: 0, isBot: true };
    return true;
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
        // 게임 도중 탈주 -> 즉시 무효 처리
        this.players[seat].connected = false;
        this._abort(`${this.players[seat].name}님이 나가서 게임이 무효 처리되었어요`);
      } else {
        this.players[seat] = null;
      }
    }
    const specIdx = this.spectators.findIndex((s) => s.socketId === socketId);
    if (specIdx !== -1) this.spectators.splice(specIdx, 1);
    return seat;
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

  setFixedSeats(enabled) {
    if (this.phase !== "lobby") return;
    this.fixedSeats = !!enabled;
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
    for (const p of this.players) p.abandonCount = 0;
    this.cancelVotes.clear();
    this.abortReason = null;
    this.startHand();
    return true;
  }

  startHand() {
    this.resetHandState();
    const { first8, full14 } = dealHands();
    this.first8 = first8;
    this._full14 = full14;
    this.phase = "grand";
  }

  callGrandTichu(seat, wantsLarge) {
    if (this.phase !== "grand" || this.grandDecision[seat] !== null) return;
    if (wantsLarge && this.tichuCalled[seat] === "small") return; // 이미 스몰티츄를 선언했으면 라지티츄로 바꿀 수 없음
    this.grandDecision[seat] = !!wantsLarge;
    if (wantsLarge) this.tichuCalled[seat] = "large";
    if (this.grandDecision.every((d) => d !== null)) {
      this.hands = this._full14.map((h) => sortHand(h));
      this.phase = "exchange";
      this._armExchangeTimer();
    }
  }

  _armExchangeTimer() {
    this._clearExchangeTimer();
    this.exchangeDeadline = Date.now() + 30000;
    const room = this;
    this._exchangeTimer = setTimeout(() => room._onExchangeTimeout(), 30000);
  }

  _clearExchangeTimer() {
    if (this._exchangeTimer) clearTimeout(this._exchangeTimer);
    this._exchangeTimer = null;
    this.exchangeDeadline = null;
  }

  _onExchangeTimeout() {
    if (this.phase !== "exchange") return;
    for (let s = 0; s < 4; s++) {
      if (this.phase !== "exchange") break; // 도중에 전원 제출 완료되어 resolve됐으면 중단
      if (this.exchangeSubmit[s]) continue;
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
        combo.power = this.currentTrick.lastCombo.power + 0.5;
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
    if (isLeading && this.requestedRank === null && cards.some((c) => c.special === "sparrow")) {
      const r = opts.requestRank;
      if (r && r >= 2 && r <= 14) { this.requestedRank = r; this.requestSatisfied = false; }
    }

    return this._commitPlay(seat, combo, cards, { interrupt: false });
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
        if (room.phase !== "play" || room.pendingDogTransfer !== mate) return; // 그 사이 라운드/게임이 끝났으면 무시
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
        this._endHand();
        return { ok: true, roundOver: true };
      }
    }
    if (this.finishOrder.length === 3 && !this.doubleWin) {
      this._endHand();
      return { ok: true, roundOver: true };
    }
    return { ok: true };
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

    if (this.teamScores[0] >= TARGET_SCORE || this.teamScores[1] >= TARGET_SCORE) {
      this.phase = "gameover";
    }
  }

  nextHand() {
    if (this.phase !== "roundEnd") return;
    this.startHand();
  }

  /* ---------------- 턴 타이머 / 잠수(탈주) 처리 ---------------- */

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
    const player = this.players[seat];
    if (player) player.abandonCount = (player.abandonCount || 0) + 1;

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

    if (player && player.abandonCount >= MAX_ABANDON) {
      this._abort(`${player.name}님이 잠수 ${MAX_ABANDON}회로 게임이 무효 처리되었어요`);
    }
    this.notify(this.code);
  }

  _abort(reason) {
    this._clearTimer();
    this.phase = "aborted";
    this.abortReason = reason;
  }

  /* ---------------- 게임 취소 투표 ---------------- */

  requestCancel(seat) {
    if (this.phase === "lobby" || this.phase === "gameover" || this.phase === "aborted") return;
    this.cancelVotes.add(seat);
    if (this.cancelVotes.size >= 4) {
      this._clearTimer();
      this.phase = "lobby";
      for (const p of this.players) if (p) p.ready = false;
      this.cancelVotes.clear();
      this.abortReason = null;
    }
  }

  clearCancelVote(seat) {
    this.cancelVotes.delete(seat);
  }

  /* ---------------- 규칙 기반 봇 ---------------- */

  // 파트너에게는 항상 최고패(용>봉황>A>K>...), 상대에게는 낮은 패를 자동으로 고름
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
    const restLowFirst = rest.slice().sort((a, b) => giveRank(a) - giveRank(b));
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
      const nonDog = hand.filter((c) => c.special !== "dog");
      const pool = nonDog.length > 0 ? nonDog : hand;
      const lowest = pool.slice().sort((a, b) => a.rank - b.rank)[0];
      const opts = {};
      if (lowest.special === "sparrow") {
        const myRanks = new Set(hand.filter((c) => !c.special).map((c) => c.rank));
        const candidates = [];
        for (let r = 2; r <= 14; r++) if (!myRanks.has(r)) candidates.push(r);
        const pickPool = candidates.length ? candidates : Array.from({ length: 13 }, (_, i) => i + 2);
        opts.requestRank = pickPool[Math.floor(Math.random() * pickPool.length)];
      }
      this.playCards(seat, [lowest.id], opts);
      return;
    }

    const sorted = hand.slice().sort((a, b) => a.rank - b.rank);
    for (const c of sorted) {
      if (c.special === "dragon") continue; // 봇은 용은 아껴둠(단순화)
      const res = this.playCards(seat, [c.id], {});
      if (res.ok) return;
    }
    this.pass(seat);
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
      fixedSeats: this.fixedSeats,
    };
  }
}

module.exports = { Room, TEAM_OF_SEAT, teammateOf };
