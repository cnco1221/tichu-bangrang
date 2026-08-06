const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Room } = require("./game/Room");
const accounts = require("./accounts");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// 예상 못한 에러(예: DB 호출 실패) 하나 때문에 서버 전체가 죽지 않도록 하는 안전장치
process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map(); // code -> Room
const socketRoom = new Map(); // socketId -> code
const adminSockets = new Set(); // 관리자모드로 로그인한 socket.id
const loggedInNickname = new Map(); // socket.id -> 로그인한 회원 닉네임

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function broadcast(code) {
  const room = rooms.get(code);
  if (!room) return;
  for (const p of room.players) {
    if (!p || p.isBot) continue;
    const seat = room.seatBySocket(p.socketId);
    io.to(p.socketId).emit("yourSeat", { seat }); // 좌석 셔플/스왑 후에도 클라이언트가 자기 좌석을 정확히 알도록 매번 동기화
    io.to(p.socketId).emit("state", room.getStateFor(seat, false));
  }
  for (const s of room.spectators) {
    io.to(s.socketId).emit("state", room.getStateFor(null, true));
  }
}

function runBots(code, delay = 1500) {
  const room = rooms.get(code);
  if (!room) return;
  const acted = room.botAct();
  if (acted) {
    broadcast(code);
    setTimeout(() => runBots(code, delay), delay);
  }
}

function afterMutation(code) {
  broadcast(code);
  const room = rooms.get(code);
  if (room && room.pendingRankedResult) {
    const { winners, losers } = room.pendingRankedResult;
    room.pendingRankedResult = null;
    accounts.recordRankedResult(winners, losers).catch((e) => console.error("[ranked] 승패 기록 실패:", e.message));
  }
  setTimeout(() => runBots(code), 1500); // 첫 봇 행동도 딜레이 적용(즉시 내는 버그 수정)
}

function makeRoom(code) {
  const room = new Room(code, (c) => afterMutation(c)); // 타이머/지연 이벤트 후에도 봇 턴이 이어지도록 afterMutation 사용
  rooms.set(code, room);
  return room;
}

