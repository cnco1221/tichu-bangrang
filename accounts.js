const crypto = require("crypto");
const { initFirebase } = require("./firebase");

const MEMBERS = "members";
const ADMIN_CONFIG_DOC = "adminConfig/main";
const SEASON_CONFIG_DOC = "seasonConfig/main";
const HALL_OF_FAME = "hallOfFame";
const INITIAL_ADMIN_PASSWORD = "159";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayDateStr() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { hash, salt };
}

function verifyPassword(password, salt, hash) {
  const { hash: check } = hashPassword(password, salt);
  try {
    return crypto.timingSafeEqual(Buffer.from(check, "hex"), Buffer.from(hash, "hex"));
  } catch (e) {
    return false;
  }
}

function genSessionToken() {
  return crypto.randomBytes(24).toString("hex");
}

async function ensureAdminConfig() {
  const db = initFirebase();
  if (!db) return null;
  const ref = db.doc(ADMIN_CONFIG_DOC);
  const snap = await ref.get();
  if (!snap.exists) {
    const { hash, salt } = hashPassword(INITIAL_ADMIN_PASSWORD);
    await ref.set({ passwordHash: hash, salt });
    return { passwordHash: hash, salt };
  }
  return snap.data();
}

/* ---------------- 회원가입 / 로그인 ---------------- */

async function signup({ name, nickname, password }) {
  const db = initFirebase();
  if (!db) return { error: "서버에 아직 회원 시스템이 설정되지 않았어요(관리자에게 문의)" };
  name = String(name || "").trim().slice(0, 20);
  nickname = String(nickname || "").trim().slice(0, 10);
  password = String(password || "");
  if (!name || !nickname || !password) return { error: "이름/닉네임/비밀번호를 모두 입력해주세요" };
  if (password.length < 3) return { error: "비밀번호가 너무 짧아요" };

  const ref = db.collection(MEMBERS).doc(nickname);
  const snap = await ref.get();
  if (snap.exists) return { error: "이미 사용 중인 닉네임이에요" };

  const { hash, salt } = hashPassword(password);
  await ref.set({
    name,
    nickname,
    passwordHash: hash,
    salt,
    approved: false,
    createdAt: Date.now(),
    wins: 0,
    losses: 0,
  });
  return { ok: true };
}

async function login({ nickname, password }) {
  const db = initFirebase();
  if (!db) return { error: "서버에 아직 회원 시스템이 설정되지 않았어요(관리자에게 문의)" };
  nickname = String(nickname || "").trim().slice(0, 10);
  if (!nickname) return { error: "닉네임을 입력해주세요" };
  const ref = db.collection(MEMBERS).doc(nickname);
  const snap = await ref.get();
  if (!snap.exists) return { error: "존재하지 않는 닉네임이에요" };
  const data = snap.data();
  if (!verifyPassword(password, data.salt, data.passwordHash)) return { error: "비밀번호가 틀렸어요" };
  if (!data.approved) return { error: "아직 관리자 승인 대기 중이에요" };
  // 로그인할 때마다 세션 토큰을 새로 발급해서 저장 -> 다른 기기에 남아있던 이전 토큰은 자동으로 무효화됨
  const sessionToken = genSessionToken();
  await ref.set({ sessionToken }, { merge: true });
  return { ok: true, nickname: data.nickname, sessionToken };
}

// "로그인 상태 유지" 체크 시 클라이언트가 로컬에 저장해뒀던 세션 토큰으로 재로그인
async function loginWithToken({ nickname, sessionToken }) {
  const db = initFirebase();
  if (!db) return { error: "서버에 아직 회원 시스템이 설정되지 않았어요(관리자에게 문의)" };
  nickname = String(nickname || "").trim().slice(0, 10);
  sessionToken = String(sessionToken || "");
  if (!nickname || !sessionToken) return { error: "세션 정보가 없어요" };
  const snap = await db.collection(MEMBERS).doc(nickname).get();
  if (!snap.exists) return { error: "존재하지 않는 닉네임이에요" };
  const data = snap.data();
  if (!data.approved) return { error: "아직 관리자 승인 대기 중이에요" };
  if (!data.sessionToken || data.sessionToken !== sessionToken) return { error: "세션이 만료됐어요. 다시 로그인해주세요" };
  return { ok: true, nickname: data.nickname };
}

