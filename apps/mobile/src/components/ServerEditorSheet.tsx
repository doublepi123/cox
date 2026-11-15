import { useState, type FormEvent } from "react";
import { normalizeRemoteOrigin, RemoteAdmissionError } from "@t3tools/shared/remoteServerAdmission";
import type { SavedServerProfile, ServerDraft } from "../connections/store";
import { formatConnectionError, type Translator } from "../i18n";
import { Sheet } from "./Sheet";

interface ServerEditorSheetProps {
  readonly profile: SavedServerProfile | null;
  readonly initialOrigin: string;
  readonly onSave: (draft: ServerDraft) => Promise<void>;
  readonly onClose: () => void;
  readonly t: Translator;
}

export function ServerEditorSheet(props: ServerEditorSheetProps) {
  const [label, setLabel] = useState(props.profile?.label ?? "");
  const [origin, setOrigin] = useState(props.profile?.origin ?? props.initialOrigin);
  const [allowInsecureHttp, setAllowInsecureHttp] = useState(
    Boolean(
      props.profile &&
      props.profile.origin.startsWith("http://") &&
      props.profile.allowInsecureHttp,
    ),
  );
  const [savePasswordInVault, setSavePasswordInVault] = useState(
    props.profile?.hasSavedPassword ?? false,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = props.t;

  const close = () => {
    if (!saving) props.onClose();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let normalizedOrigin: string;
    try {
      normalizedOrigin = normalizeRemoteOrigin(origin, { allowInsecureHttp });
    } catch (caught) {
      if (
        caught instanceof RemoteAdmissionError &&
        caught.code === "malformed_input" &&
        /^http:\/\//i.test(origin.trim()) &&
        !allowInsecureHttp
      ) {
        setError(t("httpOptInRequired"));
      } else {
        setError(formatConnectionError(caught, t));
      }
      return;
    }
    setError(null);
    setSaving(true);
    let saved = false;
    try {
      await props.onSave({
        ...(props.profile ? { id: props.profile.id } : {}),
        label,
        origin: normalizedOrigin,
        allowInsecureHttp: normalizedOrigin.startsWith("http://") && allowInsecureHttp,
        savePasswordInVault,
      });
      saved = true;
    } catch (caught) {
      setError(formatConnectionError(caught, t));
    } finally {
      setSaving(false);
    }
    if (saved) props.onClose();
  };

  return (
    <Sheet
      title={props.profile ? t("editServerTitle") : t("addServerTitle")}
      description={t("editorDescription")}
      closeLabel={t("close")}
      onClose={close}
    >
      <form className="editor-form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="server-label">{t("nameLabel")}</label>
          <input
            id="server-label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={t("namePlaceholder")}
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label htmlFor="server-origin">{t("originLabel")}</label>
          <input
            id="server-origin"
            type="url"
            inputMode="url"
            value={origin}
            onChange={(event) => setOrigin(event.target.value)}
            placeholder="https://cox.example.com"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="url"
            required
            aria-describedby="server-origin-help"
            aria-invalid={error !== null}
          />
          <p id="server-origin-help" className="field-help">
            {t("originHelp")}
          </p>
        </div>
        <label className="check-row">
          <input
            type="checkbox"
            checked={allowInsecureHttp}
            onChange={(event) => setAllowInsecureHttp(event.target.checked)}
          />
          <span>{t("allowHttp")}</span>
        </label>
        <p className="warning-copy">{t("allowHttpWarning")}</p>
        <label className="check-row">
          <input
            type="checkbox"
            checked={savePasswordInVault}
            onChange={(event) => setSavePasswordInVault(event.target.checked)}
          />
          <span>{t("savePasswordInVault")}</span>
        </label>
        <p className="field-help">{t("vaultHelp")}</p>
        {error ? (
          <p className="form-error" role="alert" data-testid="server-editor-error">
            {error}
          </p>
        ) : null}
        <div className="sheet-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={close}
            disabled={saving}
          >
            {t("cancel")}
          </button>
          <button
            type="submit"
            className="button button-primary submit-button"
            disabled={saving}
            aria-busy={saving}
          >
            {saving ? t("saving") : t("saveServer")}
          </button>
        </div>
      </form>
    </Sheet>
  );
}
