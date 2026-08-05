// 콤보(족보) 분류: single, pair, triple, fullhouse, straight, pairSequence(연속 페어=계단),
// bomb4(포카드), bombStraight(같은무늬 5장 이상 연속=스트레이트 플러시 폭탄), dog(단독 특수)
//
// 반환: { type, len, power, hasPhoenix, cards } 또는 null(불법 조합)

function isSpecial(c, name) {
  return c.special === name;
}

function classify(cards) {
  if (!cards || cards.length === 0) return null;

  // 개는 단독으로만 낼 수 있고, 무조건 팀메이트에게 턴 넘김 (트릭에 점수 없음)
  if (cards.length === 1 && isSpecial(cards[0], "dog")) {
    return { type: "dog", len: 1, power: -1, hasPhoenix: false, cards };
  }

  const hasPhoenix = cards.some((c) => isSpecial(c, "phoenix"));
  const hasDragon = cards.some((c) => isSpecial(c, "dragon"));
  const hasSparrow = cards.some((c) => isSpecial(c, "sparrow"));

  // 싱글
  if (cards.length === 1) {
    const c = cards[0];
    if (isSpecial(c, "dragon")) return { type: "single", len: 1, power: 200, hasPhoenix: false, cards, isDragon: true };
    if (isSpecial(c, "phoenix")) return { type: "single", len: 1, power: 100, hasPhoenix: true, cards, isPhoenix: true }; // power 는 트릭 컨텍스트에서 재계산됨
    return { type: "single", len: 1, power: c.rank, hasPhoenix: false, cards };
  }

  if (hasDragon) return null; // 용은 싱글 외 조합 불가

  // 일반 랭크 카운트 (참새=1, 봉황은 와일드)
  const ranks = cards.filter((c) => !isSpecial(c, "phoenix")).map((c) => (isSpecial(c, "sparrow") ? 1 : c.rank));
  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const uniqueRanks = Object.keys(counts).map(Number).sort((a, b) => a - b);

  // 페어
  if (cards.length === 2) {
    if (hasSparrow) return null; // 참새는 페어 불가
    if (hasPhoenix) {
      const r = uniqueRanks[0];
      return { type: "pair", len: 2, power: r, hasPhoenix: true, cards };
    }
    if (uniqueRanks.length === 1) return { type: "pair", len: 2, power: uniqueRanks[0], hasPhoenix: false, cards };
    return null;
  }

  // 트리플
  if (cards.length === 3) {
    if (hasSparrow) return null;
    if (hasPhoenix) {
      if (uniqueRanks.length === 1) return { type: "triple", len: 3, power: uniqueRanks[0], hasPhoenix: true, cards };
      return null;
    }
    if (uniqueRanks.length === 1) return { type: "triple", len: 3, power: uniqueRanks[0], hasPhoenix: false, cards };
    return null;
  }

  // 4장: 봄(포카드) 또는 연속페어(계단) 2쌍
  if (cards.length === 4) {
    if (!hasSparrow && !hasPhoenix && uniqueRanks.length === 1) {
      return { type: "bomb4", len: 4, power: uniqueRanks[0], hasPhoenix: false, cards, isBomb: true };
    }
    const ps4 = tryPairSequence(cards, uniqueRanks, counts, hasPhoenix, hasSparrow);
    if (ps4) return ps4;
    return null;
  }

  // 5장: 풀하우스, 스트레이트, 스트레이트플러시 봄
  if (cards.length === 5) {
    const fh = tryFullHouse(cards, uniqueRanks, counts, hasPhoenix, hasSparrow);
    if (fh) return fh;
    const st = tryStraight(cards, hasPhoenix, hasSparrow);
    if (st) return st;
    return null;
  }

  // 6장 이상: 스트레이트, 스트레이트플러시봄, 페어시퀀스(계단)
  if (cards.length >= 6) {
    const st = tryStraight(cards, hasPhoenix, hasSparrow);
    if (st) return st;
    const ps = tryPairSequence(cards, uniqueRanks, counts, hasPhoenix, hasSparrow);
    if (ps) return ps;
    return null;
  }

  return null;
}

