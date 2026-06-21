import { WEIGHTS, COVERAGE_FACTORS } from './config';

const W = WEIGHTS as Record<string, number>;

export interface FactorContribution { key: string; factor: number; weight: number; contribution: number }

// 离中性贡献:(factor − 50) × weight;8 个权重>0 因子,Σ = 未封顶分 − 50。按 |贡献| 降序。
export function factorContributions(factors: Record<string, number>): FactorContribution[] {
  return COVERAGE_FACTORS
    .map((key) => {
      const factor = factors[key] ?? 50;
      const weight = W[key] ?? 0;
      return { key, factor, weight, contribution: (factor - 50) * weight };
    })
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
}

export interface FactorAttribution { key: string; deltaFactor: number; weight: number; deltaContribution: number }

// 变化归因:weight × (cur − ref);Σ = 未封顶(curScore − refScore)。按 |拉动| 降序。
export function attributeScoreChange(cur: Record<string, number>, ref: Record<string, number>): FactorAttribution[] {
  return COVERAGE_FACTORS
    .map((key) => {
      const deltaFactor = (cur[key] ?? 50) - (ref[key] ?? 50);
      const weight = W[key] ?? 0;
      return { key, deltaFactor, weight, deltaContribution: weight * deltaFactor };
    })
    .sort((a, b) => Math.abs(b.deltaContribution) - Math.abs(a.deltaContribution));
}

export interface NetliqParts { walcl: number; tga: number; rrp: number; netliq: number }
export interface NetliqDecomp { current: NetliqParts; reference: NetliqParts | null; delta: NetliqParts | null }

function parts(walcl: number, tga: number, rrp: number): NetliqParts {
  return { walcl, tga, rrp, netliq: walcl - tga - rrp };
}

// netliq = walcl − tga − rrp;delta 恒等式 Δnetliq = Δwalcl − Δtga − Δrrp。
export function decomposeNetliq(
  cur: { walcl: number; tga: number; rrp: number },
  ref: { walcl: number; tga: number; rrp: number } | null,
): NetliqDecomp {
  const current = parts(cur.walcl, cur.tga, cur.rrp);
  if (!ref) return { current, reference: null, delta: null };
  const reference = parts(ref.walcl, ref.tga, ref.rrp);
  const delta = {
    walcl: current.walcl - reference.walcl,
    tga: current.tga - reference.tga,
    rrp: current.rrp - reference.rrp,
    netliq: current.netliq - reference.netliq,
  };
  return { current, reference, delta };
}
