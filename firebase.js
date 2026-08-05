// Firebase Admin SDK 초기화. 아래 3개 환경변수가 있어야 동작함:
//   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
// (README.md의 "파이어베이스 연동" 섹션 참고)
const admin = require("firebase-admin");

let db = null;
let firebaseReady = false;

function initFirebase() {
  if (firebaseReady) return db;
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    console.warn("[firebase] 환경변수(FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY)가 없어서 회원가입/랭킹 기능이 비활성화됩니다.");
    return null;
  }
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: FIREBASE_PROJECT_ID,
        clientEmail: FIREBASE_CLIENT_EMAIL,
        // Render 등에 환경변수로 넣으면 개행이 \n 문자열로 이스케이프되는 경우가 많아 원상복구
        privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      }),
    });
    db = admin.firestore();
    firebaseReady = true;
    console.log("[firebase] 연결 성공");
  } catch (e) {
    console.error("[firebase] 초기화 실패:", e.message);
    db = null;
  }
  return db;
}

function isFirebaseReady() {
  return firebaseReady;
}

module.exports = { initFirebase, isFirebaseReady, admin };