io.on("connection", (socket) => {
  socket.on("listRooms", (_, cb) => {
    const list = [];
    for (const [code, room] of rooms.entries()) {
      if (room.phase !== "lobby") continue;
      const playerCount = room.players.filter((p) => p).length;
      if (playerCount === 0) continue;
      list.push({ code, playerCount, spectatorCount: room.spectators.length });
    }
    cb && cb({ rooms: list });
  });

  socket.on("createRoom", ({ name, token }, cb) => {
    const code = genCode();
    const room = makeRoom(code);
    const memberNickname = loggedInNickname.get(socket.id) || null;
    const displayName = memberNickname || (name || "").slice(0, 10);
    const seat = room.addPlayer(socket.id, displayName, token, memberNickname);
    socketRoom.set(socket.id, code);
    socket.join(code);
    cb && cb({ ok: true, code, seat });
    broadcast(code);
  });

  socket.on("joinRoom", ({ code, name, asSpectator, token }, cb) => {
    code = (code || "").toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb && cb({ error: "존재하지 않는 방이에요" });

    // 같은 토큰으로 재접속 시도: 연결이 끊겼던 원래 좌석으로 복귀
    if (token) {
      const reSeat = room.reconnectPlayer(token, socket.id);
      if (reSeat !== null) {
        socketRoom.set(socket.id, code);
        socket.join(code);
        cb && cb({ ok: true, code, seat: reSeat, reconnected: true });
        broadcast(code);
        return;
      }
    }

    const memberNickname = loggedInNickname.get(socket.id) || null;
    const trimmedName = memberNickname || (name || "").slice(0, 10);
    if (asSpectator || room.isFull()) {
      room.addSpectator(socket.id, trimmedName);
      socketRoom.set(socket.id, code);
      socket.join(code);
      cb && cb({ ok: true, code, seat: null, spectator: true });
    } else {
      const seat = room.addPlayer(socket.id, trimmedName, token, memberNickname);
      socketRoom.set(socket.id, code);
      socket.join(code);
      cb && cb({ ok: true, code, seat });
    }
    broadcast(code);
  });

  socket.on("takeSeat", (_, cb) => {
    const { room, code } = getRoomCode(socket);
    if (!room) return;
    const seat = room.takeEmptySeat(socket.id, "");
    cb && cb({ ok: seat !== null, seat });
    broadcast(code);
  });

  socket.on("switchToSpectator", (_, cb) => {
    const { room, seat, code } = getRoomSeat(socket);
    if (!room || seat === -1) return cb && cb({ error: "자리에 앉아있지 않아요" });
    const ok = room.switchToSpectator(seat);
    if (!ok) return cb && cb({ error: "지금은 관전으로 바꿀 수 없어요(게임 중)" });
    cb && cb({ ok: true });
    broadcast(code);
  });

  socket.on("moveSeat", ({ targetSeat }, cb) => {
    const { room, seat, code } = getRoomSeat(socket);
    if (!room || seat === -1) return cb && cb({ error: "먼저 자리에 앉아야 해요" });
    const ok = room.moveToEmptySeat(seat, targetSeat);
    if (!ok) return cb && cb({ error: "그 자리로 이동할 수 없어요" });
    cb && cb({ ok: true });
    broadcast(code);
  });

  socket.on("setFixedSeats", ({ enabled }, cb) => {
    const { room, seat, code } = getRoomSeat(socket);
    if (!room || seat === -1) return;
    const ok = room.setFixedSeats(enabled, seat);
    if (!ok) { cb && cb({ error: room.isHost(seat) ? "지금은 지정석을 바꿀 수 없어요" : "방장만 바꿀 수 있어요" }); return; }
    cb && cb({ ok: true });
    broadcast(code);
  });

  socket.on("setRanked", ({ enabled }, cb) => {
    const { room, seat, code } = getRoomSeat(socket);
    if (!room || seat === -1) return;
    const ok = room.setRanked(enabled, seat);
    if (!ok) {
      if (!room.isHost(seat)) { cb && cb({ error: "방장만 바꿀 수 있어요" }); return; }
      cb && cb({ error: "봇이 있으면 등급전을 켤 수 없어요(봇을 먼저 빼주세요)" });
      return;
    }
    cb && cb({ ok: true });
    broadcast(code);
  });

  /* ---------------- 회원가입 / 로그인 ---------------- */

  socket.on("signup", async ({ name, nickname, password }, cb) => {
    const res = await accounts.signup({ name, nickname, password });
    cb && cb(res);
  });

  socket.on("login", async ({ nickname, password }, cb) => {
    const res = await accounts.login({ nickname, password });
    if (res.ok) loggedInNickname.set(socket.id, res.nickname);
    cb && cb(res);
  });

  socket.on("logout", (_, cb) => {
    loggedInNickname.delete(socket.id);
    cb && cb({ ok: true });
  });

  socket.on("getRanking", async (_, cb) => {
    const res = await accounts.getRanking();
    cb && cb(res);
  });

  /* ---------------- 관리자모드 ---------------- */

  socket.on("adminLogin", async ({ password }, cb) => {
    const res = await accounts.adminLogin(password);
    if (res.ok) adminSockets.add(socket.id);
    cb && cb(res);
  });

  socket.on("adminLogout", (_, cb) => {
    adminSockets.delete(socket.id);
    cb && cb({ ok: true });
  });

  function requireAdmin(cb) {
    if (!adminSockets.has(socket.id)) {
      cb && cb({ error: "관리자 로그인이 필요해요" });
      return false;
    }
    return true;
  }

  socket.on("adminChangePassword", async ({ newPassword }, cb) => {
    if (!requireAdmin(cb)) return;
    cb && cb(await accounts.adminChangePassword(newPassword));
  });

  socket.on("adminListPending", async (_, cb) => {
    if (!requireAdmin(cb)) return;
    cb && cb({ ok: true, pending: await accounts.adminListPending() });
  });

  socket.on("adminApprove", async ({ nickname }, cb) => {
    if (!requireAdmin(cb)) return;
    cb && cb(await accounts.adminApprove(nickname));
  });

  socket.on("adminReject", async ({ nickname }, cb) => {
    if (!requireAdmin(cb)) return;
    cb && cb(await accounts.adminReject(nickname));
  });

  socket.on("adminListMembers", async (_, cb) => {
    if (!requireAdmin(cb)) return;
    cb && cb({ ok: true, members: await accounts.adminListMembers() });
  });

  socket.on("adminDeleteMember", async ({ nickname }, cb) => {
    if (!requireAdmin(cb)) return;
    cb && cb(await accounts.adminDeleteMember(nickname));
  });

  socket.on("adminResetPassword", async ({ nickname, newPassword }, cb) => {
    if (!requireAdmin(cb)) return;
    cb && cb(await accounts.adminResetPassword(nickname, newPassword));
  });

  socket.on("adminSetRecord", async ({ nickname, wins, losses }, cb) => {
    if (!requireAdmin(cb)) return;
    cb && cb(await accounts.adminSetRecord(nickname, wins, losses));
  });

  socket.on("addBot", (_, cb) => {
    const { room, code } = getRoomCode(socket);
    if (!room) return cb && cb({ error: "방에 먼저 들어가야 해요" });
    if (room.phase !== "lobby") return cb && cb({ error: "게임 중에는 봇을 추가할 수 없어요" });
    const actorSeat = room.seatBySocket(socket.id);
    const seat = room.players.findIndex((p) => p === null);
    if (seat === -1) return cb && cb({ error: "빈 자리가 없어요" });
    const ok = room.addBot(seat, actorSeat);
    if (!ok) {
      if (!room.isHost(actorSeat)) return cb && cb({ error: "방장만 봇을 추가할 수 있어요" });
      return cb && cb({ error: room.ranked ? "등급전 중에는 봇을 추가할 수 없어요" : "최소 한 자리는 사람이어야 해요(전원 봇으로는 채울 수 없어요)" });
    }
    cb && cb({ ok: true, seat });
    if (room.players.every((p) => p !== null && p.ready)) room.startGame();
    afterMutation(code);
  });

  socket.on("removeBot", ({ seat }, cb) => {
    const { room, code } = getRoomCode(socket);
    if (!room) return cb && cb({ error: "방에 먼저 들어가야 해요" });
    const ok = room.removeBot(seat);
    if (!ok) return cb && cb({ error: "그 봇을 뺄 수 없어요" });
    cb && cb({ ok: true });
    broadcast(code);
  });

  socket.on("leaveRoom", (_, cb) => {
    const { room, code } = getRoomCode(socket);
    if (room) {
      room.removeBySocket(socket.id); // 소켓은 그대로 두고 방에서만 빠짐(로그인 세션 유지)
      socket.leave(code);
      socketRoom.delete(socket.id);
      const hasHumanPlayer = room.players.some((p) => p && !p.isBot);
      const hasSpectator = room.spectators.length > 0;
      if (!hasHumanPlayer && !hasSpectator) rooms.delete(code);
      else broadcast(code);
    }
    cb && cb({ ok: true });
  });

  socket.on("setReady", ({ ready }) => {
    const { room, seat, code } = getRoomSeat(socket);
    if (!room || seat === -1) return;
    room.setReady(seat, ready);
    if (room.phase === "lobby") room.startGame(); // 4명 전원 준비되면 자동 시작
    afterMutation(code);
  });

  socket.on("startGame", () => {
    const { room, code } = getRoomCode(socket);
    if (!room) return;
    room.startGame();
    afterMutation(code);
  });

  socket.on("callGrandTichu", ({ wantsGrand, wantsLarge }) => {
    const { room, seat, code } = getRoomSeat(socket);
    if (!room || seat === -1) return;
    room.callGrandTichu(seat, wantsLarge ?? wantsGrand);
    afterMutation(code);
  });

  socket.on("submitExchange", (payload) => {
    const { room, seat, code } = getRoomSeat(socket);
    if (!room || seat === -1) return;
    room.submitExchange(seat, payload);
    afterMutation(code);
  });

  socket.on("callTichu", () => {
    const { room, seat, code } = getRoomSeat(socket);
    if (!room || seat === -1) return;
    room.callTichu(seat);
    broadcast(code);
  });

  socket.on("playCards", ({ cardIds, requestRank }, cb) => {
    const { room, seat, code } = getRoomSeat(socket);
    if (!room || seat === -1) return;
    const result = room.playCards(seat, cardIds, { requestRank });
    cb && cb(result);
    afterMutation(code);
  });

  socket.on("passTurn", (_, cb) => {
    const { room, seat, code } = getRoomSeat(socket);
    if (!room || seat === -1) return;
    const result = room.pass(seat);
    cb && cb(result);
    afterMutation(code);
  });

  socket.on("chooseDragonRecipient", ({ recipientSeat }, cb) => {
    const { room, seat, code } = getRoomSeat(socket);
    if (!room || seat === -1) return;
    const result = room.chooseDragonRecipient(seat, recipientSeat);
    cb && cb(result);
    afterMutation(code);
  });

  socket.on("nextHand", () => {
    const { room, code } = getRoomCode(socket);
    if (!room) return;
    room.nextHand();
    afterMutation(code);
  });

  socket.on("requestCancel", () => {
    const { room, seat, code } = getRoomSeat(socket);
    if (!room || seat === -1) return;
    room.requestCancel(seat);
    broadcast(code);
  });

  socket.on("chatMessage", ({ text }) => {
    const { room, code } = getRoomCode(socket);
    if (!room || !text) return;
    const seat = room.seatBySocket(socket.id);
    const name = seat !== -1 ? room.players[seat].name : (room.spectators.find(s => s.socketId === socket.id) || {}).name;
    io.to(code).emit("chatMessage", { seat, name, text: String(text).slice(0, 200), ts: Date.now() });
  });

  socket.on("globalChatMessage", ({ text, name }) => {
    if (!text) return;
    io.emit("globalChatMessage", { name: (name || "익명").slice(0, 10), text: String(text).slice(0, 200), ts: Date.now() });
  });

  socket.on("disconnect", () => {
    adminSockets.delete(socket.id);
    loggedInNickname.delete(socket.id);
    const code = socketRoom.get(socket.id);
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    room.removeBySocket(socket.id);
    socketRoom.delete(socket.id);
    const hasHumanPlayer = room.players.some((p) => p && !p.isBot);
    const hasSpectator = room.spectators.length > 0;
    if (!hasHumanPlayer && !hasSpectator) rooms.delete(code); // 사람이 아무도 없고 봇만(혹은 빈 자리만) 남으면 방 삭제
    else broadcast(code);
  });
});

function getRoomCode(socket) {
  const code = socketRoom.get(socket.id);
  return { room: code ? rooms.get(code) : null, code };
}
function getRoomSeat(socket) {
  const { room, code } = getRoomCode(socket);
  if (!room) return { room: null, seat: -1, code };
  return { room, seat: room.seatBySocket(socket.id), code };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Tichu server listening on :${PORT}`));
