/** Smoke test for the EVM cross-chain leg in isolation. */
import { EvmChain } from './evm-chain.js';

const tc = '0x' + '11'.repeat(32) as `0x${string}`;
const rt = '0x' + '22'.repeat(32) as `0x${string}`;
const zero = '0x' + '00'.repeat(32) as `0x${string}`;

const evm = await EvmChain.create();
console.log('settler deployed at', evm.address);
console.log('relayer', evm.relayer);

console.log('isUnlocked before:', await evm.isUnlocked(tc), '(expected false)');

const r1 = await evm.settle(tc, rt);
console.log('settle #1:', JSON.stringify(r1, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
if (!r1.ok || !r1.event) throw new Error('FAIL: settle did not succeed/emit');

console.log('isUnlocked after:', await evm.isUnlocked(tc), '(expected true)');

const r2 = await evm.settle(tc, rt);
console.log('settle #2 (dup):', r2.ok, r2.reason, '(expected AlreadySettled)');
if (r2.ok) throw new Error('FAIL: duplicate settle should revert');

const r3 = await evm.settle('0x' + '33'.repeat(32) as `0x${string}`, zero);
console.log('settle empty reveal:', r3.ok, r3.reason, '(expected EmptyReveal)');
if (r3.ok) throw new Error('FAIL: empty reveal should revert');

console.log('\nEVM SMOKE TEST PASSED');
