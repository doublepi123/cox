import { registerPlugin } from "@capacitor/core";
import { normalizeRemoteOrigin } from "@t3tools/shared/remoteServerAdmission";

export interface SavePasswordOptions {
  readonly profileId: string;
  readonly canonicalOrigin: string;
  readonly password: string;
  readonly requireBiometric: boolean;
}

export interface UnlockOptions {
  readonly profileId: string;
  readonly canonicalOrigin: string;
  readonly allowInsecureHttp: boolean;
  readonly androidProfileName?: string;
}

export interface BiometricVault {
  savePassword(options: SavePasswordOptions): Promise<void>;
  unlockAndAutofillPassword(options: UnlockOptions): Promise<void>;
  deletePassword(profileId: string): Promise<void>;
}

interface NativeVault {
  savePassword(options: SavePasswordOptions): Promise<void>;
  unlockAndAutofillPassword(options: UnlockOptions): Promise<void>;
  deletePassword(options: { readonly profileId: string }): Promise<void>;
}

const vaultErrorMessages = {
  invalid_input: "Invalid vault settings.",
  unavailable: "The credential vault could not complete the operation.",
} as const;

export class VaultError extends Error {
  readonly code: keyof typeof vaultErrorMessages;
  constructor(code: VaultError["code"]) {
    super(vaultErrorMessages[code]);
    this.code = code;
  }
}

const nativeVault = registerPlugin<NativeVault>("CoxVault");

function validateProfileId(profileId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(profileId))
    throw new VaultError("invalid_input");
}

function validateOrigin(origin: string, allowInsecureHttp: boolean): void {
  if (normalizeRemoteOrigin(origin, { allowInsecureHttp }) !== origin)
    throw new VaultError("invalid_input");
}

export const biometricVault: BiometricVault = {
  async savePassword(options) {
    validateProfileId(options.profileId);
    validateOrigin(options.canonicalOrigin, true);
    if (options.password.length === 0) throw new VaultError("invalid_input");
    try {
      await nativeVault.savePassword(options);
    } catch {
      throw new VaultError("unavailable");
    }
  },
  async unlockAndAutofillPassword(options) {
    validateProfileId(options.profileId);
    validateOrigin(options.canonicalOrigin, options.allowInsecureHttp);
    try {
      await nativeVault.unlockAndAutofillPassword(options);
    } catch {
      throw new VaultError("unavailable");
    }
  },
  async deletePassword(profileId) {
    validateProfileId(profileId);
    try {
      await nativeVault.deletePassword({ profileId });
    } catch {
      throw new VaultError("unavailable");
    }
  },
};
