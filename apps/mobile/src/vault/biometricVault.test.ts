import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { biometricVault, VaultError } from "./biometricVault";

const native = vi.hoisted(() => ({
  savePassword: vi.fn(),
  unlockAndAutofillPassword: vi.fn(),
  deletePassword: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({ registerPlugin: () => native }));

const profileId = "11111111-1111-4111-8111-111111111111";
const canonicalOrigin = "https://cox.example.com";
const options = { profileId, canonicalOrigin, allowInsecureHttp: false };

beforeEach(() => vi.resetAllMocks());

describe("native credential boundary", () => {
  it("saves an origin-bound credential and returns no native data", async () => {
    native.savePassword.mockResolvedValue({ password: "native-secret" });

    const result = await biometricVault.savePassword({
      profileId,
      canonicalOrigin,
      password: "secret",
      requireBiometric: true,
    });

    expect(native.savePassword).toHaveBeenCalledWith({
      profileId,
      canonicalOrigin,
      password: "secret",
      requireBiometric: true,
    });
    expect(result).toBeUndefined();
  });

  it.each([
    { ...options, canonicalOrigin: "https://cox.example.com/" },
    { ...options, canonicalOrigin: "https://cox.example.com/path" },
    { ...options, canonicalOrigin: "http://cox.example.com" },
    { ...options, profileId: "not-a-uuid" },
  ])("rejects invalid binding or transport before crossing the bridge: %j", async (input) => {
    await expect(biometricVault.unlockAndAutofillPassword(input)).rejects.toBeInstanceOf(Error);
    expect(native.unlockAndAutofillPassword).not.toHaveBeenCalled();
  });

  it("passes explicit HTTP consent and profile isolation to native autofill", async () => {
    const input = {
      ...options,
      canonicalOrigin: "http://127.0.0.1:3773",
      allowInsecureHttp: true,
      androidProfileName: "isolated-profile",
    };
    native.unlockAndAutofillPassword.mockResolvedValue({ password: "native-secret" });

    expect(await biometricVault.unlockAndAutofillPassword(input)).toBeUndefined();
    expect(native.unlockAndAutofillPassword).toHaveBeenCalledWith(input);
  });

  it.each(["origin mismatch", "biometric cancellation"])(
    "sanitizes native %s errors without leaking a credential",
    async (reason) => {
      native.unlockAndAutofillPassword.mockRejectedValue(new Error(`${reason}: secret-password`));

      await expect(biometricVault.unlockAndAutofillPassword(options)).rejects.toEqual(
        new VaultError("unavailable"),
      );
    },
  );

  it("deletes only the selected profile through the native boundary", async () => {
    await biometricVault.deletePassword(profileId);

    expect(native.deletePassword).toHaveBeenCalledWith({ profileId });
  });

  it("preserves vault deletion failure for the caller", async () => {
    native.deletePassword.mockRejectedValue(new Error("native-secret"));

    await expect(biometricVault.deletePassword(profileId)).rejects.toEqual(
      new VaultError("unavailable"),
    );
  });
});
