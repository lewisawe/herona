/**
 * Thin HTTP backend for the Sealed Collective Action UI.
 *
 * It wraps the exact same modules the CLI demo uses — SealedChain (real Compact
 * circuits), EvmChain (real in-process EVM), and the AI agents — behind a small
 * REST surface. No business logic lives here; it only holds one in-memory
 * session and exposes create / pledge / coordinate / state.
 *
 * Run:
 *   AWS_PROFILE=simi-ops AWS_REGION=us-east-1 npm run ui   # real Bedrock Nova
 *   PHRASER=offline npm run ui                             # fully offline
 */
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

// Minimal .env loader (no dependency). Loads KEY=VALUE lines from ./.env into
// process.env if not already set. Used for EVM_RPC_URL / EVM_DEPLOYER_KEY.
(function loadDotEnv() {
  const envPath = join(process.cwd(), '.env');
  if (!existsSync(envPath)) return;
  for (const raw of readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
})();

import { SealedChain } from './sealed-chain.js';
import { EvmChain, type IEvmChain } from './evm-chain.js';
import {
  PledgeAgent,
  CoordinatorAgent,
  resilient,
  selectPhraser,
  type Phraser,
} from './agent.js';
import { pledgeCommitment, targetToBytes32, toHex } from './crypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);

interface PledgeRecord {
  index: number;
  phrased: string;
  commitment: string; // opaque, shown in the observer panel
}

interface Session {
  midnight: SealedChain;
  evm: IEvmChain;
  pledgeAgent: PledgeAgent;
  coordinator: CoordinatorAgent;
  target: string; // held server-side only, like a campaign creator's device
  pledges: PledgeRecord[];
  phraserName: string;
  settlement: { gasUsed: string | null; eventName: string | null; txHash: string | null } | null;
}

let session: Session | null = null;
const phraser: Phraser = resilient(selectPhraser());

function requireSession(): Session {
  if (!session) throw new Error('no active campaign');
  return session;
}

/** Build the public "on-chain observer" view + EVM status. */
async function snapshot(s: Session) {
  const v = s.midnight.view();
  const exported = s.midnight.exportResult();
  const evmUnlocked = v.initialized ? await s.evm.isUnlocked(exported.targetCommit) : false;
  return {
    initialized: v.initialized,
    unlocked: v.unlocked,
    pledgeCount: v.pledgeCount,
    targetCommit: v.targetCommit,
    thresholdCommit: v.thresholdCommit,
    revealedTarget: v.revealedTarget,
    // Only meaningful once unlocked; before that it's the zero hash.
    revealedTargetText: v.unlocked ? s.target : null,
    evmUnlocked,
    evmAddress: s.evm.address,
    relayer: s.evm.relayer,
    evmNetwork: s.evm.network,
    phraser: s.phraserName,
    // opaque commitments accumulating on the ledger (the "silence" visual)
    commitments: s.pledges.map((p) => p.commitment),
    pledges: s.pledges.map((p) => ({ index: p.index, phrased: p.phrased, commitment: p.commitment })),
    // populated once settled, so a page reload still shows the EVM result
    settlementEvent: s.settlement?.eventName ?? null,
    settlementGas: s.settlement?.gasUsed ?? null,
    settlementTx: s.settlement?.txHash ?? null,
    settlementExplorer:
      s.settlement?.txHash && s.evm.explorerBase
        ? `${s.evm.explorerBase}/tx/${s.settlement.txHash}`
        : null,
  };
}

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, '..', 'public')));

// Clean routes for the role pages.
app.get('/pledge', (_req, res) => res.sendFile(join(__dirname, '..', 'public', 'pledge.html')));
app.get('/coordinator', (_req, res) => res.sendFile(join(__dirname, '..', 'public', 'coordinator.html')));

// Create a campaign with a hidden threshold.
app.post('/api/campaign', async (req, res) => {
  try {
    const target = String(req.body?.target ?? '').trim();
    const threshold = BigInt(req.body?.threshold ?? 0);
    if (!target) return res.status(400).json({ error: 'target required' });
    if (threshold <= 0n) return res.status(400).json({ error: 'threshold must be > 0' });

    const midnight = new SealedChain(threshold);
    midnight.createCampaign(target);
    const evm = await EvmChain.create();

    session = {
      midnight,
      evm,
      pledgeAgent: new PledgeAgent(midnight, phraser),
      coordinator: new CoordinatorAgent(midnight, evm),
      target,
      pledges: [],
      phraserName: phraser.name,
      settlement: null,
    };
    res.json(await snapshot(session));
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// Submit a pledge from a plain-language intent.
app.post('/api/pledge', async (req, res) => {
  try {
    const s = requireSession();
    const rawIntent = String(req.body?.rawIntent ?? '').trim();
    if (!rawIntent) return res.status(400).json({ error: 'rawIntent required' });

    const result = await s.pledgeAgent.pledge(rawIntent, s.target);
    // Derive the opaque commitment for display (same scheme the contract uses).
    const commitment = toHex(pledgeCommitment(result.secret, targetToBytes32(s.target)));
    s.pledges.push({ index: s.pledges.length + 1, phrased: result.phrased, commitment });

    res.json({ phrased: result.phrased, phraser: result.phraser, snapshot: await snapshot(s) });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

// Attempt the coordinated reveal + cross-chain settlement (guardrail applies).
app.post('/api/coordinate', async (req, res) => {
  try {
    const s = requireSession();
    const outcome = await s.coordinator.coordinate();
    if (outcome.fired && outcome.settlement) {
      s.settlement = {
        gasUsed: outcome.settlement.gasUsed?.toString() ?? null,
        eventName: outcome.settlement.event ? 'CollectiveActionUnlocked' : null,
        txHash: outcome.settlement.txHash ?? null,
      };
    }
    res.json({
      fired: outcome.fired,
      reason: outcome.reason,
      settlement: outcome.settlement
        ? {
            ok: outcome.settlement.ok,
            gasUsed: outcome.settlement.gasUsed?.toString(),
            event: outcome.settlement.event
              ? {
                  targetCommit: outcome.settlement.event.targetCommit,
                  revealedTarget: outcome.settlement.event.revealedTarget,
                  settledAt: outcome.settlement.event.settledAt?.toString(),
                }
              : null,
          }
        : null,
      snapshot: await snapshot(s),
    });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

// Current public observer view.
app.get('/api/state', async (_req, res) => {
  try {
    if (!session) return res.json({ initialized: false });
    res.json(await snapshot(session));
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// Reset the session (start a fresh demo).
app.post('/api/reset', (_req, res) => {
  session = null;
  res.json({ ok: true });
});

app.listen(PORT, () => {
  const evmMode = process.env.EVM_RPC_URL && process.env.EVM_DEPLOYER_KEY
    ? `LIVE testnet (${process.env.EVM_NETWORK_LABEL ?? 'Sepolia'})`
    : 'local (in-process EVM)';
  console.log(`\n  Sealed Collective Action UI → http://localhost:${PORT}`);
  console.log(`  Pledge agent: ${phraser.name}`);
  console.log(`  EVM settlement: ${evmMode}\n`);
});
