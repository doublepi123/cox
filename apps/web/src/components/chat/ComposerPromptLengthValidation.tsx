import { useTranslation } from "../../i18n";

export function ComposerPromptLengthValidation({ message }: { message: string | null }) {
  const { t } = useTranslation();
  if (!message) return null;

  return (
    <p
      role="alert"
      className="px-3 pb-2 text-xs text-destructive sm:px-4"
      data-chat-composer-validation="prompt-length"
    >
      {t(message)}
    </p>
  );
}
