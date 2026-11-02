import { useTranslation } from "../../i18n";

export function UnreadCompletionIndicator({ visible }: { readonly visible: boolean }) {
  const { t } = useTranslation();
  if (!visible) return null;
  const label = t("Completed, unread");
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="inline-block size-2 shrink-0 rounded-full bg-info"
    />
  );
}