function tryFullHouse(cards, uniqueRanks, counts, hasPhoenix, hasSparrow) {
  if (hasSparrow) return null;
  if (hasPhoenix) {
    if (uniqueRanks.length === 2) {
      const [a, b] = uniqueRanks;
      const ca = counts[a], cb = counts[b];
      if ((ca === 3 && cb === 1) || (ca === 1 && cb === 3)) {
        const triple = ca === 3 ? a : b;
        return { type: "fullhouse", len: 5, power: triple, hasPhoenix: true, cards };
      }
      if (ca === 2 && cb === 2) {
        // 페어 두 개 + 봉황: 봉황이 트리플을 완성함 -> 유리한 쪽(더 높은 랭크)을 트리플로 인정
        const triple = Math.max(a, b);
        return { type: "fullhouse", len: 5, power: triple, hasPhoenix: true, cards };
      }
    }
    return null;
  }
  if (uniqueRanks.length === 2) {
    const [a, b] = uniqueRanks;
    const ca = counts[a], cb = counts[b];
    if (ca === 3 && cb === 2) return { type: "fullhouse", len: 5, power: a, hasPhoenix: false, cards };
    if (cb === 3 && ca === 2) return { type: "fullhouse", len: 5, power: b, hasPhoenix: false, cards };
  }
  return null;
}

function tryStraight(cards, hasPhoenix, hasSparrow) {
  const len = cards.length;
  if (len < 5) return null;
  const nonPhoenix = cards.filter((c) => !isSpecial(c, "phoenix"));
  const ranks = nonPhoenix.map((c) => (isSpecial(c, "sparrow") ? 1 : c.rank));
  const uniq = Array.from(new Set(ranks)).sort((a, b) => a - b);
  if (uniq.length !== ranks.length) return null; // 중복 랭크 있으면 스트레이트 아님

  if (!hasPhoenix) {
    const minR = uniq[0];
    const maxR = uniq[uniq.length - 1];
    if (maxR - minR + 1 !== len) return null; // 완전히 연속이어야 함
    const suits = new Set(nonPhoenix.map((c) => c.suit));
    if (suits.size === 1) return { type: "bombStraight", len, power: maxR, hasPhoenix: false, cards, isBomb: true };
    return { type: "straight", len, power: maxR, hasPhoenix: false, cards };
  }

  // 봉황 1장 포함: 나머지 카드들은 서로 중복 없이 len-1장이어야 하고,
  // 그 범위 안의 빈 칸이 정확히 1개(봉황이 채움)이거나, 이미 완전히 연속이면 봉황이 위/아래로 한 칸 확장함
  if (uniq.length !== len - 1) return null;
  const minR = uniq[0];
  const maxR = uniq[uniq.length - 1];
  const knownSpan = maxR - minR + 1;
  const gapsInside = knownSpan - uniq.length;

  if (gapsInside === 1) {
    return { type: "straight", len, power: maxR, hasPhoenix: true, cards };
  }
  if (gapsInside === 0) {
    if (maxR < 14) return { type: "straight", len, power: maxR + 1, hasPhoenix: true, cards }; // 위로 확장(유리한 쪽)
    if (minR > 1) return { type: "straight", len, power: maxR, hasPhoenix: true, cards }; // 위로 못 가면 아래로 확장
    return null;
  }
  return null; // 빈 칸이 2개 이상이면 봉황 한 장으로는 못 채움
}

