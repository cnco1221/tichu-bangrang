// 티츄 카드 덱: 4 슈트(옥/검/탑/별) x (2~10,J,Q,K,A) = 52장 + 특수카드 4장(참새,개,봉황,용) = 56장
const SUITS = ["jade", "sword", "pagoda", "star"]; // 옥, 검, 탑, 별
const SUIT_LABEL = { jade: "옥", sword: "검", pagoda: "탑", star: "별" };
const RANK_LABEL = {
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10",
  11: "J", 12: "Q", 13: "K", 14: "A"
};

// 카드 점수 (5=5점 10=10점 K=10점 용=25점 봉황=-25점)
function cardPoints(card) {
  if (card.special === "dragon") return 25;
  if (card.special === "phoenix") return -25;
  if (card.rank === 5) return 5;
  if (card.rank === 10 || card.rank === 13) return 10;
  return 0;
}

function buildDeck() {
  const cards = [];
  for (const suit of SUITS) {
    for (let rank = 2; rank <= 14; rank++) {
      cards.push({
        id: `${suit}_${rank}`,
        suit,
        rank,
        special: null,
        label: `${SUIT_LABEL[suit]}${RANK_LABEL[rank]}`,
      });
    }
  }
  // 특수카드: 참새(1), 개, 봉황, 용
  cards.push({ id: "special_sparrow", suit: null, rank: 1, special: "sparrow", label: "참새(1)" });
  cards.push({ id: "special_dog", suit: null, rank: 0, special: "dog", label: "개" });
  cards.push({ id: "special_phoenix", suit: null, rank: 14.5, special: "phoenix", label: "봉황" });
  cards.push({ id: "special_dragon", suit: null, rank: 15, special: "dragon", label: "용" });

  for (const c of cards) c.points = cardPoints(c);
  return cards;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// seatIndex 0~3 순서로 14장씩 딜 (8장 먼저 -> 라지티츄 판단용, 나머지 6장)
function dealHands() {
  const deck = shuffle(buildDeck());
  const hands = [[], [], [], []];
  for (let i = 0; i < 56; i++) {
    hands[i % 4].push(deck[i]);
  }
  const first8 = hands.map((h) => sortHand(h.slice(0, 8)));
  const full14 = hands.map((h) => sortHand(h));
  return { first8, full14 };
}

function sortHand(cards) {
  return cards.slice().sort((a, b) => a.rank - b.rank || (a.suit || "").localeCompare(b.suit || ""));
}

module.exports = { SUITS, SUIT_LABEL, RANK_LABEL, buildDeck, dealHands, sortHand, cardPoints };
