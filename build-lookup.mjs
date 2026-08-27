// Build the public wallet-lookup page (site/public/check/).
// Client-side only: it fetches the static per-wallet JSON the grade API already
// publishes, so there is no server, no query cost, and the page is exactly as
// fresh as the last regrade. Run after build-api.mjs.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { nav } from './site-nav.mjs';

const ROOT = process.env.REPO_DIR || `${process.env.HOME}/OzScan/Ozscan`;
const head = readFileSync(`${ROOT}/site/head.tmpl.html`, 'utf8');
const today = new Date().toISOString().slice(0, 10);

const body = `
<body>
<div class="wrap">

${nav('/check/')}

<header class="masthead">
  <div class="eyebrow">Assay Score · Wallet check</div>
  <h1>Is this wallet worth following?</h1>
  <p class="standfirst">Paste a Polymarket wallet address. You get the grade and the reasons behind it, computed from settled outcomes — not from what the wallet says about itself.</p>
</header>

<section>
  <div class="lookup">
    <input id="addr" type="text" spellcheck="false" autocomplete="off"
           placeholder="0x… wallet address" aria-label="Wallet address">
    <button id="go">Check</button>
  </div>
  <p class="sec-note" id="hint">Tip: on Polymarket, a trader's address is in their profile URL.</p>
  <div id="out"></div>
</section>

<section class="prose">
  <h2>What the grade means</h2>
  <p>A grade answers one question: could a follower actually have captured what this wallet did? Profit alone does not answer it — the most profitable wallets on Polymarket are usually the least copyable, because their edge is execution speed a human cannot match.</p>
  <p><strong>A</strong> clean on every check · <strong>B</strong> minor flag · <strong>C</strong> marginal, no demonstrated edge · <strong>D</strong> profitable but compromised · <strong>F</strong> not copyable, whatever the profit.</p>
  <p>Wallets with fewer than 50 settled bets or fewer than 20 distinct markets are not graded at all — two wins out of two is not a track record. If a wallet comes back ungraded, that is the finding.</p>
  <p>A grade is not a verdict on a trader's skill. It is a statement about whether their edge transfers to someone watching from outside. Not financial advice.</p>
</section>

<footer>
  <span>Method and full ratings on the <a href="/">report page</a> · API at <a href="/api/">/api</a></span>
  <span>Data through ${today}</span>
</footer>

</div>

<style>
.lookup{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.lookup input{
  flex:1 1 380px;padding:13px 14px;font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:14px;
  background:var(--surface-2);color:var(--ink);border:1px solid var(--rule);border-radius:2px
}
.lookup input:focus{outline:2px solid var(--ink-3);outline-offset:-1px}
.lookup button{
  padding:13px 26px;font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:13px;font-weight:600;
  letter-spacing:.08em;text-transform:uppercase;cursor:pointer;
  background:var(--ink);color:var(--paper);border:1px solid var(--ink);border-radius:2px
}
.lookup button:hover{opacity:.88}
.result{border:1px solid var(--rule);background:var(--surface);margin-top:24px}
.result-head{display:flex;align-items:center;gap:18px;padding:20px 22px;border-bottom:1px solid var(--rule);flex-wrap:wrap}
.result-head .stamp{font-size:30px;width:56px;height:56px;display:flex;align-items:center;justify-content:center;border-radius:2px;font-weight:700;color:#fff}
.rg-a{background:var(--pass)}.rg-b{background:#4C7F6B}.rg-c{background:#7E7A52}.rg-d{background:var(--caution)}.rg-f{background:var(--fail)}
.result-head .who{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:13px;color:var(--ink-3);word-break:break-all}
.result-head .verdict{font-size:19px;font-weight:600;margin-top:3px}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));border-bottom:1px solid var(--rule)}
.metrics div{padding:15px 22px;border-right:1px solid var(--rule-soft)}
.metrics dt{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:10px;letter-spacing:.13em;text-transform:uppercase;color:var(--ink-3);margin-bottom:5px}
.metrics dd{margin:0;font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:17px;font-variant-numeric:tabular-nums}
.reasons{padding:18px 22px}
.reasons h4{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:10px;letter-spacing:.13em;text-transform:uppercase;color:var(--ink-3);margin:0 0 10px}
.reasons li{margin-bottom:7px;color:var(--ink-2);font-size:14.5px}
.pos{color:var(--pass)}.neg{color:var(--fail)}
.notice{border:1px solid var(--rule);background:var(--surface);padding:20px 22px;margin-top:24px}
.notice strong{display:block;font-size:17px;margin-bottom:7px}
</style>

<script>
(function(){
  const FLAG = {
    'bot-pace': 'Trades at machine pace — a human follower cannot replicate the entries.',
    'weighting-flip': 'Staked-weighted and equal-weighted returns disagree in sign: the record rests on a few large bets, not a repeatable process.',
    'single-bet-driven': 'A single position produced most of the profit.',
    'negative-clv': 'Price moved against the position over the hour after our detection.',
    'favorite-heavy': 'Lives on heavy favorites, so the win rate is high by construction.',
    'thin-sample': 'Sample is thin — treat the record as provisional.',
    'dormant': 'No meaningful activity recently; the record is historical.'
  };
  const VERDICT = {
    A: 'Followable, on this record.',
    B: 'Followable with one caveat.',
    C: 'No demonstrated edge either way.',
    D: 'Profitable, but the record is compromised.',
    F: 'Not followable, whatever the profit.'
  };
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const money = (v) => { const n=Number(v), s=n<0?'-':'', x=Math.abs(n);
    return x>=1e6 ? s+'$'+(x/1e6).toFixed(2)+'M' : x>=1e3 ? s+'$'+(x/1e3).toFixed(0)+'K' : s+'$'+x.toFixed(0); };
  const pct = (v) => (Number(v)>=0?'+':'')+Number(v).toFixed(1)+'%';

  function render(w){
    const g = w.grade, gl = g.toLowerCase();
    const reasons = (w.flags && w.flags.length)
      ? w.flags.map(f => '<li>'+esc(FLAG[f] || f)+'</li>').join('')
      : '<li>No flags raised on any check.</li>';
    $('out').innerHTML =
      '<div class="result">'+
        '<div class="result-head">'+
          '<span class="stamp rg-'+gl+'">'+g+'</span>'+
          '<div><div class="who">'+esc(w.address)+'</div>'+
          '<div class="verdict">'+VERDICT[g]+'</div></div>'+
        '</div>'+
        '<dl class="metrics">'+
          '<div><dt>Settled bets</dt><dd>'+Number(w.resolved_bets).toLocaleString()+'</dd></div>'+
          '<div><dt>Markets</dt><dd>'+Number(w.resolved_markets).toLocaleString()+'</dd></div>'+
          '<div><dt>Win rate</dt><dd>'+Number(w.win_pct).toFixed(1)+'%</dd></div>'+
          '<div><dt>ROI staked</dt><dd class="'+(w.roi_staked_pct>0?'pos':'neg')+'">'+pct(w.roi_staked_pct)+'</dd></div>'+
          '<div><dt>ROI equal</dt><dd class="'+(w.roi_equal_pct>0?'pos':'neg')+'">'+pct(w.roi_equal_pct)+'</dd></div>'+
          '<div><dt>Net P&amp;L</dt><dd class="'+(w.pnl_usd>0?'pos':'neg')+'">'+money(w.pnl_usd)+'</dd></div>'+
          '<div><dt>Fills / active day</dt><dd>'+Number(w.bets_per_active_day).toFixed(0)+'</dd></div>'+
          '<div><dt>Top bet share of P&amp;L</dt><dd>'+Number(w.top1_pnl_share_pct).toFixed(1)+'%</dd></div>'+
        '</dl>'+
        '<div class="reasons"><h4>Why</h4><ul>'+reasons+'</ul></div>'+
      '</div>';
  }

  function notGraded(addr){
    $('out').innerHTML =
      '<div class="notice"><strong>Not graded.</strong>'+
      '<p>We have no settled record for <code>'+esc(addr)+'</code> that clears the floor — 50 settled bets across 20 distinct markets since April 2.</p>'+
      '<p>That is itself an answer: whatever this wallet shows elsewhere, there is not enough settled history here to call it followable. Wallets whose profit is older than our window land here too.</p></div>';
  }

  async function check(){
    const raw = $('addr').value.trim().toLowerCase();
    if(!/^0x[0-9a-f]{40}$/.test(raw)){
      $('out').innerHTML = '<div class="notice"><strong>That does not look like a wallet address.</strong>'+
        '<p>It should start with 0x and have 40 hex characters after it.</p></div>';
      return;
    }
    $('out').innerHTML = '<div class="notice">Checking…</div>';
    try{
      const res = await fetch('/api/v0/wallet/'+raw+'.json', {cache:'no-store'});
      if(res.status === 404){ notGraded(raw); return; }
      if(!res.ok) throw new Error('http '+res.status);
      render(await res.json());
      history.replaceState(null,'','?a='+raw);
    }catch(e){
      $('out').innerHTML = '<div class="notice"><strong>Could not reach the grade data.</strong><p>Try again in a moment.</p></div>';
    }
  }

  $('go').addEventListener('click', check);
  $('addr').addEventListener('keydown', (e)=>{ if(e.key==='Enter') check(); });
  const q = new URLSearchParams(location.search).get('a');
  if(q){ $('addr').value = q; check(); }
})();
</script>
</body>
</html>`;

mkdirSync(`${ROOT}/site/public/check`, { recursive: true });
writeFileSync(`${ROOT}/site/public/check/index.html`, head + body);
console.log('Built site/public/check/index.html');
