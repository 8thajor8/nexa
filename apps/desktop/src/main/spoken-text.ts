/** Keep the chat response intact while omitting link destinations from spoken audio. */
export function prepareSpokenText(text: string): string {
  const withLinkLabels = text.replace(/\[([^\]\r\n]+)\]\((https?:\/\/(?:[^()\s]|\([^()\s]*\))+?)\)/giu,
    (_match, label: string) => label.trim() || "este enlace");
  return withLinkLabels.replace(/(^|[\s([{«“‘])((?:https?:\/\/|www\.)[^\s<>"“”‘’»]+)/gimu,
    (match, prefix: string, rawUrl: string) => {
      const punctuation = /[.,!?;:)\]\}]+$/u.exec(rawUrl)?.[0] ?? "";
      const candidate = rawUrl.slice(0, rawUrl.length - punctuation.length);
      try {
        const url = new URL(candidate.startsWith("www.") ? `https://${candidate}` : candidate);
        if (!url.hostname) return match;
      } catch { return match; }
      return `${prefix}este sitio web${punctuation}`;
    });
}
