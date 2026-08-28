// Build the walk-forward evidence page (site/public/evidence/).
// Numbers are frozen from the 2026-08-27 run rather than recomputed on every
// deploy: this page documents one dated experiment, and a figure that silently
// moves under a published claim is worse than a stale one. Re-run the walk
// forward and edit RESULT below to publish a new round.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { nav } from './site-nav.mjs';

const ROOT = process.env.REPO_DIR || `${process.env.HOME}/OzScan/Ozscan`;
const head = readFileSync(`${ROOT}/site/head.tmpl.html`, 'utf8');

const RESULT = {
  run_date: '2026-08-27',
  train: 'April 2 – June 30, 2026',
  test: 'July 1 – August 27, 2026',
  grades: [
    { g: 'A', wallets: 30, active: 27, profitable: 23, hit: 85, median: 19.4, exTop: 10.0 },
    { g: 'B', wallets: 36, active: 33, profitable: 18, hit: 55, median: 6.4, exTop: -7.7 },
    { g: 'C', wallets: 101, active: 82, profitable: 41, hit: 50, median: 0.1, exTop: 2.9 },
    { g: 'D', wallets: 179, active: 139, profitable: 68, hit: 49, median: -0.5, exTop: 1.1 },
    { g: 'F', wallets: 378, active: 258, profitable: 136, hit: 53, median: 0.8, exTop: -0.2 },
  ],
  slip: { bets: 31709, matched: 19243, gap: 3.15, wallet: 5.58, follower: 6.08 },
};

// Category check, run 2026-08-28 on the same footing as the walk forward: the
// grades frozen at June 30 (wallet_grades_train) and only the bets those grades
// were computed from. Measuring it against the current 909-wallet table instead
// silently swapped the population — the first published version did that and
// carried a "seventy times" claim the correct cohort does not support.
// Where the graded wallets came from. Counts read from grade_universe on
// 2026-08-28; the collector's whale threshold is WHALE_SIZE_USDC in index.js.
const UNIVERSE = {
  total: 1329,
  whale_usdc: 2000,
  sources: [
    { n: 960, label: 'seen in the live trade feed placing a single trade of $2,000 or more' },
    { n: 196, label: "taken from Polymarket's own leaderboard" },
    { n: 90, label: "taken from a builder's public smart-money leaderboard" },
    { n: 82, label: 'earlier wallets from the same trade feed, backfilled first' },
    { n: 1, label: "featured as a top trader on a builder's front page" },
  ],
  graded: 909,
  cohort: 724,
};

const CATEGORY = {
  run_date: '2026-08-28',
  rule: "/(btc|eth|sol|xrp|doge|bitcoin|ethereum|solana)[-_].*(up|down)|updown/i",
  rows: [
    { g: 'A', bets: 136549, updown: 68 },
    { g: 'B', bets: 279953, updown: 313 },
    { g: 'C', bets: 978705, updown: 11373 },
    { g: 'D', bets: 1337927, updown: 121999 },
    { g: 'F', bets: 10605243, updown: 696045 },
  ],
};

const rows = RESULT.grades.map((r) => `<tr>
<td class="l"><span class="stamp g-${r.g.toLowerCase()}">${r.g}</span></td>
<td class="num">${r.wallets}</td>
<td class="num">${r.active}</td>
<td class="num">${r.profitable}</td>
<td class="num ${r.hit >= 70 ? 'pos' : ''}">${r.hit}%</td>
<td class="num ${r.median > 0 ? 'pos' : 'neg'}">${r.median >= 0 ? '+' : ''}${r.median.toFixed(1)}%</td>
<td class="num ${r.exTop > 0 ? 'pos' : 'neg'}">${r.exTop >= 0 ? '+' : ''}${r.exTop.toFixed(1)}%</td>
</tr>`).join('\n');

const uniRows = UNIVERSE.sources.map((r) =>
  `<li><strong>${r.n.toLocaleString()}</strong> ${r.label}</li>`).join('\n');