function tryPairSequence(cards, uniqueRanks, counts, hasPhoenix, hasSparrow) {
  if (hasSparrow) return null;
  if (cards.length % 2 !== 0) return null;
  const pairsNeeded = cards.length / 2;
  let wildUsed = 0;
  for (const r of uniqueRanks) {
    if (counts[r] === 2) continue;
    if (counts[r] === 1 && hasPhoenix && wildUsed === 0) { wildUsed = 1; continue; }
    return null;
  }
  if (hasPhoenix && wildUsed === 0) return null;
  if (uniqueRanks.length !== pairsNeeded) return null;
  const sorted = uniqueRanks.slice().sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) return null;
  }
  const power = sorted[sorted.length - 1];
  return { type: "pairSequence", len: cards.length, power, hasPhoenix, cards };
}

// combo(new)가 prev를 이길 수 있는지. prev===null이면(리드) 항상 가능(개 제외는 호출부에서 처리)
function canBeat(combo, prev) {
  if (!combo) return false;
  if (!prev) return true;

  const prevIsBomb = prev.type === "bomb4" || prev.type === "bombStraight";
  const comboIsBomb = combo.type === "bomb4" || combo.type === "bombStraight";

  if (comboIsBomb && !prevIsBomb) return true;
  if (comboIsBomb && prevIsBomb) {
    if (combo.type === "bomb4" && prev.type === "bomb4") return combo.power > prev.power;
    if (combo.type === "bombStraight" && prev.type === "bombStraight") {
      if (combo.len !== prev.len) return combo.len > prev.len;
      return combo.power > prev.power;
    }
    return combo.type === "bombStraight" && prev.type === "bomb4";
  }
  if (!comboIsBomb && prevIsBomb) return false;

  if (combo.type !== prev.type) return false;
  if (combo.len !== prev.len) return false;
  return combo.power > prev.power;
}

// ---- 참새 요청(콜) 강제 이행 판정 ----
function kCombinations(arr, k) {
  const results = [];
  const n = arr.length;
  if (k < 0 || k > n) return results;
  const combo = [];
  function backtrack(start) {
    if (combo.length === k) { results.push(combo.slice()); return; }
    for (let i = start; i < n; i++) {
      combo.push(arr[i]);
      backtrack(i + 1);
      combo.pop();
    }
  }
  backtrack(0);
  return results;
}

// hand(카드배열) 안에 rank(숫자)를 반드시 포함해 낼 수 있는 합법적인 조합이 있는지 탐색.
// prevCombo가 null이면 리드 상황(무조건 그 카드를 포함해서 내야 함, 항상 가능).
// prevCombo가 있으면 그 조합의 타입/장수를 지키면서 이겨야 하며, 포카드 봄은 예외적으로 항상 허용.
function existsLegalPlayContainingRank(hand, rank, prevCombo) {
  const rankCards = hand.filter((c) => !c.special && c.rank === rank);
  if (rankCards.length === 0) return null;

  if (rankCards.length === 4) {
    const bombCombo = classify(rankCards);
    if (bombCombo && bombCombo.type === "bomb4" && (!prevCombo || canBeat(bombCombo, prevCombo))) {
      return bombCombo;
    }
  }

  if (!prevCombo) {
    return { type: "single", len: 1, power: rank, hasPhoenix: false, cards: [rankCards[0]] };
  }

  if (prevCombo.type === "single") {
    const single = { type: "single", len: 1, power: rank, hasPhoenix: false, cards: [rankCards[0]] };
    return canBeat(single, prevCombo) ? single : null;
  }

  const targetLen = prevCombo.len;
  if (targetLen > 8) return null; // 성능 보호용 상한 (극단적으로 긴 스트레이트/계단은 강제 생략)

  const anchor = rankCards[0];
  const restPool = hand.filter((c) => c.id !== anchor.id);
  const combosToTry = kCombinations(restPool, targetLen - 1);
  for (const combo of combosToTry) {
    const attempt = [anchor, ...combo];
    const classified = classify(attempt);
    if (classified && classified.type === prevCombo.type && classified.len === targetLen && canBeat(classified, prevCombo)) {
      return classified;
    }
  }
  return null;
}

module.exports = { classify, canBeat, existsLegalPlayContainingRank };
