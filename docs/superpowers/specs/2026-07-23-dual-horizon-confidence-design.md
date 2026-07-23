# PR-18 Dual-Horizon Score and Confidence — Design

- Status: proposed for implementation review
- Protocol: `DUAL_HORIZON_CONFIDENCE_SHADOW_V1`
- Plan coverage: ALG-10 and ALG-11
- Date: 2026-07-23

## 1. Objective

Add a read-only Shadow analysis that separates the current 13-week strategic signal from a 4-week tactical signal and reports an auditable 0–100 confidence score. The existing Champion remains the sole source of formal score, verdict, portfolio-policy output, snapshot persistence, and production behavior.

This PR must not change any Champion formula, factor weight, score/verdict threshold, hysteresis rule, stress overlay, formal API meaning, snapshot schema, or database row. It does not promote a challenger and does not deploy anything.

## 2. Frozen decisions

### 2.1 Strategic score

`strategicScore` is the score already persisted on the selected formal Champion snapshot. It is not recomputed by the Shadow endpoint. The strategic base risk budget is the existing formal `DASHBOARD_EXPOSURE_TIERS_V1` result, derived without modification from that snapshot's persisted score, verdict, net-liquidity direction, and frozen snapshot-VIX stress proxy.

This preserves the current 13-week Champion exactly, including its data-quality decisions, verdict hysteresis, and policy mapping.

### 2.2 Tactical score

The tactical score uses the same eight positive-weight Champion factors and the same weights:

| Factor | Weight |
| --- | ---: |
| `netliqTrend` | 0.25 |
| `dollar` | 0.20 |
| `reserveAdequacy` | 0.15 |
| `curve` | 0.10 |
| `credit` | 0.10 |
| `funding` | 0.10 |
| `globalLiquidity` | 0.05 |
| `stablecoin` | 0.05 |

Seven factor scores are copied from the same formal snapshot cohort. Only `netliqTrend` is recalculated, by calling the existing net-liquidity trend scorer with a four-week lookback instead of the Champion's 13-week lookback. The underlying net-liquidity definition, four-week slope term, normalization, component mixing, and score bounds remain unchanged.

The tactical weighted score uses the existing fixed weights and does not fit, optimize, or renormalize them. A Shadow result is `DATA_INCOMPLETE` unless all eight factor scores and the required four-week PIT net-liquidity history are available. This strict cohort rule makes the tactical and strategic values comparable and avoids silently changing the denominator.

### 2.3 Tactical adjustment

The unguarded tactical adjustment is frozen as:

```text
tacticalScore >= 60  -> +0.10
tacticalScore <= 40  -> -0.10
otherwise            ->  0.00
```

The comparison is inclusive at 40 and 60. The adjustment is in absolute exposure percentage points, not a relative multiplier.

## 3. Point-in-time input contract

The endpoint accepts an optional exact ISO `as_of` cutoff and otherwise uses the latest governed formal snapshot. All inputs for one response share that exact cutoff. Only rows recorded, fetched, activated, released, tradable, or overridden strictly before the cutoff are eligible, matching the repository's existing formal event-time convention. Future rows, late backfills, later revisions, and overrides created at or after the cutoff are invisible.

The implementation reuses the governed event-time loaders and append-only PIT tables. For each FRED series it selects only a release/tradability resolution that was visible strictly before the cutoff, following the repository's existing formal eligibility rules. It must not read current-vintage research artifacts.

The Shadow calculation requires:

- the selected governed formal snapshot and its exact factor cohort;
- enough PIT-visible `WALCL`, `WDTGAL`, and `RRPONTSYD` observations to form at least five cadence-valid weekly net-liquidity points for the four-week scorer;
- PIT-visible `WTREGEN` observations for the Smooth agreement calculation;
- enough prior-only history for the frozen Raw/Smooth scale calculation;
- governed official snapshots visible by the cutoff for the regime sample calculation.

Weekly net liquidity uses the current production definition:

```text
WALCL - WDTGAL - RRPONTSYD
```

Points are aligned on eligible WALCL anchors using the existing PIT alignment and cadence validation. No interpolation from a future observation is permitted.

The Raw/Smooth agreement component reuses the PR-11 frozen formulas, but reconstructs them from governed PIT observations at the requested cutoff:

```text
Raw    = WALCL - WDTGAL - RRPONTSYD
Smooth = WALCL - weekly_mean(WTREGEN) - last_5_mean(RRPONTSYD)
```

The 13-week gap, 4-week impulse, 13-week impulse, prior-only rolling MAD scale (maximum 156 and minimum 52 prior observations), latent weights `0.45 / 0.35 / 0.20`, and logistic transform remain frozen. This runtime PIT reconstruction is an operational confidence diagnostic; it does not revise or promote the PR-11 research conclusion.