// 로그인한 본인이 직접 비밀번호 변경(관리자 승인 없이 바로 적용). 현재 비밀번호 확인 필요
async function changePassword(nickname, oldPassword, newPassword) {
  const db = initFirebase();
  if (!db) return { error: "서버에 아직 회원 시스템이 설정되지 않았어요(관리자에게 문의)" };
  nickname = String(nickname || "").trim().slice(0, 10);
  if (!nickname) return { error: "로그인이 필요해요" };
  newPassword = String(newPassword || "");
  if (newPassword.length < 3) return { error: "새 비밀번호가 너무 짧아요" };
  const ref = db.collection(MEMBERS).doc(nickname);
  const snap = await ref.get();
  if (!snap.exists) return { error: "존재하지 않는 멤버예요" };
  const data = snap.data();
  if (!verifyPassword(oldPassword, data.salt, data.passwordHash)) return { error: "현재 비밀번호가 틀렸어요" };
  const { hash, salt } = hashPassword(newPassword);
  await ref.set({ passwordHash: hash, salt }, { merge: true });
  return { ok: true };
}

/* ---------------- 관리자 ---------------- */

async function adminLogin(password) {
  const config = await ensureAdminConfig();
  if (!config) return { error: "서버에 아직 회원 시스템이 설정되지 않았어요(관리자에게 문의)" };
  if (!verifyPassword(password, config.salt, config.passwordHash)) return { error: "비밀번호가 틀렸어요" };
  return { ok: true };
}

async function adminChangePassword(newPassword) {
  const db = initFirebase();
  if (!db) return { error: "설정 안 됨" };
  newPassword = String(newPassword || "");
  if (newPassword.length < 3) return { error: "비밀번호가 너무 짧아요" };
  const { hash, salt } = hashPassword(newPassword);
  await db.doc(ADMIN_CONFIG_DOC).set({ passwordHash: hash, salt });
  return { ok: true };
}

async function adminListPending() {
  const db = initFirebase();
  if (!db) return [];
  const snap = await db.collection(MEMBERS).where("approved", "==", false).get();
  return snap.docs.map((d) => ({ name: d.data().name, nickname: d.data().nickname }));
}

async function adminApprove(nickname) {
  const db = initFirebase();
  if (!db) return { error: "설정 안 됨" };
  if (!nickname) return { error: "닉네임이 없어요" };
  await db.collection(MEMBERS).doc(nickname).set({ approved: true }, { merge: true });
  return { ok: true };
}

async function adminReject(nickname) {
  const db = initFirebase();
  if (!db) return { error: "설정 안 됨" };
  if (!nickname) return { error: "닉네임이 없어요" };
  await db.collection(MEMBERS).doc(nickname).delete();
  return { ok: true };
}

async function adminListMembers() {
  const db = initFirebase();
  if (!db) return [];
  const snap = await db.collection(MEMBERS).where("approved", "==", true).get();
  return snap.docs.map((d) => {
    const v = d.data();
    return { name: v.name, nickname: v.nickname, wins: v.wins || 0, losses: v.losses || 0 };
  });
}

async function adminDeleteMember(nickname) {
  const db = initFirebase();
  if (!db) return { error: "설정 안 됨" };
  if (!nickname) return { error: "닉네임이 없어요" };
  await db.collection(MEMBERS).doc(nickname).delete();
  return { ok: true };
}

