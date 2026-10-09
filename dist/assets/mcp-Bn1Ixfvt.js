import { cp as useSync, c2 as useLanguage, c6 as useMutation, bJ as showToast } from "./main-DCPF1cGh.js";
function useMcpToggle() {
  const sync = useSync();
  const language = useLanguage();
  return useMutation(() => ({
    mutationFn: sync().mcp.toggle,
    onError: (error) => showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: error instanceof Error ? error.message : String(error)
    })
  }));
}
export {
  useMcpToggle as u
};
