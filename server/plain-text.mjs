/** Browser-safe, deliberately narrow editor-marker conversion, not Markdown. */
export function plainText(text) {
  return String(text).replace(/\*\*(.*?)\*\*/gs, '$1').replace(/(?<!\*)\*([^*]+)\*(?!\*)/gs, '$1').trim();
}
