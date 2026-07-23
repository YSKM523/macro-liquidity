import type { DualHorizonIncompleteReason } from './dual-horizon-confidence';

export type DualHorizonRequestErrorCode = 'INVALID_AS_OF';

export class DualHorizonRequestError extends Error {
  readonly code: DualHorizonRequestErrorCode;

  constructor(code: DualHorizonRequestErrorCode) {
    super('dual-horizon request invalid');
    this.name = 'DualHorizonRequestError';
    this.code = code;
  }
}

export class DualHorizonDomainError extends Error {
  readonly reason: DualHorizonIncompleteReason;
  readonly asOf: string;
  readonly availableDiagnostics: Record<string, unknown>;

  constructor(
    reason: DualHorizonIncompleteReason,
    asOf: string,
    availableDiagnostics: Record<string, unknown> = {},
  ) {
    super('dual-horizon governed input unavailable');
    this.name = 'DualHorizonDomainError';
    this.reason = reason;
    this.asOf = asOf;
    this.availableDiagnostics = availableDiagnostics;
  }
}
