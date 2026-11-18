import { useEffect, useState, useSyncExternalStore } from "react";
import { RemoteGatewayRequiredError } from "@t3tools/shared/remoteServerAdmission";
import { ServerEditorSheet } from "./components/ServerEditorSheet";
import { ServerList } from "./components/ServerList";
import { Sheet } from "./components/Sheet";
import type { SavedServerProfile, ServerDraft } from "./connections/store";
import { ConnectionStore } from "./connections/store";
import {
  applyLocale,
  formatConnectionError,
  readInitialLocale,
  translator,
  type Locale,
} from "./i18n";
import { applyThemePreference, readThemePreference, type ThemePreference } from "./theme";
import {
  forgetWorkspaceProfile,
  hasNativeWorkspace,
  openWorkspace,
  subscribeWorkspaceLocation,
} from "./workspace/workspacePlugin";

type ActiveSheet =
  | {
      readonly kind: "editor";
      readonly profile: SavedServerProfile | null;
      readonly origin: string;
    }
  | { readonly kind: "forget"; readonly profile: SavedServerProfile }
  | null;

interface AppProps {
  readonly store: ConnectionStore;
}

export function App({ store }: AppProps) {
  const { profiles } = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [locale, setLocale] = useState<Locale>(readInitialLocale);
  const [theme, setTheme] = useState<ThemePreference>(readThemePreference);
  const [sheet, setSheet] = useState<ActiveSheet>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const t = translator(locale);

  useEffect(() => {
    applyLocale(locale);
    document.title = `${translator(locale)("appTitle")} - Cox Mobile`;
  }, [locale]);

  useEffect(() => applyThemePreference(theme), [theme]);

  useEffect(() => {
    let active = true;
    let dispose: (() => void) | undefined;
    void subscribeWorkspaceLocation(({ profileId, path }) => {
      store.rememberThreadPath(profileId, path);
    }).then((cleanup) => {
      if (active) dispose = cleanup;
      else cleanup();
    });
    return () => {
      active = false;
      dispose?.();
    };
  }, [store]);

  const saveServer = async (draft: ServerDraft) => {
    await store.saveServer(draft);
    setError(null);
    setNotice(null);
  };

  const openSavedProfile = async (id: string) => {
    let profile: SavedServerProfile;
    let gatewayLogin = false;
    try {
      profile = await store.connect(id);
    } catch (caught) {
      const saved = store.getSnapshot().profiles.find((entry) => entry.id === id);
      if (!(caught instanceof RemoteGatewayRequiredError) || !hasNativeWorkspace() || !saved)
        throw caught;
      profile = saved;
      gatewayLogin = true;
    }
    await openWorkspace({
      profileId: profile.id,
      origin: profile.origin,
      allowInsecureHttp: profile.allowInsecureHttp,
      label: profile.label,
      lastThreadPath: profile.lastThreadPath,
      serverCount: store.getSnapshot().profiles.length,
      gatewayLogin,
    });
    setNotice(t("connectionReady"));
  };

  const saveAndConnectServer = async (draft: ServerDraft) => {
    const saved = await store.saveServer(draft);
    setError(null);
    setNotice(null);
    await openSavedProfile(saved.id);
  };

  const connect = async (id: string) => {
    const started = performance.now();
    performance.mark("cox-mobile-connect:start");
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      await openSavedProfile(id);
      performance.measure("cox-mobile-connect", { start: started });
    } catch (caught) {
      setError(formatConnectionError(caught, t));
    } finally {
      setBusyId(null);
    }
  };

  const move = (id: string, index: number) => {
    try {
      store.move(id, index);
      setError(null);
    } catch (caught) {
      setError(formatConnectionError(caught, t));
    }
  };

  const forget = async (profile: SavedServerProfile) => {
    setBusyId(profile.id);
    try {
      await forgetWorkspaceProfile(profile);
      await store.forget(profile.id);
      setSheet(null);
      setError(null);
      setNotice(null);
    } catch (caught) {
      setError(formatConnectionError(caught, t));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">Cox Mobile</div>
        <h1>{t("appTitle")}</h1>
        <p>{t("appDescription")}</p>
        <div className="primary-actions">
          <button
            type="button"
            className="button button-primary"
            onClick={() => setSheet({ kind: "editor", profile: null, origin: "https://" })}
          >
            {t("addServer")}
          </button>
        </div>
      </header>
      <main>
        {error ? (
          <p className="form-error page-message" role="alert" data-testid="connection-error">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="success-message page-message" role="status">
            {notice}
          </p>
        ) : null}
        <section className="servers-section" aria-labelledby="servers-title">
          <div className="section-heading">
            <h2 id="servers-title">{t("savedServers")}</h2>
            <span className="server-count">{profiles.length}</span>
          </div>
          <ServerList
            profiles={profiles}
            busyId={busyId}
            onConnect={(id) => void connect(id)}
            onEdit={(profile) => setSheet({ kind: "editor", profile, origin: profile.origin })}
            onForget={(profile) => setSheet({ kind: "forget", profile })}
            onMove={move}
            t={t}
          />
        </section>
      </main>
      <footer className="preferences">
        <h2>{t("preferences")}</h2>
        <div className="preference-row">
          <span>{t("language")}</span>
          <div className="segmented" role="group" aria-label={t("language")}>
            <button type="button" aria-pressed={locale === "en"} onClick={() => setLocale("en")}>
              English
            </button>
            <button
              type="button"
              aria-pressed={locale === "zh-CN"}
              onClick={() => setLocale("zh-CN")}
            >
              简体中文
            </button>
          </div>
        </div>
        <div className="preference-row">
          <span>{t("theme")}</span>
          <div className="segmented" role="group" aria-label={t("theme")}>
            {(["system", "dark", "light"] as const).map((option) => (
              <button
                type="button"
                key={option}
                aria-pressed={theme === option}
                onClick={() => setTheme(option)}
              >
                {t(option)}
              </button>
            ))}
          </div>
        </div>
        <p className="security-note">{t("securityNote")}</p>
      </footer>
      {sheet?.kind === "editor" ? (
        <ServerEditorSheet
          key={`${sheet.profile?.id ?? "new"}:${sheet.origin}`}
          profile={sheet.profile}
          initialOrigin={sheet.origin}
          onSave={saveServer}
          onSaveAndConnect={saveAndConnectServer}
          onClose={() => setSheet(null)}
          t={t}
        />
      ) : null}
      {sheet?.kind === "forget" ? (
        <Sheet
          title={t("forgetTitle")}
          closeLabel={t("close")}
          onClose={() => setSheet(null)}
          className="confirm-sheet"
        >
          <p className="forget-target">{sheet.profile.label}</p>
          <p>{t("forgetWarning")}</p>
          {error ? (
            <p role="alert" className="form-error">
              {error}
            </p>
          ) : null}
          <div className="sheet-actions">
            <button
              type="button"
              className="button button-secondary"
              disabled={busyId === sheet.profile.id}
              onClick={() => setSheet(null)}
            >
              {t("keepServer")}
            </button>
            <button
              type="button"
              className="button button-danger"
              onClick={() => void forget(sheet.profile)}
              disabled={busyId === sheet.profile.id}
            >
              {t("forgetServer")}
            </button>
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}
