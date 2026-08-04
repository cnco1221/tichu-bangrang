const { Room } = require("../game/Room");

function autoGrand(room) {
  for (let s = 0; s < 4; s++) if (room.grandDecision[s] === null) room.callGrandTichu(s, false);
}
function autoExchange(room) {
  for (let s = 0; s < 4; s++) {
    if (room.exchangeSubmit[s]) continue;
    const hand = room.hands[s];
    const nonSpecial = hand.filter((c) => !c.special);
    const pick = (nonSpecial.length >= 3 ? nonSpecial : hand).slice(0, 3);
    room.submitExchange(s, { left: pick[0].id, across: pick[1].id, right: pick[2].id });
  }
}

function playOneTurn(room) {
  const seat = room.turnSeat;
  if (seat === null || seat === undefined) return false;
  if (room.pendingDragonChoice !== null) {
    const s = room.pendingDragonChoice;
    const myTeam = s % 2;
    const opp = [0, 1, 2, 3].find((x) => x % 2 !== myTeam);
    room.chooseDragonRecipient(s, opp);
    return true;
  }
  const hand = room.hands[seat];
  const isLeading = room.currentTrick.lastCombo === null;
  const sorted = hand.slice().sort((a, b) => (a.rank || 0) - (b.rank || 0));
  let played = false;
  for (const c of sorted) {
    if (c.special === "dragon") continue;
    const res = room.playCards(seat, [c.id], { requestRank: null });
    if (!res.error) { played = true; break; }
  }
  if (!played) {
    if (isLeading) {
      const res = room.playCards(seat, [sorted[0].id]);
      if (res.error) throw new Error("리드 실패: " + res.error);
    } else {
      const res = room.pass(seat);
      if (res.error) throw new Error("패스 실패: " + res.error);
    }
  }
  return true;
}

function runHand(room) {
  room.startHand();
  let guard = 0;
  while (room.phase === "grand") { autoGrand(room); if (++guard > 10) throw new Error("grand stuck"); }
  guard = 0;
  while (room.phase === "exchange") { autoExchange(room); if (++guard > 10) throw new Error("exchange stuck"); }
  guard = 0;
  while (room.phase === "play") {
    playOneTurn(room);
    if (++guard > 5000) throw new Error("play stuck (infinite loop?)");
  }
  room._clearTimer();
  if (room.phase !== "roundEnd" && room.phase !== "gameover") throw new Error("unexpected phase " + room.phase);
}

const room = new Room("TEST", () => {});
room.addPlayer("s0", "A");
room.addPlayer("s1", "B");
room.addPlayer("s2", "C");
room.addPlayer("s3", "D");
for (let s = 0; s < 4; s++) room.setReady(s, true);
room.teamScores = [0, 0];

let hands = 0;
while (room.phase !== "gameover" && hands < 60) {
  runHand(room);
  const sum = room.lastHandSummary;
  const total = sum.doubleWin !== null ? 200 : sum.teamPoints[0] - sum.bonuses[0] + (sum.teamPoints[1] - sum.bonuses[1]);
  console.log(`hand ${++hands}: teamScores=`, room.teamScores, `cardPointTotal(비보너스)=${total}`);
  if (room.phase === "roundEnd") room.nextHand();
}
console.log("FINAL:", room.teamScores, room.phase);
console.log("SIMULATION OK");
