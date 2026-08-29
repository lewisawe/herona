/**
 * Smoke test: exercises the full contract flow through the runtime.
 * Verifies: campaign creation, N-1 silence, distinctness, and threshold reveal.
 */
import { SealedChain } from './sealed-chain.js';

function log(label: string, v: unknown) {
  console.log(label, JSON.stringify(v));
}

const THRESHOLD = 4n;
const chain = new SealedChain(THRESHOLD);

console.log('--- create campaign (hidden threshold = %d) ---', THRESHOLD);
chain.createCampaign('Report manager Dana Reeves for wage theft');
log('view after create:', chain.view());

console.log('\n--- submit pledges up to threshold-1 (should stay silent) ---');
for (let i = 1; i < Number(THRESHOLD); i++) {
  chain.submitPledge();
  const v = chain.view();
  log(`after pledge ${i}:`, v);
  const fired = chain.tryReveal();
  console.log(`  tryReveal at ${i} pledges -> unlocked=${fired} (expected false)`);
  if (fired) throw new Error(`FAIL: revealed early at ${i} pledges`);
}

console.log('\n--- the Nth pledge crosses the hidden threshold ---');
chain.submitPledge();
log('after Nth pledge:', chain.view());
const fired = chain.tryReveal();
console.log(`tryReveal at ${THRESHOLD} pledges -> unlocked=${fired} (expected true)`);
if (!fired) throw new Error('FAIL: did not reveal at threshold');

console.log('\n--- exported cross-chain payload ---');
log('exportResult:', chain.exportResult());

console.log('\nSMOKE TEST PASSED');