## 4. Confidence score

Confidence is the equal-weight mean of five 0–100 components. Each component is returned separately with its evidence counts and reason. The aggregate is emitted only when all five components are finite.

### 4.1 Data completeness — 20%

```text
100 * available_positive_weight_factor_count / 8
```

The count comes from the exact formal factor cohort. Because the tactical score requires 8/8 factors, a successful result has 100 completeness; incomplete responses still expose the diagnostic value.

### 4.2 Data freshness — 20%

Each of the eight factors receives its persisted status from the selected formal snapshot's `factor_quality_json`:

```text
OK       -> 100
PARTIAL  ->  50
STALE    ->   0
MISSING  ->   0
```

Freshness is their unweighted arithmetic mean. This reports observation quality without changing the score weights or formal quality policy.

### 4.3 Current-regime sample size — 20%

Count governed formal snapshots in the same exact `qe_qt_regime` as the selected snapshot, using only snapshots and regime evidence visible by `as_of`. Exclude the selected snapshot, legacy migration-backfill rows, provisional nowcasts, and rows outside the selected governed revision cohort.

```text
min(100, sampleCount / 52 * 100)
```

The 52-observation cap represents one year of weekly formal observations. This component measures evidence quantity only, not predictive quality.

### 4.4 Major-factor agreement — 20%

The frozen major-factor set is:

```text
netliqTrend, dollar, reserveAdequacy, curve
```

Each score is classified as `UP` above 55, `DOWN` below 45, and `NEUTRAL` otherwise. The component is:

```text
100 * max(up + 0.5 * neutral, down + 0.5 * neutral) / 4
```

Thus four factors in one direction score 100, a two-versus-two split scores 50, and four neutral factors score 50. Existing score thresholds are not changed; these cutoffs classify agreement only.

### 4.5 Raw/Smooth direction agreement — 20%

Direction is the sign of the reconstructed frozen PR-11 latent value:

```text
same non-zero sign -> 100 (HIGH agreement)
opposite sign      ->   0 (LOW agreement)
either value flat  ->  50 (TRANSITION)
```

If either series cannot be reconstructed without lookahead, the component is unavailable and the whole Shadow result is `DATA_INCOMPLETE`; missing key PIT data is never treated as neutral confidence.

### 4.6 Aggregate

```text
confidence = mean(
  completeness,
  freshness,
  regimeSample,
  majorFactorAgreement,
  rawSmoothAgreement
)
```

All public numeric values are rounded only for presentation. Policy comparisons use unrounded values.

## 5. Shadow exposure guardrails

The existing formal portfolio mapper is applied to the selected snapshot's persisted score, verdict, net-liquidity direction, and snapshot VIX proxy; its unchanged result is `baseExposure`. No current live overlay is replayed or modified by this analysis.

Apply the following in order:

1. derive the tactical adjustment from the frozen 40/60 boundaries;
2. if `confidence < 60` and the adjustment is positive, replace it with zero;
3. add the guarded adjustment to `baseExposure` and clamp to the existing `[0.25, 1.00]` policy range;
4. if `confidence < 40`, cap the Shadow exposure at `0.75`.

Exactly 60 allows a positive tactical adjustment. Exactly 40 triggers the low-confidence cap only when the unrounded confidence is below 40, not equal to 40.

These values are labeled `shadowTargetExposure` and `shadowAdjustment`. They must not be consumed as a formal recommendation or written to a snapshot.

## 6. Result shape and reasons

The internal calculation returns a discriminated result:

```ts
type DualHorizonShadowResult =
  | {
      status: "OK";
      protocol: "DUAL_HORIZON_CONFIDENCE_SHADOW_V1";
      asOf: string;
      snapshotDate: string;
      modelVersion: string;
      configHash: string;
      strategicScore: number;
      tacticalScore: number;
      confidence: number;
      confidenceComponents: {
        completeness: number;
        freshness: number;
        regimeSample: number;
        majorFactorAgreement: number;
        rawSmoothAgreement: number;
      };
      baseExposure: number;
      shadowAdjustment: number;
      shadowTargetExposure: number;
      reasons: string[];
      championChanged: false;
    }
  | {
      status: "DATA_INCOMPLETE";
      protocol: "DUAL_HORIZON_CONFIDENCE_SHADOW_V1";
      asOf: string;
      reasons: string[];
      availableDiagnostics: Record<string, unknown>;
      championChanged: false;
    };
```

Reasons use deterministic codes plus compact evidence, including:

- `TACTICAL_UP`, `TACTICAL_NEUTRAL`, or `TACTICAL_DOWN`;
- `UPWARD_ADJUSTMENT_BLOCKED_LOW_CONFIDENCE`;
- `LOW_CONFIDENCE_EXPOSURE_CAP`;
- `RAW_SMOOTH_HIGH`, `RAW_SMOOTH_LOW`, or `RAW_SMOOTH_TRANSITION`;
- `MISSING_FORMAL_FACTOR_COHORT`, `MISSING_TACTICAL_HISTORY`, `MISSING_RAW_SMOOTH_HISTORY`, or `MISSING_REGIME_EVIDENCE`.

No reason string may imply that the Shadow result is the formal verdict.

## 7. Delivery surface

Add one read-only v1 endpoint:

```text
GET /api/v1/challengers/dual-horizon?as_of=<exact ISO timestamp>
```

It follows existing v1 envelope, validation, version/provenance, cache, and typed error conventions. It performs no database writes. A compact dashboard card may consume the endpoint and must visibly label the result `Shadow`, show Strategic, Tactical, Confidence, and the guarded Shadow exposure, and preserve the existing Champion card unchanged.

No migration is planned. If implementation reveals that a migration is necessary, work stops for a separate design decision rather than expanding this PR silently.

## 8. Failure behavior

Return typed `DATA_INCOMPLETE`, never a guessed score or exposure, when any of these holds:

- no governed formal snapshot exists at the cutoff;
- the exact eight-factor cohort is unavailable or malformed;
- key PIT liquidity series are absent, stale under existing cadence rules, or insufficient;
- prior-only Raw/Smooth scale history is insufficient;
- current-regime evidence cannot be resolved without violating the cutoff;
- persisted timestamps, score values, exposure, protocol identity, or revision provenance are invalid;
- query limits are exceeded.

Malformed `as_of` remains a typed request error. Repository/database failures remain typed service errors and must not be converted into low confidence.

## 9. Test and verification contract

Implementation follows test-driven development: add a focused failing test for each behavior before production code.

Required coverage:

1. strategic score is copied byte-for-byte from the selected formal snapshot, and base exposure exactly matches the unchanged formal portfolio mapper for that snapshot;
2. a constructed history where 4-week and 13-week signals diverge changes only tactical `netliqTrend`;
3. all eight weights remain literal and sum to one; no renormalization occurs;
4. tactical boundaries at exactly 40 and 60 are inclusive;
5. confidence components and equal-weight aggregate match hand-calculated fixtures;
6. confidence exactly 60 permits an upward adjustment, while a value below 60 blocks it;
7. confidence exactly 40 does not invoke the 75% cap, while a value below 40 does;
8. Raw/Smooth HIGH, LOW, TRANSITION, and missing-history cases are deterministic;
9. late revisions, backfills, and post-cutoff overrides cannot change an earlier `as_of` result;
10. regime sample counts exclude the current row, provisional/legacy rows, wrong revisions, and rows after the cutoff;
11. missing key inputs fail closed as `DATA_INCOMPLETE`;
12. endpoint schema, validation, cache safety, and UI Shadow labeling are covered;
13. formal Champion snapshot, verdict, score, portfolio-policy output, and existing APIs are unchanged before and after Shadow evaluation.

Final verification must run:

```text
npm test
npx tsc --noEmit
npm run lint
```

Any focused no-lookahead, correctness, or rebuild suites affected by the implementation must also pass. No deployment, remote database command, real alert, or production write is part of verification.

## 10. Scope exclusions and known limitations

- This is Shadow analysis only; there is no promotion gate or automatic position change.
- The 4-week horizon, 40/60 tactical boundaries, equal 20% confidence weights, 52-week regime cap, and 40/60 confidence guardrails are preregistered heuristics, not fitted results.
- Raw/Smooth is reconstructed from governed PIT runtime data; it is a different evidence class from the PR-11 current-vintage artifact and does not rehabilitate that dropped challenger.
- Regime sample confidence measures count, not realized forecast skill.
- The endpoint does not provide unseen out-of-sample evidence. Promotion would require a separately frozen protocol and matured forward outcomes.
- Formal weekly and provisional daily snapshot mixing, if encountered in tests, is recorded as a follow-up issue and is not refactored in this PR.
- Live stress remains an independent overlay and is not reconstructed by this Shadow calculation.
- Multi-asset independent validation remains ALG-12 and is outside PR-18.

## 11. Rollback

PR-18 has no migration and no data writes. Rollback is a normal revert of the PR-18 commit range, which removes the read-only service, endpoint, tests, and Shadow UI card. Existing formal snapshots and all Champion behavior remain intact; no database repair or data deletion is required.
