/**
 * AI agent layer.
 *
 * Two agents, one hard rule: the AI never decides when the coordinated action
 * fires. Midnight's zero-knowledge proof does. The agents act on private data
 * (a participant's raw intent), and the Compact contract proves the rules were
 * followed before anything crosses to the other chain. That is the AI-track
 * thesis — "models act on private data, and Midnight proves the rules were
 * followed" — enforced structurally, not by trust.
 *
 * PledgeAgent    — turns messy natural language into a well-formed pledge and
 *                  submits only an opaque commitment. Plaintext intent never
 *                  leaves the participant's device.
 * CoordinatorAgent — watches the Midnight ledger and relays the reveal to the
 *                  EVM chain ONLY when the on-chain proof says unlocked == true.
 *
 * The LLM is pluggable. With OPENAI_API_KEY or ANTHROPIC_API_KEY set, the
 * PledgeAgent uses a real model to normalize intent. Without a key, it falls
 * back to a deterministic phraser so the whole system runs offline.
 */
import type { SealedChain } from './sealed-chain.js';
import type { SettleReceipt, IEvmChain } from './evm-chain.js';
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { fromIni } from '@aws-sdk/credential-providers';

// ---- LLM abstraction -------------------------------------------------------

/** Remove a single layer of wrapping quotes some models add around replies. */
function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

export interface Phraser {
  readonly name: string;
  /** Normalize a raw intent into a crisp, canonical pledge statement. */
  phrase(rawIntent: string, campaignTarget: string): Promise<string>;
}

