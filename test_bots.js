const { Room } = require("../game/Room");

const room = new Room("BOTS", () => {});
for (let s = 0; s < 4; s++) room.addBot(s);
if (!room.startGame()) throw new Error("봇 4명인데 시작 실패");

function driveBotsUntil(predicate, guardMax) {
  let guard = 0;
  while (!predicate()) {
    const acted = room.botAct();
    if (!acted) throw new Error("아무도 행동하지 않는데 아직 안 끝남 (phase=" + room.phase + ")");
    if (++guard > guardMax) throw new Error("무한루프 의심");
  }
}

let hands = 0;
while (room.phase !== "gameover" && hands < 80) {
  driveBotsUntil(() => room.phase === "roundEnd" || room.phase === "gameover", 4000);
  hands++;
  console.log(`hand ${hands}: teamScores=`, room.teamScores, "phase=", room.phase);
  if (room.phase === "roundEnd") room.nextHand();
}
room._clearTimer();
if (room.phase !== "gameover") throw new Error("게임오버로 안 끝남");
console.log("FINAL:", room.teamScores);
console.log("BOT SIMULATION OK");
