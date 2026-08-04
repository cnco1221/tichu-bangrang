// 특수 규칙 유닛 테스트: 폭탄 인터럽트, 참새 강제 이행, 개는 인터럽트 불가
const { Room } = require("../game/Room");
const assert = require("assert");

function freshRoom() {
  const room = new Room("T2", () => {});
  room.addPlayer("s0", "A"); room.addPlayer("s1", "B"); room.addPlayer("s2", "C"); room.addPlayer("s3", "D");
  for (let s = 0; s < 4; s++) room.setReady(s, true);
  room.phase = "play";
  room.hands = [[], [], [], []];
  room.finished = [false, false, false, false];
  room.finishOrder = [];
  room.currentTrick = { plays: [], leaderSeat: 0, lastCombo: null, lastSeat: null };
  room.turnSeat = 0;
  room._clearTimer();
  return room;
}
function card(suit, rank) { return { id: `${suit}_${rank}`, suit, rank, special: null, points: (rank===5?5:(rank===10||rank===13?10:0)) }; }
function special(kind, id) { return { id, suit: null, rank: kind==="sparrow"?1:(kind==="dog"?0:kind==="phoenix"?14.5:15), special: kind, points: kind==="dragon"?25:(kind==="phoenix"?-25:0) }; }

// ---- 테스트 1: 폭탄 인터럽트(내 차례 아니어도 가능, 트릭에 카드 있어야 함) ----
{
  const room = freshRoom();
  room.hands[0] = [card("jade", 6), card("pagoda", 2)]; // 필러 카드로 원카드아웃 방지
  room.hands[2] = [card("jade", 9), card("sword", 9), card("pagoda", 9), card("star", 9), card("star", 2)];
  room.turnSeat = 0;
  let res = room.playCards(0, ["jade_6"]);
  assert(res.ok, "선 플레이어 싱글 실패: " + JSON.stringify(res));
  // seat2가 자기 차례 아닌데 폭탄으로 인터럽트
  res = room.playCards(2, ["jade_9", "sword_9", "pagoda_9", "star_9"]);
  assert(res.ok, "폭탄 인터럽트 실패: " + JSON.stringify(res));
  assert.strictEqual(room.currentTrick.lastSeat, 2, "인터럽트 후 lastSeat이 폭탄 낸 사람이어야 함");
  assert.strictEqual(room.turnSeat, 3, "인터럽트 후 턴은 인터럽트한 사람 다음이어야 함");
  room._clearTimer();
  console.log("PASS: 폭탄 인터럽트");
}

// ---- 테스트 2: 트릭이 비어있으면(리드 전) 폭탄 인터럽트 불가 ----
{
  const room = freshRoom();
  room.hands[1] = [card("jade", 9), card("sword", 9), card("pagoda", 9), card("star", 9)];
  room.turnSeat = 0; // 아직 0번이 리드 안 함
  const res = room.playCards(1, ["jade_9", "sword_9", "pagoda_9", "star_9"]);
  assert(res.error, "빈 트릭에서 폭탄 인터럽트가 막혀야 하는데 성공함");
  room._clearTimer();
  console.log("PASS: 빈 트릭 폭탄 인터럽트 차단 -", res.error);
}

// ---- 테스트 3: 참새 요청 강제 이행 (다음 사람이 해당 숫자 보유 시 반드시 내야 함) ----
{
  const room = freshRoom();
  room.hands[0] = [special("sparrow", "special_sparrow")];
  room.hands[1] = [card("jade", 7), card("sword", 3)];
  room.turnSeat = 0;
  let res = room.playCards(0, ["special_sparrow"], { requestRank: 7 });
  assert(res.ok, "참새 리드 실패: " + JSON.stringify(res));
  assert.strictEqual(room.requestedRank, 7);
  assert.strictEqual(room.requestSatisfied, false);
  // seat1이 7을 안 내고 3을 내려 하면 에러
  res = room.playCards(1, ["sword_3"]);
  assert(res.error, "요청 카드 무시했는데도 통과됨");
  // 패스도 막혀야 함
  res = room.pass(1);
  assert(res.error, "요청 카드를 낼 수 있는데 패스가 허용됨");
  // 7을 내면 성공 + 요청 충족
  res = room.playCards(1, ["jade_7"]);
  assert(res.ok, "요청 카드로 냈는데 실패: " + JSON.stringify(res));
  assert.strictEqual(room.requestSatisfied, true);
  room._clearTimer();
  console.log("PASS: 참새 요청 강제 이행");
}

// ---- 테스트 4: 개는 무조건 트릭 즉시 종료, 인터럽트 불가 ----
{
  const room = freshRoom();
  room.hands[0] = [special("dog", "special_dog")];
  room.hands[2] = [card("jade", 9), card("sword", 9), card("pagoda", 9), card("star", 9)];
  room.turnSeat = 0;
  const res = room.playCards(0, ["special_dog"]);
  assert(res.ok, "개 플레이 실패: " + JSON.stringify(res));
  assert.strictEqual(room.currentTrick.plays.length, 0, "개 이후 트릭이 즉시 리셋되어야 함");
  assert.strictEqual(room.turnSeat, 2, "개는 파트너(좌석2)에게 선을 넘겨야 함");
  room._clearTimer();
  console.log("PASS: 개 즉시 종료/인터럽트 불가(트릭 초기화로 자연 차단)");
}

console.log("ALL RULE TESTS PASSED");