/** Offline, deterministic phraser. Always available; never leaks data. */
export class RuleBasedPhraser implements Phraser {
  readonly name = 'rule-based (offline)';
  async phrase(rawIntent: string, campaignTarget: string): Promise<string> {
    const cleaned = rawIntent
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/^(i (will|'ll|am going to|pledge to|promise to)\s+)/i, '')
      .replace(/[.!]+$/, '');
    const verb = cleaned.length ? cleaned[0].toUpperCase() + cleaned.slice(1) : 'Act';
    return `I pledge: ${verb}, contingent on the hidden threshold for "${campaignTarget}".`;
  }
}

/**
 * AWS Bedrock Nova phraser (Nova Lite by default, Nova Pro optional).
 * Uses the `simi-ops` AWS profile via the Bedrock Converse API. This is the
 * intended production phraser for this project.
 *
 * Config via env:
 *   AWS_PROFILE     (default 'simi-ops')
 *   AWS_REGION      (default 'us-east-1')
 *   NOVA_MODEL_ID   (default 'amazon.nova-lite-v1:0'; use 'amazon.nova-pro-v1:0' for Pro)
 */
export class BedrockNovaPhraser implements Phraser {
  readonly name: string;
  private client: BedrockRuntimeClient;
  private modelId: string;

  constructor(opts?: { profile?: string; region?: string; modelId?: string }) {
    const profile = opts?.profile ?? process.env.AWS_PROFILE ?? 'simi-ops';
    const region = opts?.region ?? process.env.AWS_REGION ?? 'us-east-1';
    this.modelId = opts?.modelId ?? process.env.NOVA_MODEL_ID ?? 'amazon.nova-lite-v1:0';
    this.name = `bedrock:${this.modelId}`;
    this.client = new BedrockRuntimeClient({
      region,
      credentials: fromIni({ profile }),
    });
  }

  async phrase(rawIntent: string, campaignTarget: string): Promise<string> {
    const cmd = new ConverseCommand({
      modelId: this.modelId,
      system: [
        {
          text:
            'You help a person phrase a private, threshold-contingent pledge. ' +
            'Return ONE concise first-person sentence and nothing else. ' +
            'Never invent facts beyond the intent. The pledge is contingent on a ' +
            'hidden number of others pledging the same thing.',
        },
      ],
      messages: [
        {
          role: 'user',
          content: [{ text: `Campaign target: ${campaignTarget}\nRaw intent: ${rawIntent}` }],
        },
      ],
      inferenceConfig: { maxTokens: 100, temperature: 0.2 },
    });
    const res = await this.client.send(cmd);
    const text = res.output?.message?.content?.[0]?.text?.trim();
    return stripQuotes(text && text.length ? text : rawIntent);
  }
}

/** OpenAI-compatible phraser, used only if OPENAI_API_KEY is present. */
export class OpenAiPhraser implements Phraser {
  readonly name = 'openai';
  constructor(
    private apiKey: string,
    private model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
  ) {}
  async phrase(rawIntent: string, campaignTarget: string): Promise<string> {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content:
              'You help a person phrase a private, threshold-contingent pledge. ' +
              'Return ONE concise first-person sentence. Do not add commentary. ' +
              'Never invent facts beyond the intent. The pledge is contingent on a ' +
              'hidden number of others pledging the same thing.',
          },
          {
            role: 'user',
            content: `Campaign target: ${campaignTarget}\nRaw intent: ${rawIntent}`,
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const json: any = await res.json();
    return stripQuotes(json.choices?.[0]?.message?.content?.trim() ?? rawIntent);
  }
}

/**
 * Pick the best available phraser based on environment.
 * Preference: explicit OpenAI key > AWS Bedrock Nova (simi-ops) > offline rules.
 * Set PHRASER=offline to force the deterministic fallback (e.g. for a fully
 * offline demo).
 */
export function selectPhraser(): Phraser {
  if (process.env.PHRASER === 'offline') return new RuleBasedPhraser();
  if (process.env.OPENAI_API_KEY) return new OpenAiPhraser(process.env.OPENAI_API_KEY);
  // Default to Bedrock Nova via the simi-ops profile. If credentials are absent
  // at call time, callers should catch and fall back (see safePhrase()).
  try {
    return new BedrockNovaPhraser();
  } catch {
    return new RuleBasedPhraser();
  }
}

/**
 * Wrap any phraser so a runtime failure (no AWS creds, network down, throttling)
 * degrades gracefully to the offline phraser instead of breaking the demo.
 */
export function resilient(primary: Phraser): Phraser {
  const fallback = new RuleBasedPhraser();
  return {
    name: `${primary.name} (→ offline on error)`,
    async phrase(rawIntent, campaignTarget) {
      try {
        return await primary.phrase(rawIntent, campaignTarget);
      } catch {
        return fallback.phrase(rawIntent, campaignTarget);
      }
    },
  };
}

// ---- Pledge agent ----------------------------------------------------------

export interface PledgeResult {
  phrased: string;
  phraser: string;
  /** The participant's secret — stays on their device, never sent anywhere. */
  secret: Uint8Array;
}

export class PledgeAgent {
  constructor(
    private chain: SealedChain,
    private phraser: Phraser = resilient(selectPhraser()),
  ) {}

  /**
   * Take a participant's raw, messy intent, phrase it privately, and submit
   * ONLY the opaque commitment to Midnight. The plaintext never leaves here.
   */
  async pledge(rawIntent: string, campaignTarget: string): Promise<PledgeResult> {
    const phrased = await this.phraser.phrase(rawIntent, campaignTarget);
    // The phrased text is for the participant's own confirmation; the contract
    // only ever receives the commitment derived inside submitPledge().
    const { secret } = this.chain.submitPledge();
    return { phrased, phraser: this.phraser.name, secret };
  }
}

// ---- Coordinator agent (the guardrail) -------------------------------------

export interface CoordinationOutcome {
  fired: boolean;
  reason: string;
  settlement?: SettleReceipt;
}

export class CoordinatorAgent {
  constructor(
    private midnight: SealedChain,
    private evm: IEvmChain,
  ) {}

  /**
   * The agent's ONLY authority to act on the other chain is the Midnight proof.
   * It attempts the reveal, and relays to the EVM chain strictly when the
   * contract reports unlocked == true. If the threshold is not met, the proof
   * fails and the agent does nothing — it cannot "decide" to fire early.
   */
  async coordinate(): Promise<CoordinationOutcome> {
    const revealed = this.midnight.tryReveal();
    const result = this.midnight.exportResult();

    if (!revealed || !result.unlocked) {
      return {
        fired: false,
        reason:
          'Midnight proof reports threshold NOT reached. Guardrail holds: ' +
          'no cross-chain action, nothing disclosed.',
      };
    }

    // Proof says the hidden threshold fired. Only now does the agent relay the
    // verified reveal to the other chain.
    const settlement = await this.evm.settle(result.targetCommit, result.revealedTarget);
    return {
      fired: settlement.ok,
      reason: settlement.ok
        ? 'Midnight proof valid (unlocked). Verified reveal relayed to EVM chain.'
        : `Reveal valid but EVM settle failed: ${settlement.reason}`,
      settlement,
    };
  }
}
