# Sealed Collective Action

**Midnight Hackathon (August 2026) · Cross-Chain Track + AI Track**

A commitment tool where people privately pledge to act *contingent on others*. Each pledge unlocks only when a **hidden threshold** of matching pledges is reached, and **nothing leaks before the trigger**: not the count, not the identities, not the target. When the threshold fires, Midnight's zero-knowledge proof lets another chain act on the verified result.

## The problem

Collective action has a first-mover problem. The first person to report a manager, sign a union card, or commit to a boycott takes all the risk and gets none of the safety of numbers. Any coordinator who holds everyone's early pledges can peek, leak, or be subpoenaed. That kills the movement before it reaches critical mass.

A normal server cannot fix this: whoever runs it can read the pledges. The privacy is load-bearing. Remove it and the first mover is exposed.

## Why Midnight

The core guarantee is: **before the threshold is reached, the system reveals nothing actionable.** Only when `>= N` distinct pledges exist against the same target does the coordinated moment unlock. That requires zero-knowledge proofs over private state plus a trustless ledger, which is exactly what Midnight's Compact contracts provide.

## How it works

```
                     PRIVATE (Midnight)                    VERIFIED RESULT        PUBLIC (EVM chain)
  person  ─raw intent─▶  AI Pledge Agent ─commitment─▶  Compact contract  ──────▶  AI Coordinator ─▶ CollectiveActionSettler
 (device)               (Nova / offline)   (opaque)     · hidden threshold          (guardrail)        · records action
                                                         · distinct pledges          only relays        · emits event
   secret stays local ─────────────────────────────────  · ZK reveal proof          when unlocked       CollectiveActionUnlocked
```

1. **Pledge (private).** A person states intent in plain language. An AI agent phrases it into a clean contingent pledge and submits only an **opaque commitment** to Midnight. The plaintext and the pledger's secret never leave the device.
2. **Accumulate (silent).** The Compact contract stores opaque commitments and a **commitment to the hidden threshold**. Before the threshold, the ledger shows only hashes and `unlocked = false`.
3. **Reveal (in zero-knowledge).** `tryReveal` proves, inside the circuit, that the number of distinct pledges has reached the hidden threshold and that the disclosed target matches its on-chain commitment. Only then does it flip `unlocked` and disclose the target.
4. **Settle cross-chain.** An AI coordinator relays the verified reveal to an EVM contract, which records the coordinated action publicly and emits an event. The AI never decides *when* to act; the ZK proof does. That is the AI-track thesis: models act on private data, and Midnight proves the rules were followed.

## Quick start

Requires Node 20+ (tested on Node 22). The compiled Compact artifacts are committed, so you do **not** need the Compact compiler to run the demo.

```bash
npm install
```

### Option A — Web UI (recommended)

```bash
# With the AWS Bedrock Nova pledge agent (uses the `simi-ops` profile):
AWS_PROFILE=simi-ops AWS_REGION=us-east-1 npm run ui

# Or fully offline (deterministic, no AWS/network):
PHRASER=offline npm run ui
```

Open **http://localhost:8787**. The UI is split by role, matching how this works in the real world:

| Route | Role | What it shows |
|-------|------|---------------|
| `/` | **Organizer** | Create a campaign (target + hidden threshold) and watch the live on-chain observer panel |
| `/pledge` | **Participant** | Add a private pledge in plain language — isolated: cannot see the count, the target, or how close the campaign is |
| `/coordinator` | **Coordinator** | The AI guardrail + the cross-chain settlement panel (Midnight ledger vs EVM chain, side by side) |

Create a campaign, submit pledges in plain language (the AI phrases each one), and watch the **On-chain observer** panel: opaque hashes accumulate while `unlocked` stays `false`. The pledge that crosses the hidden threshold flips it to **UNLOCKED**, reveals the target, and settles cross-chain.

### Live cross-chain settlement on a public testnet (optional)

By default the EVM settlement leg runs on an in-process EVM (offline, deterministic). To settle on **real Ethereum Sepolia** instead — a transaction anyone can open on Etherscan — copy `.env.example` to `.env` and fill in:

```bash
cp .env.example .env
# then set:
#   EVM_RPC_URL=https://sepolia.infura.io/v3/<your-project-id>
#   EVM_DEPLOYER_KEY=0x<a funded throwaway Sepolia key>
npm run ui   # logs: "EVM settlement: LIVE testnet (Sepolia)"
```