async function adminResetPassword(nickname, newPassword) {
  const db = initFirebase();
  if (!db) return { error: "설정 안 됨" };
  if (!nickname) return { error: "닉네임이 없어요" };
  newPassword = String(newPassword || "");
  if (newPassword.length < 3) return { error: "비밀번호가 너무 짧아요" };
  const { hash, salt } = hashPassword(newPassword);
  await db.collection(MEMBERS).doc(nickname).set({ passwordHash: hash, salt }, { merge: true });
  return { ok: true };
}

async function adminRenameNickname(nickname, newNickname) {
  const db = initFirebase();
  if (!db) return { error: "설정 안 됨" };
  if (!nickname) return { error: "닉네임이 없어요" };
  newNickname = String(newNickname || "").trim().slice(0, 10);
  if (!newNickname) return { error: "새 게임닉을 입력해주세요" };
  if (newNickname === nickname) return { ok: true };
  const oldRef = db.collection(MEMBERS).doc(nickname);
  const oldSnap = await oldRef.get();
  if (!oldSnap.exists) return { error: "존재하지 않는 멤버예요" };
  const newRef = db.collection(MEMBERS).doc(newNickname);
  if ((await newRef.get()).exists) return { error: "이미 사용 중인 게임닉이에요" };
  const data = oldSnap.data();
  await newRef.set({ ...data, nickname: newNickname, sessionToken: null });
  await oldRef.delete();
  return { ok: true };
}

async function adminSetRecord(nickname, wins, losses) {
  const db = initFirebase();
  if (!db) return { error: "설정 안 됨" };
  if (!nickname) return { error: "닉네임이 없어요" };
  wins = Math.max(0, parseInt(wins, 10) || 0);
  losses = Math.max(0, parseInt(losses, 10) || 0);
  const ref = db.collection(MEMBERS).doc(nickname);
  const snap = await ref.get();
  if (!snap.exists) return { error: "존재하지 않는 멤버예요" };
  await ref.set({ wins, losses }, { merge: true });
  return { ok: true };
}

/* ---------------- 랭킹 시즌 ---------------- */

// 시즌 종료일이 지났는데 아직 명예의 전당에 기록이 안 됐으면, 그 시즌의 현재 랭킹 1등을 자동으로 등록한다.
// (별도 스케줄러 없이, 시즌 정보를 조회할 때마다 지연 평가로 체크함 - 랭킹창을 열 때마다 호출되므로 충분함)
async function _maybeRecordSeasonEnd(db, season) {
  if (!season.name || !season.startDate || !season.endDate) return;
  if (todayDateStr() <= season.endDate) return; // 아직 시즌 진행 중
  const seasonKey = `${season.startDate}_${season.endDate}_${season.name}`;
  const existing = await db.collection(HALL_OF_FAME).where("seasonKey", "==", seasonKey).limit(1).get();
  if (!existing.empty) return; // 이미 기록됨
  const { ranked } = await getRanking();
  if (!ranked.length) return; // 이 시즌에 등급전 기록이 없으면 올릴 사람이 없음
  const champion = ranked[0];
  await db.collection(HALL_OF_FAME).add({
    seasonName: season.name,
    nickname: champion.nickname,
    seasonKey,
    addedAt: Date.now(),
  });
}

// 시즌 시작일/종료일은 "YYYY-MM-DD" 형태의 날짜 문자열로만 저장한다(항상 00시 00분 기준으로 적용됨)
async function getSeason() {
  const db = initFirebase();
  if (!db) return { name: null, startDate: null, endDate: null };
  const snap = await db.doc(SEASON_CONFIG_DOC).get();
  if (!snap.exists) return { name: null, startDate: null, endDate: null };
  const d = snap.data();
  const season = { name: d.name || null, startDate: d.startDate || null, endDate: d.endDate || null };
  await _maybeRecordSeasonEnd(db, season);
  return season;
}

