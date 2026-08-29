/**
 * EvmChain — the "other chain" leg of the cross-chain flow.
 *
 * Runs a REAL EVM in-process (@ethereumjs/vm) executing REAL compiled Solidity
 * bytecode. Midnight produces the verified reveal; a relayer submits it here and
 * the CollectiveActionSettler contract records the coordinated action publicly
 * and emits an event. No Docker, no external node — deterministic and offline,
 * which is what a reliable demo needs. Swapping this for a public testnet is an
 * RPC/signer change, not a logic change.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import solc from 'solc';
import { createVM, runTx, VM } from '@ethereumjs/vm';
import { Common, Mainnet, Hardfork } from '@ethereumjs/common';
import { createLegacyTx } from '@ethereumjs/tx';
import {
  createAddressFromString,
  createAccount,
  Address,
  hexToBytes,
  bytesToHex,
  privateToAddress,
} from '@ethereumjs/util';
import { Interface } from 'ethers';
import type { Hex } from './crypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Deterministic demo relayer key (well-known test key; never use for real funds).
const RELAYER_PRIV = hexToBytes(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
const RELAYER_ADDR = new Address(privateToAddress(RELAYER_PRIV));

interface CompiledContract {
  abi: any[];
  bytecode: string; // 0x-prefixed
}

function compileSettler(): CompiledContract {
  const source = readFileSync(
    join(__dirname, '..', 'evm', 'CollectiveActionSettler.sol'),
    'utf8',
  );
  const input = {
    language: 'Solidity',
    sources: { 'CollectiveActionSettler.sol': { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  if (out.errors) {
    const fatal = out.errors.filter((e: any) => e.severity === 'error');
    if (fatal.length) throw new Error('solc: ' + fatal.map((e: any) => e.formattedMessage).join('\n'));
  }
  const c = out.contracts['CollectiveActionSettler.sol']['CollectiveActionSettler'];
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

export interface SettleReceipt {
  ok: boolean;
  reason?: string;
  gasUsed: bigint;
  event?: { targetCommit: Hex; revealedTarget: Hex; settledAt: bigint };
}

export class EvmChain {
  private vm!: VM;
  private iface: Interface;
  private bytecode: string;
  private contractAddress!: Address;

  readonly relayer = bytesToHex(RELAYER_ADDR.bytes) as Hex;

  private async nextNonce(): Promise<bigint> {
    const acct = await this.vm.stateManager.getAccount(RELAYER_ADDR);
    return acct?.nonce ?? 0n;
  }

  private constructor(compiled: CompiledContract) {
    this.iface = new Interface(compiled.abi);
    this.bytecode = compiled.bytecode;
  }

  static async create(): Promise<EvmChain> {
    const self = new EvmChain(compileSettler());
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Shanghai });
    self.vm = await createVM({ common });

    // Fund the relayer account.
    const acct = createAccount({ nonce: 0n, balance: 10n ** 20n });
    await self.vm.stateManager.putAccount(RELAYER_ADDR, acct);

    await self.deploy();
    return self;
  }

  /** Deploy CollectiveActionSettler(relayer = RELAYER_ADDR). */
  private async deploy(): Promise<void> {
    const encodedArgs = this.iface.encodeDeploy([this.relayer]);
    const data = hexToBytes((this.bytecode + encodedArgs.slice(2)) as `0x${string}`);
    const tx = createLegacyTx({
      nonce: await this.nextNonce(),
      gasLimit: 5_000_000n,
      gasPrice: 10n,
      data,
    }).sign(RELAYER_PRIV);

    const res = await runTx(this.vm, { tx });
    if (res.execResult.exceptionError) {
      throw new Error('deploy failed: ' + JSON.stringify(res.execResult.exceptionError));
    }
    this.contractAddress = res.createdAddress!;
  }

  /** Relay a verified Midnight reveal to the settler. */
  async settle(targetCommit: Hex, revealedTarget: Hex): Promise<SettleReceipt> {
    const data = hexToBytes(
      this.iface.encodeFunctionData('settle', [targetCommit, revealedTarget]) as `0x${string}`,
    );
    const tx = createLegacyTx({
      nonce: await this.nextNonce(),
      to: this.contractAddress,
      gasLimit: 1_000_000n,
      gasPrice: 10n,
      data,
    }).sign(RELAYER_PRIV);

    const res = await runTx(this.vm, { tx });
    const gasUsed = res.totalGasSpent;

    if (res.execResult.exceptionError) {
      // Decode revert reason if present.
      let reason = String(res.execResult.exceptionError.error ?? res.execResult.exceptionError);
      const rv = res.execResult.returnValue;
      if (rv && rv.length >= 4) {
        try {
          const parsed = this.iface.parseError(bytesToHex(rv));
          if (parsed) reason = parsed.name;
        } catch { /* not a known custom error */ }
      }
      return { ok: false, reason, gasUsed };
    }

    // Decode the emitted event.
    let event: SettleReceipt['event'];
    for (const log of res.execResult.logs ?? []) {
      const [addr, topics, logData] = log;
      try {
        const parsed = this.iface.parseLog({
          topics: (topics as Uint8Array[]).map((t) => bytesToHex(t)),
          data: bytesToHex(logData as Uint8Array),
        });
        if (parsed?.name === 'CollectiveActionUnlocked') {
          event = {
            targetCommit: parsed.args[0] as Hex,
            revealedTarget: parsed.args[1] as Hex,
            settledAt: parsed.args[2] as bigint,
          };
        }
      } catch { /* ignore unrelated logs */ }
    }

    return { ok: true, gasUsed, event };
  }

  /** Read isUnlocked(targetCommit) from the settler. */
  async isUnlocked(targetCommit: Hex): Promise<boolean> {
    const data = hexToBytes(
      this.iface.encodeFunctionData('isUnlocked', [targetCommit]) as `0x${string}`,
    );
    const res = await this.vm.evm.runCall({
      to: this.contractAddress,
      caller: RELAYER_ADDR,
      origin: RELAYER_ADDR,
      data,
      gasLimit: 200_000n,
    });
    const [unlocked] = this.iface.decodeFunctionResult('isUnlocked', bytesToHex(res.execResult.returnValue));
    return Boolean(unlocked);
  }

  get address(): Hex {
    return bytesToHex(this.contractAddress.bytes) as Hex;
  }
}