In live mode, creating a campaign deploys the settler to Sepolia and each coordinated reveal is a real `settle()` transaction; the coordinator page shows the tx hash as a clickable Etherscan link. The **Midnight side stays local** (real ZK circuits); only the EVM leg goes on-chain.

**Proof it works — a real settlement from a live run:**
[`0xe96df598c1ca13dfc8053186b7953a0cfa328928111cb78aff1804757c65235a`](https://sepolia.etherscan.io/tx/0xe96df598c1ca13dfc8053186b7953a0cfa328928111cb78aff1804757c65235a) (Sepolia, block 11592444, emitted `CollectiveActionUnlocked`).

### Option B — Terminal demo

```bash
PHRASER=offline npm run demo
AWS_PROFILE=simi-ops AWS_REGION=us-east-1 npm run demo
```

Same story, narrated in the terminal with an "on-chain observer" box after each pledge.

### The one thing to watch

Below the threshold, every `tryReveal` **fails inside the proof** and the coordinator holds: no cross-chain action, nothing disclosed. The pledge that crosses the hidden threshold flips `unlocked` and settles on the EVM chain. That's the demo.

## Tests

```bash
PHRASER=offline npx tsx src/smoke.ts        # Midnight contract flow + distinctness
PHRASER=offline npx tsx src/smoke-evm.ts    # EVM settler: settle, dup-revert, empty-revert
PHRASER=offline npx tsx src/smoke-agent.ts  # agent guardrail: hold below threshold, fire at threshold
npm run typecheck
```

## Layout

| Path | What |
|------|------|
| `contract/src/sealed.compact` | The Compact contract: private pledges, hidden threshold, ZK reveal |
| `contract/src/managed/sealed/` | Compiled artifacts (bindings, prover/verifier keys, ZK IR) — committed |
| `evm/CollectiveActionSettler.sol` | The "other chain" contract that acts on the verified reveal |
| `src/crypto.ts` | Client-side commitments, matching the contract's hashing exactly |
| `src/sealed-chain.ts` | Drives the Compact circuits locally via `@midnight-ntwrk/compact-runtime` |
| `src/evm-chain.ts` | The EVM settler: in-process EVM by default, or live Sepolia via ethers when configured |
| `src/agent.ts` | AI pledge agent (Bedrock Nova / offline) + coordinator guardrail |
| `src/server.ts` | Thin Express backend wrapping the modules above for the web UI |
| `public/` | The role-based web UI: `index.html` (organizer), `pledge.html`, `coordinator.html`, shared `styles.css` + `shared.js` (vanilla, no build step) |
| `src/demo.ts` | The end-to-end terminal demo |

## Privacy boundary (honest scope)

**Hidden before reveal:** each pledger's identity and intent, the campaign target, the threshold number, and how close the campaign is to firing.

**On the public ledger:** opaque per-pledge commitments and nullifiers, a salted commitment to the target, a salted commitment to the threshold, and `unlocked`. The target and threshold are salted commitments, so an observer cannot learn what the campaign is about or how many pledges unlock it, and therefore cannot infer closeness. The distinct-pledge count is only consulted **inside** the `tryReveal` proof at the moment of reveal. Nullifiers enforce one distinct pledge per participant.

## Cross-chain trust model

For the hackathon, a relayer submits the Midnight reveal to the EVM `settle` function, which binds each settlement to the Midnight `targetCommit` (so a settlement is permanently tied to the exact campaign committed on Midnight). In production the relayer is replaced by an on-chain verifier / light client that checks the Midnight proof directly; the interface is intentionally that shape.

The EVM leg runs on an in-process EVM (`@ethereumjs/vm`) for a deterministic, offline demo, and can settle on a **real public testnet (Ethereum Sepolia)** when `EVM_RPC_URL` and `EVM_DEPLOYER_KEY` are set (see Quick start). Moving between them is a provider/signer change, not a logic change: the `SealedChain` and `EvmChain` classes are the seams. The Midnight side runs its real ZK circuits locally in both modes.

## Build the contract yourself (optional)

Only needed if you want to recompile. Requires the Compact toolchain (`compact` CLI).

```bash
npm run build:contract   # compact compile contract/src/sealed.compact contract/src/managed/sealed
```

Version note: the committed artifacts target `@midnight-ntwrk/compact-runtime@0.16.0` (emitted by Compact compiler 0.31.1). `package.json` pins that runtime so the bindings and runtime agree.

## Use cases (same primitive)

Whistleblower coordination · union card drives / strike pledges · boycotts ("I'll switch banks if 10k others do") · any threshold-gated collective commitment.
