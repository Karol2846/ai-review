export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly endLine?: number;
  readonly agent: string;
  readonly severity: string;
  readonly category: string;
  readonly message: string;
  readonly suggestion: string;
  readonly fingerprint?: string;
}
