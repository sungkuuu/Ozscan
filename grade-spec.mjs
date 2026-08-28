// The grade's constants, in one place.
//
// These were literals inside wallet-grades.mjs and prose on the site, which is
// how the published description of the "excl. best wallet" column drifted away
// from what the code computed (2026-08-28). The scorer and the methodology page
// now read the same object, so a threshold cannot change in one and not the
// other.

export const SETTLED_BET = {
  side: 'BUY',
  price_min_cents: 5,
  price_max_cents: 95,
  note: 'the market must have closed with a winning outcome recorded',
};

// A bet stakes `size` USDC at `price` cents. Winning returns the full share
// value, so profit is size × (100 − price) / price; losing costs the stake.
export const PNL = {
  win: 'size × (100 − price) / price',
  loss: '−size',
  roi_staked: 'Σ profit ÷ Σ stake — one dollar, one vote',
  roi_equal: 'mean of (profit ÷ stake) per bet — one bet, one vote',
};

export const FLAGS = [
  { key: 'bot-pace', rule: 'more than 500 settled bets per active day', penalty: 25 },
  { key: 'single-bet-driven', rule: 'one bet produced more than 30% of total profit', penalty: 15 },
  { key: 'weighting-flip', rule: 'stake-weighted and equal-weighted ROI disagree in sign', penalty: 15 },
  { key: 'thin-sample', rule: 'fewer than 100 settled bets', penalty: 10 },
  { key: 'favorite-heavy', rule: 'average entry above 80¢', penalty: 0 },
  { key: 'dormant', rule: 'no settled bet in the 30 days before the window ends', penalty: 0 },
  { key: 'negative-clv', rule: 'one-hour markout after detection is below zero', penalty: 0 },
];

export const SCORE = {
  base: 'the lower of the two ROI readings, clamped to ±50',
  clv_bonus: 'the one-hour markout in cents × 5, clamped to ±10',
  dormant_cap: 5,
  clamp: 50,
};

export const CUTOFFS = [
  { g: 'A', rule: 'score ≥ 20 and no flags at all' },
  { g: 'B', rule: 'score ≥ 10' },
  { g: 'C', rule: 'score ≥ 0' },
  { g: 'D', rule: 'score ≥ −15' },
  { g: 'F', rule: 'below −15' },
];

// Numeric forms, for the scorer.
export const N = {
  PRICE_MIN: 5,
  PRICE_MAX: 95,
  BOT_PACE: 500,
  TOP1_SHARE: 30,
  THIN_SAMPLE: 100,
  FAVORITE_CENTS: 80,
  DORMANT_DAYS: 30,
  CLAMP: 50,
  CLV_MULT: 5,
  CLV_CLAMP: 10,
  DORMANT_CAP: 5,
  PENALTY: { 'bot-pace': 25, 'single-bet-driven': 15, 'weighting-flip': 15, 'thin-sample': 10 },
  A_SCORE: 20, B_SCORE: 10, C_SCORE: 0, D_SCORE: -15,
};
