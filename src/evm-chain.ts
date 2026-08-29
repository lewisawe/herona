/**
 * EvmChain — the "other chain" leg of the cross-chain flow.
 *
 * Two interchangeable implementations behind one interface:
 *   • LocalEvmChain — runs a REAL EVM in-process (@ethereumjs/vm) executing REAL
 *     compiled Solidity bytecode. Deterministic, offline, zero setup. Default.
 *   • LiveEvmChain — deploys the SAME contract to a public EVM testnet (Sepolia)
 *     via ethers and settles with real transactions you can open on Etherscan.
 *     Enabled when EVM_RPC_URL and EVM_DEPLOYER_KEY are set.
 *
 * Midnight produces the verified reveal; a relayer submits it here and the
 * CollectiveActionSettler records the coordinated action publicly and emits an
 * event. Swapping local → live is a provider/signer change, not a logic change.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import solc from 'solc';
import { createVM, runTx, VM } from '@ethereumjs/vm';
import { Common, Mainnet, Hardfork } from '@ethereumjs/common';
import { createLegacyTx } from '@ethereumjs/tx';
import {
  createAccount,
  Address,
  hexToBytes,
  bytesToHex,
  privateToAddress,
} from '@ethereumjs/util';
import { Interface, JsonRpcProvider, Wallet, ContractFactory, Contract } from 'ethers';
import type { Hex } from './crypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Deterministic demo relayer key for the LOCAL VM only (well-known test key;
// never holds real funds).
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
  /** Present for live (testnet) settlements. */
  txHash?: Hex;
}

/** The common surface both implementations expose to the app. */
export interface IEvmChain {
  readonly relayer: Hex;
  readonly address: Hex;
  readonly network: string;           // human label, e.g. "local (in-process EVM)" or "Sepolia"
  readonly explorerBase: string | null; // e.g. "https://sepolia.etherscan.io" or null
  settle(targetCommit: Hex, revealedTarget: Hex): Promise<SettleReceipt>;
  isUnlocked(targetCommit: Hex): Promise<boolean>;
}

// ============================================================================
// LOCAL — in-process @ethereumjs/vm (default, offline, deterministic)
// ============================================================================
export class LocalEvmChain implements IEvmChain {
  private vm!: VM;
  private iface: Interface;
  private bytecode: string;
  private contractAddress!: Address;

  readonly relayer = bytesToHex(RELAYER_ADDR.bytes) as Hex;
  readonly network = 'local (in-process EVM)';
  readonly explorerBase = null;

  private constructor(compiled: CompiledContract) {
    this.iface = new Interface(compiled.abi);
    this.bytecode = compiled.bytecode;
  }

  private async nextNonce(): Promise<bigint> {
    const acct = await this.vm.stateManager.getAccount(RELAYER_ADDR);
    return acct?.nonce ?? 0n;
  }

  static async create(): Promise<LocalEvmChain> {
    const self = new LocalEvmChain(compileSettler());
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Shanghai });
    self.vm = await createVM({ common });
    const acct = createAccount({ nonce: 0n, balance: 10n ** 20n });
    await self.vm.stateManager.putAccount(RELAYER_ADDR, acct);
    await self.deploy();
    return self;
  }

  private async deploy(): Promise<void> {
    const encodedArgs = this.iface.encodeDeploy([this.relayer]);
    const data = hexToBytes((this.bytecode + encodedArgs.slice(2)) as `0x${string}`);
    const tx = createLegacyTx({
      nonce: await this.nextNonce(), gasLimit: 5_000_000n, gasPrice: 10n, data,
    }).sign(RELAYER_PRIV);
    const res = await runTx(this.vm, { tx });
    if (res.execResult.exceptionError) {
      throw new Error('deploy failed: ' + JSON.stringify(res.execResult.exceptionError));
    }
    this.contractAddress = res.createdAddress!;
  }

  async settle(targetCommit: Hex, revealedTarget: Hex): Promise<SettleReceipt> {
    const data = hexToBytes(
      this.iface.encodeFunctionData('settle', [targetCommit, revealedTarget]) as `0x${string}`,
    );
    const tx = createLegacyTx({
      nonce: await this.nextNonce(), to: this.contractAddress,
      gasLimit: 1_000_000n, gasPrice: 10n, data,
    }).sign(RELAYER_PRIV);
    const res = await runTx(this.vm, { tx });
    const gasUsed = res.totalGasSpent;

    if (res.execResult.exceptionError) {
      let reason = String(res.execResult.exceptionError.error ?? res.execResult.exceptionError);
      const rv = res.execResult.returnValue;
      if (rv && rv.length >= 4) {
        try { const p = this.iface.parseError(bytesToHex(rv)); if (p) reason = p.name; } catch { /* */ }
      }
      return { ok: false, reason, gasUsed };
    }

    let event: SettleReceipt['event'];
    for (const log of res.execResult.logs ?? []) {
      const [, topics, logData] = log;
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
      } catch { /* */ }
    }
    return { ok: true, gasUsed, event };
  }

  async isUnlocked(targetCommit: Hex): Promise<boolean> {
    const data = hexToBytes(
      this.iface.encodeFunctionData('isUnlocked', [targetCommit]) as `0x${string}`,
    );
    const res = await this.vm.evm.runCall({
      to: this.contractAddress, caller: RELAYER_ADDR, origin: RELAYER_ADDR, data, gasLimit: 200_000n,
    });
    const [unlocked] = this.iface.decodeFunctionResult('isUnlocked', bytesToHex(res.execResult.returnValue));
    return Boolean(unlocked);
  }

  get address(): Hex { return bytesToHex(this.contractAddress.bytes) as Hex; }
}

