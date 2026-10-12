export function isSpotifyTrackUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "open.spotify.com" && !url.username && !url.password
      && !url.port && /^\/track\/[A-Za-z0-9]+\/?$/u.test(url.pathname);
  } catch { return false; }
}

export function canonicalSpotifyTrackUrl(value: unknown): string | null {
  if (!isSpotifyTrackUrl(value)) return null;
  const url = new URL(value);
  return `https://open.spotify.com${url.pathname.replace(/\/$/u, "")}`;
}
