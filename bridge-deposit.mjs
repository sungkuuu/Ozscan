// Asks the Polymarket bridge for the deposit addresses that fund a trading
// wallet, and prints them. Read-only: nothing is signed or moved.
//
// The docs are unclear on whether the bridge accepts a plain EOA (which is how
// the live-test executor trades) or only a Polymarket account wallet. Calling
// it with the address answers that before any money is sent. Polymarket
// blocks the office IP, so run it on a runner:
//   gh workflow run data-job.yml -f script=bridge-deposit.mjs -f version=<0xaddress>
// (the workflow's VERSION input is reused to carry the address.)

const address = process.env.DEPOSIT_ADDRESS || process.env.VERSION;
if (!/^0x[0-9a-fA-F]{40}$/.test(address || '')) {
  console.error('need DEPOSIT_ADDRESS (0x…40 hex) — pass it as the workflow "version" input');
  process.exit(1);
}

const headers = { 'content-type': 'application/json' };
if (process.env.POLYMARKET_BUILDER_CODE) headers['X-Builder-Code'] = process.env.POLYMARKET_BUILDER_CODE;

const assets = await fetch('https://bridge.polymarket.com/supported-assets', { signal: AbortSignal.timeout(20_000) });
console.log(`supported-assets: HTTP ${assets.status}`);
if (assets.ok) {
  const body = await assets.json();
  const list = Array.isArray(body) ? body : body.assets || body.data || body;
  console.log(JSON.stringify(list, null, 0).slice(0, 1500));
}

const res = await fetch('https://bridge.polymarket.com/deposit', {
  method: 'POST', headers, body: JSON.stringify({ address }),
  signal: AbortSignal.timeout(20_000),
});
console.log(`deposit: HTTP ${res.status}`);
console.log((await res.text()).slice(0, 3000));