// ============================================================================
// LIVE — public EVM testnet (Sepolia) via ethers
// ============================================================================
export interface LiveEvmConfig {
  rpcUrl: string;
  deployerKey: string;
  networkLabel?: string;   // default "Sepolia"
  explorerBase?: string;   // default "https://sepolia.etherscan.io"
}

export class LiveEvmChain implements IEvmChain {
  private contract!: Contract;
  private iface: Interface;
  readonly relayer: Hex;
  readonly network: string;
  readonly explorerBase: string;
  private _address: Hex = '0x' as Hex;

  private constructor(
    private wallet: Wallet,
    private compiled: CompiledContract,
    cfg: LiveEvmConfig,
  ) {
    this.iface = new Interface(compiled.abi);
    this.relayer = wallet.address as Hex;
    this.network = cfg.networkLabel ?? 'Sepolia';
    this.explorerBase = cfg.explorerBase ?? 'https://sepolia.etherscan.io';
  }

  static async create(cfg: LiveEvmConfig): Promise<LiveEvmChain> {
    const provider = new JsonRpcProvider(cfg.rpcUrl);
    const wallet = new Wallet(cfg.deployerKey, provider);
    const compiled = compileSettler();
    const self = new LiveEvmChain(wallet, compiled, cfg);

    // Deploy the settler with the relayer = deployer address.
    const factory = new ContractFactory(compiled.abi, compiled.bytecode, wallet);
    const deployed = await factory.deploy(wallet.address);
    await deployed.waitForDeployment();
    self._address = (await deployed.getAddress()) as Hex;
    self.contract = new Contract(self._address, compiled.abi, wallet);
    return self;
  }

  async settle(targetCommit: Hex, revealedTarget: Hex): Promise<SettleReceipt> {
    try {
      const tx = await this.contract.settle(targetCommit, revealedTarget);
      const receipt = await tx.wait();
      let event: SettleReceipt['event'];
      for (const log of receipt.logs ?? []) {
        try {
          const parsed = this.iface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed?.name === 'CollectiveActionUnlocked') {
            event = {
              targetCommit: parsed.args[0] as Hex,
              revealedTarget: parsed.args[1] as Hex,
              settledAt: parsed.args[2] as bigint,
            };
          }
        } catch { /* */ }
      }
      return { ok: true, gasUsed: receipt.gasUsed as bigint, event, txHash: receipt.hash as Hex };
    } catch (e: any) {
      // ethers surfaces custom errors on e.revert?.name in v6, or in the message.
      const reason = e?.revert?.name ?? e?.shortMessage ?? String(e?.message ?? e);
      return { ok: false, reason, gasUsed: 0n, txHash: e?.receipt?.hash as Hex };
    }
  }

  async isUnlocked(targetCommit: Hex): Promise<boolean> {
    return Boolean(await this.contract.isUnlocked(targetCommit));
  }

  get address(): Hex { return this._address; }
}

// ============================================================================
// Factory — pick live if configured, else local.
// ============================================================================
export async function createEvmChain(): Promise<IEvmChain> {
  const rpcUrl = process.env.EVM_RPC_URL;
  const deployerKey = process.env.EVM_DEPLOYER_KEY;
  if (rpcUrl && deployerKey) {
    return LiveEvmChain.create({
      rpcUrl,
      deployerKey,
      networkLabel: process.env.EVM_NETWORK_LABEL,
      explorerBase: process.env.EVM_EXPLORER_BASE,
    });
  }
  return LocalEvmChain.create();
}

/** Back-compat alias so existing imports (EvmChain.create()) keep working. */
export const EvmChain = { create: createEvmChain };
