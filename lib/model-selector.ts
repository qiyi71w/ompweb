/** OMP 18.8.4 tui/thinking + overlays/model-selector grammar. Keep raw spelling. */
export function splitModelThinking(selector: string, literalModels: readonly string[] = []): { model: string; thinking: string } {
  const colon = selector.lastIndexOf(":");
  const aliasPrefixLength = selector.startsWith("@") ? 1 : selector.startsWith("pi/") ? 3 : -1;
  if (colon <= aliasPrefixLength) return { model: selector, thinking: "" };
  const suffix = selector.slice(colon + 1);
  const levels = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const matches = levels.filter((level) => level === suffix || (suffix.length >= 2 && level.startsWith(suffix)));
  const level = matches.length === 1 ? matches[0] : suffix === "auto" ? "auto" : undefined;
  if (!level || ((level === "max" || level === "auto") && literalModels.includes(selector))) return { model: selector, thinking: "" };
  return { model: selector.slice(0, colon), thinking: suffix };
}
