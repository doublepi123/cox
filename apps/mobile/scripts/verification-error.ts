export class MobilePackageVerificationError extends Error {
  readonly failures: readonly string[];

  constructor(failures: readonly string[]) {
    super(`mobile package verification failed:\n  - ${failures.join("\n  - ")}`);
    this.name = "MobilePackageVerificationError";
    this.failures = failures;
  }
}
