import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { WorkspaceProfile } from "./iosWorkspacePolicy";
import { workspaceProfile } from "./iosWorkspacePolicy";

interface WorkspacePlugin {
  openWorkspace(profile: WorkspaceProfile): Promise<void>;
  closeWorkspace(): Promise<void>;
  forgetProfile(profile: { readonly profileId: string; readonly origin: string }): Promise<void>;
  addListener(
    event: "openServerSwitcher" | "openConnectionManager",
    listener: () => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: "workspaceLocation",
    listener: (location: { readonly profileId: string; readonly path: string }) => void,
  ): Promise<PluginListenerHandle>;
}

export const CoxWorkspaceWebView = registerPlugin<WorkspacePlugin>("CoxWorkspaceWebView");

export const hasNativeWorkspace = () => Capacitor.isNativePlatform();

export async function openWorkspace(profile: WorkspaceProfile): Promise<void> {
  if (hasNativeWorkspace()) await CoxWorkspaceWebView.openWorkspace(workspaceProfile(profile));
}

export async function forgetWorkspaceProfile(profile: {
  readonly id: string;
  readonly origin: string;
}): Promise<void> {
  if (hasNativeWorkspace())
    await CoxWorkspaceWebView.forgetProfile({ profileId: profile.id, origin: profile.origin });
}
