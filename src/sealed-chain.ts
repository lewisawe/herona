/**
 * SealedChain — a thin driver over the compiled Compact contract, executing its
 * circuits locally through @midnight-ntwrk/compact-runtime.
 *
 * This runs the REAL circuits (createCampaign / submitPledge / tryReveal),
 * maintains the REAL ledger state, and enforces the REAL privacy boundary the
 * Compact compiler generated. It does not require a full node; the runtime
 * executes the same on-chain VM operations locally and produces proof data for
 * each call. Swapping this for a live devnet deployment is a provider change,
 * not a logic change.
 */
import {
  createConstructorContext,
  createCircuitContext as _createCircuitContext,
  sampleContractAddress,
  type CircuitContext,
} from '@midnight-ntwrk/compact-runtime';

// The shipped runtime JS signature is (contractAddress, coinPublicKeyOrZswap,
// contractState, privateState, ...), which differs from the bundled .d.ts.
// Wrap it with the correct runtime signature.
const createCircuitContext = _createCircuitContext as unknown as (
  contractAddress: unknown,
  coinPublicKeyOrZswap: unknown,
  contractState: unknown,
  privateState: unknown,
) => CircuitContext<any>;
import * as Sealed from '../contract/src/managed/sealed/contract/index.js';
import {
  randomBytes32,
  pledgeCommitment,
  nullifier as deriveNullifier,
  targetToBytes32,
  toHex,
  type Hex,
} from './crypto.js';

/** Private state carried by the campaign creator (never disclosed). */
export interface CreatorPrivateState {
  threshold: bigint;
  salt: Uint8Array;
}

/** A public snapshot of what any on-chain observer can see. */
export interface LedgerView {
  initialized: boolean;
  unlocked: boolean;
  /** Count of opaque commitments. Present in ledger, but see privacy notes. */
  pledgeCount: number;
  targetCommit: Hex;
  thresholdCommit: Hex;
  revealedTarget: Hex;
}

export class SealedChain {
  private contract: Sealed.Contract<CreatorPrivateState>;
  private address = sampleContractAddress();
  private ctx: CircuitContext<CreatorPrivateState>;
  private coinPublicKey = '0'.repeat(64); // demo coin public key

  /** Human-readable target, kept only client-side by the creator. */
  private plaintextTarget: string | null = null;

  constructor(threshold: bigint) {
    const privateState: CreatorPrivateState = { threshold, salt: randomBytes32() };

    // Witnesses supply the creator's private threshold and salt on demand.
    this.contract = new Sealed.Contract<CreatorPrivateState>({
      campaignThreshold: (ctx) => [ctx.privateState, ctx.privateState.threshold],
      campaignSalt: (ctx) => [ctx.privateState, ctx.privateState.salt],
    });

    const cc = createConstructorContext(privateState, this.coinPublicKey);
    const res = this.contract.initialState(cc);

    // Build ONE circuit context from the initial contract state, then thread the
    // updated context returned by each circuit call through subsequent calls.
    // Signature matches the shipped runtime: (address, coinPublicKey, chargedState, privateState).
    this.ctx = createCircuitContext(
      this.address,
      res.currentZswapLocalState ?? this.coinPublicKey,
      res.currentContractState.data,
      res.currentPrivateState,
    );
  }

  /** Creator opens the campaign against a human-readable target. */
  createCampaign(target: string): void {
    this.plaintextTarget = target;
    const target32 = targetToBytes32(target);
    const out = this.contract.circuits.createCampaign(this.ctx, target32);
    this.ctx = out.context;
  }

  /**
   * A participant pledges. Their secret stays on their own device; only the
   * opaque commitment + nullifier reach the contract.
   */
  submitPledge(): { secret: Uint8Array } {
    if (this.plaintextTarget === null) throw new Error('no campaign');
    const secret = randomBytes32();
    const target32 = targetToBytes32(this.plaintextTarget);
    const commitment = pledgeCommitment(secret, target32);
    const nul = deriveNullifier(secret);

    const out = this.contract.circuits.submitPledge(this.ctx, commitment, nul);
    this.ctx = out.context;
    return { secret };
  }

  /**
   * Attempt the coordinated reveal. Succeeds only if the number of distinct
   * pledges has reached the hidden threshold. A failed proof (threshold not
   * met / bad binding) leaves state untouched — exactly the on-chain behaviour.
   */
  tryReveal(): boolean {
    if (this.plaintextTarget === null) throw new Error('no campaign');
    const target32 = targetToBytes32(this.plaintextTarget);
    const snapshot = this.ctx;
    try {
      const out = this.contract.circuits.tryReveal(this.ctx, target32);
      this.ctx = out.context;
      return this.view().unlocked;
    } catch {
      this.ctx = snapshot; // roll back; the reveal did not fire
      return false;
    }
  }

  /** What any on-chain observer can read. */
  view(): LedgerView {
    const l = Sealed.ledger(this.ctx.currentQueryContext.state);
    return {
      initialized: l.initialized,
      unlocked: l.unlocked,
      pledgeCount: Number(l.pledgeCommitments.size()),
      targetCommit: toHex(l.targetCommit),
      thresholdCommit: toHex(l.thresholdCommit),
      revealedTarget: toHex(l.revealedTarget),
    };
  }

  /**
   * The verified cross-chain payload, only meaningful once unlocked. This is
   * what gets carried to the EVM leg: the revealed target and the on-chain
   * target commitment. Before unlock, `unlocked` is false and consumers must
   * reject it.
   */
  exportResult(): { unlocked: boolean; revealedTarget: Hex; targetCommit: Hex } {
    const v = this.view();
    return {
      unlocked: v.unlocked,
      revealedTarget: v.revealedTarget,
      targetCommit: v.targetCommit,
    };
  }
}
