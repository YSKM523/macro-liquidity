# Champion–Challenger Registry

| Model | Role | Evidence | Decision | Replacement eligible |
|---|---|---|---|---:|
| `champion-v1.0.0` | Champion | PIT official snapshots + event-time backtest | ACTIVE, unchanged | Yes |
| PR-11 continuous net liquidity | Shadow research | Current-vintage retrospective pseudo-OOS | `INCONCLUSIVE / DROP_RESEARCH` | No |
| PR-12 dynamic reserve adequacy | Shadow research | Current-vintage retrospective pseudo-OOS | `DROP_RESEARCH` | No |
| PR-17 liquidity structure | Shadow diagnostic | Governed PIT event-time only; typed incomplete without an approved policy ledger and complete governed cohort | `SHADOW_ONLY / NO_PROMOTION_THRESHOLD` | No |

Promotion requires preregistration before data access, immutable source artifacts, point-in-time availability, no lookahead, positive majority fixed OOS folds, non-overlapping IC that does not materially degrade, and improved beta-matched return/risk or tails. An independent task/spec review and whole-branch review must both be Ready. Promotion also requires an explicit production authorization; research code cannot self-promote.

Model changes must create a new `model_version` and canonical `config_hash`. Never reuse a version after changing any scoring, freshness, decision, stress, portfolio, or event-backtest assumption.
