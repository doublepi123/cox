import type {
  GatewaySignInRequest,
  ProfileUrlRequest,
  ProfileUrlResponse,
} from "../workspace/workspacePlugin";

type LocationListener = (location: { readonly profileId: string; readonly path: string }) => void;

export const native = (() => {
  const locationListeners = new Set<LocationListener>();
  let requestHandler: ((request: ProfileUrlRequest) => Promise<ProfileUrlResponse>) | undefined;
  let gatewaySignInHandler: ((request: GatewaySignInRequest) => Promise<void>) | undefined;
  const calls = {
    savePassword: new Array<unknown>(),
    unlockAndAutofillPassword: new Array<unknown>(),
    deletePassword: new Array<unknown>(),
    requestProfileUrl: new Array<ProfileUrlRequest>(),
    signInToGateway: new Array<GatewaySignInRequest>(),
    openWorkspace: new Array<unknown>(),
    forgetProfile: new Array<unknown>(),
  };
  const reset = () => {
    calls.savePassword = [];
    calls.unlockAndAutofillPassword = [];
    calls.deletePassword = [];
    calls.requestProfileUrl = [];
    calls.signInToGateway = [];
    calls.openWorkspace = [];
    calls.forgetProfile = [];
    requestHandler = undefined;
    gatewaySignInHandler = undefined;
    locationListeners.clear();
  };
  const setHandlers = (handlers: {
    readonly requestProfileUrl?: (request: ProfileUrlRequest) => Promise<ProfileUrlResponse>;
    readonly signInToGateway?: (request: GatewaySignInRequest) => Promise<void>;
  }) => {
    requestHandler = handlers.requestProfileUrl;
    gatewaySignInHandler = handlers.signInToGateway;
  };
  const emitLocation = (profileId: string, path: string) => {
    for (const listener of locationListeners) listener({ profileId, path });
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
    requestProfileUrl: (request: ProfileUrlRequest) => {
      calls.requestProfileUrl.push(request);
      if (!requestHandler) {
        return Promise.reject(
          Object.assign(new Error("Unmocked request"), { code: "network_error" }),
        );
      }
      return requestHandler(request);
    },
    signInToGateway: (request: GatewaySignInRequest) => {
      calls.signInToGateway.push(request);
      if (!gatewaySignInHandler) return Promise.resolve();
      return gatewaySignInHandler(request);
    },
    openWorkspace: (profile: unknown) => {
      calls.openWorkspace.push(profile);
      return Promise.resolve();
    },
    closeWorkspace: () => Promise.resolve(),
    forgetProfile: (profile: unknown) => {
      calls.forgetProfile.push(profile);
      return Promise.resolve();
    },
    addListener: (event: string, listener: LocationListener) => {
      if (event === "workspaceLocation") locationListeners.add(listener);
      return Promise.resolve({
        remove: () => {
          locationListeners.delete(listener);
          return Promise.resolve();
        },
      });
    },
  };
  return { calls, emitLocation, reset, setHandlers, vault, workspace };
})();
