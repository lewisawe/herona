import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type Witnesses<PS> = {
  campaignThreshold(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, bigint];
  campaignSalt(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
}

export type ImpureCircuits<PS> = {
  createCampaign(context: __compactRuntime.CircuitContext<PS>,
                 target_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  submitPledge(context: __compactRuntime.CircuitContext<PS>,
               commitment_0: Uint8Array,
               nullifier_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  tryReveal(context: __compactRuntime.CircuitContext<PS>, target_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
}

export type ProvableCircuits<PS> = {
  createCampaign(context: __compactRuntime.CircuitContext<PS>,
                 target_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  submitPledge(context: __compactRuntime.CircuitContext<PS>,
               commitment_0: Uint8Array,
               nullifier_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  tryReveal(context: __compactRuntime.CircuitContext<PS>, target_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
}

export type PureCircuits = {
}

export type Circuits<PS> = {
  createCampaign(context: __compactRuntime.CircuitContext<PS>,
                 target_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  submitPledge(context: __compactRuntime.CircuitContext<PS>,
               commitment_0: Uint8Array,
               nullifier_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  tryReveal(context: __compactRuntime.CircuitContext<PS>, target_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
}

export type Ledger = {
  pledgeCommitments: {
    isEmpty(): boolean;
    size(): bigint;
    member(elem_0: Uint8Array): boolean;
    [Symbol.iterator](): Iterator<Uint8Array>
  };
  nullifierSet: {
    isEmpty(): boolean;
    size(): bigint;
    member(elem_0: Uint8Array): boolean;
    [Symbol.iterator](): Iterator<Uint8Array>
  };
  readonly targetCommit: Uint8Array;
  readonly thresholdCommit: Uint8Array;
  readonly unlocked: boolean;
  readonly revealedTarget: Uint8Array;
  readonly initialized: boolean;
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>): __compactRuntime.ConstructorResult<PS>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
