import { useTranslation } from "../../i18n";

export function useMobileWorkspaceLabels() {
  const { language, t } = useTranslation();
  const zh = language === "zh";
  return {
    workspace: zh ? "工作区" : t("Workspace"),
    threads: zh ? "会话" : t("Threads"),
    newThread: t("New thread"),
    changes: zh ? "变更" : t("Changes"),
    terminal: zh ? "终端" : t("Terminal"),
    servers: zh ? "服务器" : t("Servers"),
  };
}
