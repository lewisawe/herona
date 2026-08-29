/** Smoke test for the AI agent layer + guardrail behaviour. */
import { SealedChain } from './sealed-chain.js';
import { EvmChain } from './evm-chain.js';
import { PledgeAgent, CoordinatorAgent, resilient, selectPhraser } from './agent.js';

const THRESHOLD = 3n;
const TARGET = 'Report manager Dana Reeves for wage theft';

const midnight = new SealedChain(THRESHOLD);
midnight.createCampaign(TARGET);
const evm = await EvmChain.create();

const pledgeAgent = new PledgeAgent(midnight, resilient(selectPhraser()));
const coordinator = new CoordinatorAgent(midnight, evm);

const rawIntents = [
  "i'll report Dana too but only if i'm not the only one",
  'I am going to file a complaint about the wage theft.',
  'count me in, reporting the same manager',
];

for (let i = 0; i < rawIntents.length; i++) {
  const r = await pledgeAgent.pledge(rawIntents[i], TARGET);
  console.log(`\npledge ${i + 1} via ${r.phraser}:`);
  console.log('  phrased:', r.phrased);
  console.log('  ledger:', JSON.stringify(midnight.view()));

  const outcome = await coordinator.coordinate();
  console.log('  coordinator:', outcome.fired ? 'FIRED' : 'held', '-', outcome.reason);

  if (i < Number(THRESHOLD) - 1 && outcome.fired) {
    throw new Error(`FAIL: coordinator fired early at pledge ${i + 1}`);
  }
  if (i === Number(THRESHOLD) - 1) {
    if (!outcome.fired) throw new Error('FAIL: coordinator did not fire at threshold');
    console.log('  EVM event:', JSON.stringify(outcome.settlement?.event, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v));
    console.log('  EVM isUnlocked:', await evm.isUnlocked(midnight.exportResult().targetCommit));
  }
}

console.log('\nAGENT SMOKE TEST PASSED');
