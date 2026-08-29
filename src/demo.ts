/**
 * Sealed Collective Action — end-to-end demo.
 *
 * The 90-second story:
 *   1. A campaign is created with a HIDDEN threshold on Midnight.
 *   2. People pledge privately. An on-chain observer sees only opaque hashes:
 *      no target, no identities, no count-vs-threshold, no "how close".
 *   3. Below the threshold, the AI coordinator's guardrail HOLDS — the Midnight
 *      proof refuses to reveal, so nothing crosses to the other chain.
 *   4. The pledge that crosses the hidden threshold flips the Midnight proof to
 *      valid. Only THEN does the AI relay the verified reveal to an EVM chain,
 *      which settles the coordinated action publicly.
 *
 * Run:
 *   AWS_PROFILE=simi-ops AWS_REGION=us-east-1 npm run demo
 *   PHRASER=offline npm run demo      # fully offline, no AWS needed
 */
import { SealedChain } from './sealed-chain.js';
import { EvmChain } from './evm-chain.js';
import { PledgeAgent, CoordinatorAgent, resilient, selectPhraser } from './agent.js';

// ---- tiny presentation helpers --------------------------------------------
const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};
const line = () => console.log(c.dim('─'.repeat(72)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PACE = Number(process.env.DEMO_PACE_MS ?? 700);

function observerView(midnight: SealedChain) {
  // Exactly what a chain snoop can read from the public ledger.
  const v = midnight.view();
  console.log(c.dim('   ┌─ what an on-chain observer sees ─────────────────────────'));
  console.log(c.dim('   │ initialized   : ') + v.initialized);
  console.log(c.dim('   │ unlocked      : ') + (v.unlocked ? c.green(String(v.unlocked)) : c.red(String(v.unlocked))));
  console.log(c.dim('   │ opaque pledges: ') + v.pledgeCount + c.dim('  (hashes only — no intent, no identity)'));
  console.log(c.dim('   │ targetCommit  : ') + c.dim(v.targetCommit.slice(0, 22) + '…'));
  console.log(c.dim('   │ thresholdCommit: ') + c.dim(v.thresholdCommit.slice(0, 22) + '…') + c.dim('  (the number itself is hidden)'));
  console.log(c.dim('   │ revealedTarget: ') + c.dim(v.revealedTarget.slice(0, 22) + '…'));
  console.log(c.dim('   └──────────────────────────────────────────────────────────'));
}

async function main() {
  const HIDDEN_THRESHOLD = 4n;
  const TARGET = 'Report regional manager Dana Reeves for systematic wage theft';

  const RAW_INTENTS = [
    "i'll report Dana too, but only if i'm not the first one out there alone",
    'i want to file a complaint about the unpaid overtime but i am scared to go first',
    'count me in on reporting the same manager for the wage stuff',
    'yes i will submit my statement about Dana if enough of us do it together',
  ];

  console.log();
  console.log(c.bold('  SEALED COLLECTIVE ACTION'));
  console.log(c.dim('  Threshold-gated private pledges · Midnight ZK core · cross-chain settlement · AI coordinator'));
  console.log();

  line();
  console.log(c.bold(' 1. Create the campaign on Midnight'));
  console.log('    A hidden threshold of ' + c.yellow('N (secret)') + ' pledges is required to unlock.');
  console.log('    The target and the threshold number are committed, not published.');
  const midnight = new SealedChain(HIDDEN_THRESHOLD);
  midnight.createCampaign(TARGET);
  const evm = await EvmChain.create();
  console.log(c.dim(`    EVM settler deployed at ${evm.address}`));
  observerView(midnight);
  await sleep(PACE);

  const phraser = resilient(selectPhraser());
  const pledgeAgent = new PledgeAgent(midnight, phraser);
  const coordinator = new CoordinatorAgent(midnight, evm);
  console.log(c.dim(`    AI pledge assistant: ${phraser.name}`));
  await sleep(PACE);

  line();
  console.log(c.bold(' 2. People pledge privately — watch the silence'));
  console.log('    Each person speaks plainly. The AI phrases the pledge; only an');
  console.log('    ' + c.bold('opaque commitment') + ' reaches the chain. Plaintext never leaves the device.');
  console.log();

  for (let i = 0; i < RAW_INTENTS.length; i++) {
    const n = i + 1;
    console.log(c.cyan(`  Pledge ${n}`));
    console.log('    person says : ' + c.dim(`"${RAW_INTENTS[i]}"`));
    const r = await pledgeAgent.pledge(RAW_INTENTS[i], TARGET);
    console.log('    AI phrases  : ' + `"${r.phrased}"`);
    console.log('    on-chain    : ' + c.dim('submitted commitment ') + c.dim('0x' + Buffer.from(r.secret).toString('hex').slice(0, 12) + '…(secret stays local)'));

    // The coordinator ATTEMPTS to reveal after every pledge. Its only authority
    // is the Midnight proof. Below threshold, the proof refuses.
    const outcome = await coordinator.coordinate();
    if (outcome.fired) {
      console.log('    coordinator : ' + c.green('THRESHOLD REACHED — Midnight proof valid.'));
      observerView(midnight);
      line();
      console.log(c.bold(' 3. Cross-chain settlement (the coordinated moment)'));
      const ev = outcome.settlement?.event;
      console.log('    ' + c.green('✔') + ' AI relayed the verified reveal to the EVM chain.');
      console.log('    ' + c.dim('EVM event CollectiveActionUnlocked:'));
      console.log('      targetCommit  : ' + c.dim((ev?.targetCommit ?? '').slice(0, 30) + '…'));
      console.log('      revealedTarget: ' + c.dim((ev?.revealedTarget ?? '').slice(0, 30) + '…'));
      console.log('      gasUsed       : ' + outcome.settlement?.gasUsed);
      const unlocked = await evm.isUnlocked(midnight.exportResult().targetCommit);
      console.log('    EVM isUnlocked(): ' + (unlocked ? c.green('true') : c.red('false')));
      console.log();
      console.log('    ' + c.bold('The revealed target: ') + c.yellow(`"${TARGET}"`));
      break;
    } else {
      console.log('    coordinator : ' + c.red('held.') + ' ' + c.dim(outcome.reason));
      observerView(midnight);
    }
    console.log();
    await sleep(PACE);
  }

  line();
  console.log(c.bold(' Recap'));
  console.log('  • Before the hidden threshold: the chain revealed ' + c.bold('nothing') + ' actionable —');
  console.log('    no target, no identities, no count-vs-threshold. No first-mover risk.');
  console.log('  • The AI ' + c.bold('never') + ' decided to act. The Midnight ZK proof did; the AI only');
  console.log('    relayed a result the contract had already proven valid.');
  console.log('  • Midnight held the private logic; the EVM chain acted on the verified result.');
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
