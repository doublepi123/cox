export const native = (() => {
  const calls = {
    savePassword: new Array<unknown>(),
    unlockAndAutofillPassword: new Array<unknown>(),
    deletePassword: new Array<unknown>(),
    openWorkspace: new Array<unknown>(),
    forgetProfile: new Array<unknown>(),
  };
  const reset = () => {
    calls.savePassword = [];
    calls.unlockAndAutofillPassword = [];
    calls.deletePassword = [];
    calls.openWorkspace = [];
    calls.forgetProfile = [];
  };
  const vault = {
    savePassword: (options: unknown) => {
      calls.savePassword.push(options);
      return Promise.resolve();
    },
    unlockAndAutofillPassword: (options: unknown) => {
      calls.unlockAndAutofillPassword.push(options);
      return Promise.resolve();
    },
    deletePassword: (options: unknown) => {
      calls.deletePassword.push(options);
      return Promise.resolve();
    },
  };
  const workspace = {
    openWorkspace: (profile: unknown) => {
      calls.openWorkspace.push(profile);
      return Promise.resolve();
    },
    closeWorkspace: () => Promise.resolve(),
    forgetProfile: (profile: unknown) => {
      calls.forgetProfile.push(profile);
      return Promise.resolve();
    },
    addListener: () => Promise.resolve({ remove: () => Promise.resolve() }),
  };
  return { calls, reset, vault, workspace };
})();
