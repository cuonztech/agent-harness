export type LicenseTier = "trial" | "single_audit" | "pro" | "agency" | "enterprise";

export interface LicenseClaims {
  sub: string;
  tier: LicenseTier;
  exp: number;
  iss?: string;
  eml?: string;
  customer?: string;
}

export interface LicenseVerdict {
  valid: boolean;
  claims?: LicenseClaims;
  tier?: LicenseTier;
  reason?: string;
  isEvaluation?: boolean;
}
