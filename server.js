const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Room } = require("./game/Room");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map(); // code -> Room
const socketRoom = new Map(); // socketId -> code

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
    io.to(p.socketId).emit("state", room.getStateFor(room.seatBySocket(p.socketId), false));
  }
  for (const s of room.spectators) {
    io.to(s.socketId).emit("state", room.getStateFor(null, true));
  }
}

function runBots(code, delay = 700) {
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
  runBots(code);
}

function makeRoom(code) {
  const room = new Room(code, (c) => afterMutation(c)); // 타이머/지연 이벤트 후에도 봇 턴이 이어지도록 afterMutation 사용
  rooms.set(code, room);
  return room;
}

io.on("connection", (socket) => {
  socket.on("createRoom", ({ name }, cb) => {
    const code = genCode();
    const room = makeRoom(code);
    const seat = room.addPlayer(socket.id, (name || "").slice(0, 10));
    socketRoom.set(socket.id, code);
    socket.join(code);
    cb && cb({ ok: true, code, seat });
    broadcast(code);
  });

  socket.on("joinRoom", ({ code, name, asSpectator }, cb) => {
    code = (code || "").toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb && cb({ error: "존재하지 않는 방이에요" });
    const trimmedName = (name || "").slice(0, 10);
    if (asSpectator || room.isFull()) {
      room.addSpectator(socket.id, trimmedName);
      socketRoom.set(socket.id, code);
      socket.join(code);
      cb && cb({ ok: true, code, seat: null, spectator: true });
    } else {
      const seat = room.addPlayer(socket.id, trimmedName);
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

  socket.on("addBot", (_, cb) => {
    const { room, code } = getRoomCode(socket);
    if (!room) return cb && cb({ error: "방에 먼저 들어가야 해요" });
    if (room.phase !== "lobby") return cb && cb({ error: "게임 중에는 봇을 추가할 수 없어요" });
    const seat = room.players.findIndex((p) => p === null);
    if (seat === -1) return cb && cb({ error: "빈 자리가 없어요" });
    room.addBot(seat);
    cb && cb({ ok: true, seat });
    if (room.players.every((p) => p !== null && p.ready)) room.startGame();
    afterMutation(code);
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

  socket.on("disconnect", () => {
    const code = socketRoom.get(socket.id);
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    room.removeBySocket(socket.id);
    socketRoom.delete(socket.id);
    const noPlayers = room.players.every((p) => p === null);
    const noSpectators = room.spectators.length === 0;
    if (noPlayers && noSpectators) rooms.delete(code);
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