async function adminSetSeason(name, startDate, endDate) {
  const db = initFirebase();
  if (!db) return { error: "설정 안 됨" };
  name = String(name || "").trim().slice(0, 30);
  startDate = String(startDate || "").trim();
  endDate = String(endDate || "").trim();
  if (!name) return { error: "시즌 이름을 입력해주세요" };
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) return { error: "시작일/종료일을 모두 선택해주세요" };
  if (startDate > endDate) return { error: "종료일이 시작일보다 빠를 수 없어요" };
  await db.doc(SEASON_CONFIG_DOC).set({ name, startDate, endDate });
  return { ok: true };
}

/* ---------------- 랭킹 ---------------- */

// 랭킹 표는 시즌 승/패(seasonWins/seasonLosses, "시즌초기화"로 리셋됨)를 기준으로 하고,
// "내 정보"에 쓰이는 평생 누적 승/패(wins/losses)는 별도로 함께 내려줌
async function getRanking() {
  const db = initFirebase();
  if (!db) return { ranked: [], unranked: [] };
  const snap = await db.collection(MEMBERS).where("approved", "==", true).get();
  const ranked = [];
  const unranked = [];
  snap.forEach((d) => {
    const v = d.data();
    const wins = v.seasonWins || 0, losses = v.seasonLosses || 0;
    const lifetimeWins = v.wins || 0, lifetimeLosses = v.losses || 0;
    const total = wins + losses;
    if (total === 0) {
      unranked.push({ nickname: v.nickname, lifetimeWins, lifetimeLosses });
    } else {
      ranked.push({ nickname: v.nickname, wins, losses, score: wins - losses, winRate: wins / total, lifetimeWins, lifetimeLosses });
    }
  });
  ranked.sort((a, b) => b.score - a.score || b.wins - a.wins);
  return { ranked, unranked };
}

async function recordRankedResult(winningNicknames, losingNicknames) {
  const db = initFirebase();
  if (!db) return;
  const { admin } = require("./firebase");
  const inc = admin.firestore.FieldValue.increment(1);
  const batch = db.batch();
  for (const nickname of winningNicknames) {
    batch.set(db.collection(MEMBERS).doc(nickname), { wins: inc, seasonWins: inc }, { merge: true });
  }
  for (const nickname of losingNicknames) {
    batch.set(db.collection(MEMBERS).doc(nickname), { losses: inc, seasonLosses: inc }, { merge: true });
  }
  await batch.commit();
}

// 시즌초기화: 랭킹에 쓰이는 시즌 승/패만 0으로 되돌림 (평생 누적 승/패, 즉 "내 정보"는 그대로 둠)
async function adminResetSeasonRankings() {
  const db = initFirebase();
  if (!db) return { error: "설정 안 됨" };
  const snap = await db.collection(MEMBERS).where("approved", "==", true).get();
  if (!snap.empty) {
    const batch = db.batch();
    snap.forEach((d) => { batch.set(d.ref, { seasonWins: 0, seasonLosses: 0 }, { merge: true }); });
    await batch.commit();
  }
  return { ok: true };
}

/* ---------------- 명예의 전당 ---------------- */

async function getHallOfFame() {
  const db = initFirebase();
  if (!db) return [];
  const snap = await db.collection(HALL_OF_FAME).orderBy("addedAt", "desc").get();
  return snap.docs.map((d) => ({ id: d.id, seasonName: d.data().seasonName, nickname: d.data().nickname }));
}

async function adminDeleteHof(id) {
  const db = initFirebase();
  if (!db) return { error: "설정 안 됨" };
  if (!id) return { error: "id가 없어요" };
  await db.collection(HALL_OF_FAME).doc(id).delete();
  return { ok: true };
}

module.exports = {
  signup, login, loginWithToken, changePassword,
  adminLogin, adminChangePassword,
  adminListPending, adminApprove, adminReject,
  adminListMembers, adminDeleteMember, adminResetPassword, adminRenameNickname, adminSetRecord,
  getRanking, recordRankedResult, adminResetSeasonRankings,
  getSeason, adminSetSeason,
  getHallOfFame, adminDeleteHof,
};
