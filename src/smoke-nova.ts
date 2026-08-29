/** Smoke test: real AWS Bedrock Nova phraser via the simi-ops profile. */
import { BedrockNovaPhraser, resilient } from './agent.js';

const phraser = resilient(new BedrockNovaPhraser());
console.log('phraser:', phraser.name);

const out = await phraser.phrase(
  "i'll report Dana too but only if i'm not the only one",
  'Report manager Dana Reeves for wage theft',
);
console.log('phrased:', out);
console.log('\nNOVA SMOKE TEST DONE');
