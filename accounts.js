const crypto = require("crypto");
const { initFirebase } = require("./firebase");

const MEMBERS = "members";
const ADMIN_CONFIG_DOC = "adminConfig/main";
const INITIAL_ADMIN_PASSWORD = "159";

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
  const snap = await db.collection(MEMBERS).doc(nickname).get();
  if (!snap.exists) return { error: "존재하지 않는 닉네임이에요" };
  const data = snap.data();
  if (!verifyPassword(password, data.salt, data.passwordHash)) return { error: "비밀번호가 틀렸어요" };
  if (!data.approved) return { error: "아직 관리자 승인 대기 중이에요" };
  return { ok: true, nickname: data.nickname };
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

/* ---------------- 랭킹 ---------------- */

async function getRanking() {
  const db = initFirebase();
  if (!db) return { ranked: [], unranked: [] };
  const snap = await db.collection(MEMBERS).where("approved", "==", true).get();
  const ranked = [];
  const unranked = [];
  snap.forEach((d) => {
    const v = d.data();
    const wins = v.wins || 0, losses = v.losses || 0;
    const total = wins + losses;
    if (total === 0) {
      unranked.push({ nickname: v.nickname });
    } else {
      ranked.push({ nickname: v.nickname, wins, losses, score: wins - losses, winRate: wins / total });
    }
  });
  ranked.sort((a, b) => b.score - a.score || b.wins - a.wins);
  return { ranked, unranked };
}

async function recordRankedResult(winningNicknames, losingNicknames) {
  const db = initFirebase();
  if (!db) return;
  const { admin } = require("./firebase");
  const batch = db.batch();
  for (const nickname of winningNicknames) {
    batch.set(db.collection(MEMBERS).doc(nickname), { wins: admin.firestore.FieldValue.increment(1) }, { merge: true });
  }
  for (const nickname of losingNicknames) {
    batch.set(db.collection(MEMBERS).doc(nickname), { losses: admin.firestore.FieldValue.increment(1) }, { merge: true });
  }
  await batch.commit();
}

module.exports = {
  signup, login,
  adminLogin, adminChangePassword,
  adminListPending, adminApprove, adminReject,
  adminListMembers, adminDeleteMember, adminResetPassword, adminSetRecord,
  getRanking, recordRankedResult,
};