const catRows = CATEGORY.rows.map((r) => {
  const pct = (r.updown / r.bets) * 100;
  return `<tr>
<td class="l"><span class="stamp g-${r.g.toLowerCase()}">${r.g}</span></td>
<td class="num">${r.bets.toLocaleString()}</td>
<td class="num">${r.updown.toLocaleString()}</td>
<td class="num ${pct < 1 ? 'pos' : (pct > 5 ? 'neg' : '')}">${pct.toFixed(2)}%</td>
</tr>`;
}).join('\n');

const s = RESULT.slip;
const body = `
<body>
<div class="wrap">

${nav('/evidence/')}

<header class="masthead">
  <div class="crest">
    <img src="/mark.png" srcset="/mark.png 1x, /mark@2x.png 2x" width="52" height="52" alt="">
    <div class="eyebrow">Assay Score · Evidence · ${RESULT.run_date}</div>
  </div>
  <h1>Did the grades predict anything?</h1>
  <p class="standfirst">A rating is only worth what it forecasts. So we graded wallets using data through June 30, sealed it, and scored those grades against July and August — a period the grading never saw.</p>
</header>

<section>
  <h2>The test</h2>
  <p>Grades were computed from settled outcomes in <strong>${RESULT.train}</strong> and nothing else. They were then measured against realized results in <strong>${RESULT.test}</strong>. No wallet was re-graded using the test period, and no wallet was dropped for performing badly.</p>
</section>

<section>
  <h2>Where the wallets came from</h2>
  <p class="sec-note">Selection decides what a result like this can mean, so here is the whole of it. The universe is ${UNIVERSE.total.toLocaleString()} addresses:</p>
  <ul class="sources">
${uniRows}
  </ul>
  <p>Wallets with fewer than 50 settled bets are not graded, which leaves ${UNIVERSE.graded} today. The walk forward used the ${UNIVERSE.cohort} that cleared that floor on data through June 30.</p>
  <p><strong>This is not a random sample of Polymarket.</strong> Every wallet in it was already large, already ranked, or both — nobody enters by being interesting. Two of the sources rank by past profit, which is the selector this whole report argues against, so the A grade is separating <em>inside</em> a pool that has already been filtered that way rather than picking winners out of the general population.</p>
  <p>Two consequences worth stating plainly. Nothing here speaks to wallets that no leaderboard has noticed and that never placed a $${UNIVERSE.whale_usdc.toLocaleString()} trade while the collector was watching — they were never eligible to be graded. And a wallet that stopped trading before collection began is absent, not failed, so the population is drawn from survivors of a window we did not choose.</p>
</section>

<section>
  <h2>What the grades forecast</h2>
  <p class="sec-note">"Hit rate" is the share of still-active wallets that finished the test period profitable. "Median wallet" is the middle wallet's return on stake — a check that the result isn't one lucky outlier. The last column removes each grade's single best wallet entirely.</p>
  <div class="tablewrap">
    <table>
      <thead><tr>
        <th class="l">Grade</th><th>Graded</th><th>Still active</th><th>Profitable</th>
        <th>Hit rate</th><th>Median wallet</th><th>Excl. best wallet</th>
      </tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </div>
</section>

<section>
  <h2>The finding</h2>
  <div class="callout">
    <div class="eyebrow">Headline result</div>
    <h3>23 of the 27 wallets we graded A were profitable out of sample.</h3>
    <p>The median A wallet returned <strong>+${RESULT.grades[0].median}%</strong> on stake, and the grade still holds at <strong>+${RESULT.grades[0].exTop}%</strong> after deleting its single best performer — so this is not one outlier carrying a cohort. Under a coin-flip assumption, 23 or more out of 27 lands around two in ten thousand.</p>
    <p>Every other grade sits near a coin flip. That is the honest shape of the result: <strong>the signal lives at the top of the scale, not across it.</strong></p>
  </div>
</section>

<section>
  <h2>Could a follower have captured it?</h2>
  <p class="sec-note">Being right is not the same as being copyable. For each A-grade purchase we found the first trade another wallet actually executed in the same market and direction within the next five minutes, and used that as the price a follower could really have paid.</p>
  <dl class="specimen">
    <div class="spec"><dt>A-grade buys tested</dt><dd>${s.bets.toLocaleString()}<small>${s.matched.toLocaleString()} had a follow price</small></dd></div>
    <div class="spec"><dt>Entry price penalty</dt><dd>+${s.gap}¢<small>follower pays more, on average</small></dd></div>
    <div class="spec"><dt>Wallet's own return</dt><dd>+${s.wallet}%<small>on that subset</small></dd></div>
    <div class="spec"><dt>Five-minute follower</dt><dd class="pos">+${s.follower}%<small>same bets, later price</small></dd></div>
  </dl>
  <p>A follower five minutes behind paid about three cents more per share on average and still finished ahead of the wallet itself, because on the larger positions the price more often moved in the follower's favour. The edge here comes from being right about outcomes, not from beating anyone to a price.</p>
</section>

<section>
  <h2>What the grade turned out to be selecting against</h2>
  <p class="sec-note">Nothing in the grade looks at what a market is about. It reads pace, concentration, entry level, sample size and settled return. This check, run ${CATEGORY.run_date}, asks what those inputs ended up excluding. It uses the same footing as the test above — the grades frozen at June 30, and only the bets they were computed from — and counts a bet as crypto up/down when its market slug matches <code>${CATEGORY.rule}</code>.</p>
  <div class="tablewrap">
    <table>
      <thead><tr>
        <th class="l">Grade</th><th>Settled bets</th><th>Crypto up/down</th><th>Share</th>
      </tr></thead>
      <tbody>
${catRows}
      </tbody>
    </table>
  </div>
  <p>A and B wallets are effectively absent from that market — one bet in two thousand for A. D and F sit at roughly one in eleven and one in fifteen. The market resolves every fifteen minutes and is worked at machine pace, and the grade pushed the wallets living there down the scale without being told what the market was.</p>
  <p><strong>The pattern is not monotone.</strong> D carries a higher share than F, so this is not a category filter running quietly inside the grade. What separates cleanly is the top of the scale from the bottom half; the ordering within the bottom half is not explained by this at all.</p>
  <p>It also bounds what outside data can fix. The one public archive of Polymarket order-book depth covers these crypto markets, and on this cohort <strong>0.05% of what an A-grade wallet traded falls inside it</strong>. For the markets a followable wallet actually trades, depth history is not published anywhere.</p>
</section>

<section class="prose">
  <h2>What this does not show</h2>
  <p><strong>It is conditional on liquidity.</strong> Only ${Math.round(s.matched / s.bets * 100)}% of A-grade buys had another trade in the same market within five minutes. In the rest there may simply have been nothing to follow.</p>
  <p><strong>It is conditional on holding to resolution.</strong> A separate experiment measured what happens if you copy and then sell an hour later: the edge disappears. Short-horizon copying and outcome-horizon copying are different strategies, and only the second one survived.</p>
  <p><strong>It is conditional on the market staying uncrowded.</strong> The five-minute cushion exists because few people are currently racing to copy the same wallets. As copy trading grows — and as lists like ours get published — that cushion narrows.</p>
  <p><strong>B did not work, and F was not a loss.</strong> B-grade wallets hit 55% and turn negative once their best performer is removed. F-grade wallets finished slightly positive in aggregate. An F means the record gives no reason to expect it to repeat; it does not mean the wallet loses money.</p>
  <p>One test period, thirty A-grade wallets, two months. Prices are recomputed from settled outcomes and public order history throughout. This is evidence, not a guarantee, and none of it is financial advice.</p>
</section>

<footer>
  <span>Full ratings on the <a href="/">report page</a> · <a href="/check/">check a wallet</a> · <a href="/api/">API</a></span>
  <span>Walk-forward run ${RESULT.run_date}</span>
</footer>

</div>
</body>
</html>`;

mkdirSync(`${ROOT}/site/public/evidence`, { recursive: true });
writeFileSync(`${ROOT}/site/public/evidence/index.html`, head + body);
console.log('Built site/public/evidence/index.html');
