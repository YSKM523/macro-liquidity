import { CHAMPION_MODEL_CONFIG } from './config';

export const CHAMPION_MODEL_VERSION = CHAMPION_MODEL_CONFIG.modelVersion;
export const LOCAL_COMMIT_SENTINEL = 'LOCAL_UNCONFIGURED';

export interface ModelIdentity {
  modelVersion: string;
  configHash: string;
  codeCommitSha: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

export function canonicalChampionConfig(config: unknown = CHAMPION_MODEL_CONFIG): string {
  return JSON.stringify(canonicalize(config));
}

export function validateCommitSha(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase();
  return normalized != null && /^[a-f0-9]{40}$/.test(normalized)
    ? normalized
    : LOCAL_COMMIT_SENTINEL;
}

// Small runtime-independent SHA-256 implementation. Keeping this synchronous
// avoids Node-only imports while producing the same digest in Workers and tests.
export function sha256Hex(value: string): string {
  const bytes = [...new TextEncoder().encode(value)];
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x1_0000_0000);
  const low = bitLength >>> 0;
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((high >>> shift) & 0xff);
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((low >>> shift) & 0xff);

  const k = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ];
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const w = new Array<number>(64);
    for (let index = 0; index < 16; index++) {
      const cursor = offset + index * 4;
      w[index] = ((bytes[cursor] << 24) | (bytes[cursor + 1] << 16)
        | (bytes[cursor + 2] << 8) | bytes[cursor + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index++) {
      const s0 = rotr(w[index - 15], 7) ^ rotr(w[index - 15], 18) ^ (w[index - 15] >>> 3);
      const s1 = rotr(w[index - 2], 17) ^ rotr(w[index - 2], 19) ^ (w[index - 2] >>> 10);
      w[index] = (w[index - 16] + s0 + w[index - 7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,hh] = h;
    for (let index = 0; index < 64; index++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + k[index] + w[index]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      hh=g; g=f; f=e; e=(d+temp1)>>>0; d=c; c=b; b=a; a=(temp1+temp2)>>>0;
    }
    h[0]=(h[0]+a)>>>0; h[1]=(h[1]+b)>>>0; h[2]=(h[2]+c)>>>0; h[3]=(h[3]+d)>>>0;
    h[4]=(h[4]+e)>>>0; h[5]=(h[5]+f)>>>0; h[6]=(h[6]+g)>>>0; h[7]=(h[7]+hh)>>>0;
  }
  return h.map(word => word.toString(16).padStart(8, '0')).join('');
}

export function hashChampionConfig(config: unknown): string {
  return sha256Hex(canonicalChampionConfig(config));
}

export function championConfigDigest(): string {
  return hashChampionConfig(CHAMPION_MODEL_CONFIG);
}

export async function resolveModelIdentity(env: { CODE_COMMIT_SHA?: string }): Promise<ModelIdentity> {
  return {
    modelVersion: CHAMPION_MODEL_VERSION,
    configHash: championConfigDigest(),
    codeCommitSha: validateCommitSha(env.CODE_COMMIT_SHA),
  };
}

export function presentModelDescriptor(identity: ModelIdentity) {
  return {
    ...identity,
    descriptor: JSON.parse(canonicalChampionConfig()) as Record<string, unknown>,
  };
}
