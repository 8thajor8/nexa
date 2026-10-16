import { SpotifyApiError, spotifyClient } from './client.js';

export const spotifySearchTypes = Object.freeze(['track', 'artist', 'album']);
const maxResults = 5;

function normalizeName(value) {
    return typeof value === 'string'
        ? value.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').toLowerCase()
            .replace(/\bde\b/gu, ' ').replace(/[^a-z0-9]+/gu, ' ').trim()
        : '';
}

function normalizeTrackTitle(value) {
    return normalizeName(value).replace(/\s+(?:(?:19|20)\d{2}\s+)?remaster(?:ed)?$/u, '').trim();
}

function normalizedTrackRequest(query) {
    const unaccented = typeof query === 'string'
        ? query.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').toLowerCase()
            .replace(/[^a-z0-9]+/gu, ' ').trim()
        : '';
    const cleaned = unaccented.replace(/^(?:(?:nexa)\s+)?(?:pone|pon|poneme|reproduce|reproduci|escucha|escuchame|play|quiero escuchar)\s+/u, '').trim();
    const artistSeparator = /^(.*?)\s+(?:de|by)\s+(.+)$/u.exec(cleaned);
    return {
        normalized: normalizeName(cleaned),
        title: artistSeparator ? normalizeTrackTitle(artistSeparator[1]) : null,
        artist: artistSeparator ? normalizeName(artistSeparator[2]) : null,
    };
}

function spotifyLink(item) {
    const url = item?.external_urls?.spotify;
    if (typeof url !== 'string') return null;
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && parsed.hostname === 'open.spotify.com' ? parsed.href : null;
    } catch {
        return null;
    }
}

function asResult(item, type, { includePlaybackMetadata = false } = {}) {
    if (typeof item?.name !== 'string' || typeof item.uri !== 'string' ||
        !new RegExp(`^spotify:${type}:[A-Za-z0-9]+$`, 'u').test(item.uri)) return null;
    const result = {
        type,
        name: item.name,
        artists: Array.isArray(item.artists) ? item.artists.map(artist => artist.name).filter(Boolean) : [],
        album: typeof item.album?.name === 'string' ? item.album.name : null,
        uri: item.uri,
        spotifyUrl: spotifyLink(item),
        durationMs: Number.isInteger(item.duration_ms) ? item.duration_ms : null,
    };
    // Keep provider-supplied playback context private to the playback path by
    // default; public search results retain their existing shape.
    if (includePlaybackMetadata && type === 'track'
        && typeof item.album?.uri === 'string'
        && /^spotify:album:[A-Za-z0-9]+$/u.test(item.album.uri)) {
        result.albumUri = item.album.uri;
    }
    return result;
}

export async function searchSpotify(query, type = 'track', { client = spotifyClient, includePlaybackMetadata = false } = {}) {
    if (typeof query !== 'string' || !query.trim() || query.length > 200) {
        return { success: false, error: { code: 'spotify_query_invalid', message: 'Especificá qué querés buscar en Spotify.' } };
    }
    if (!spotifySearchTypes.includes(type)) {
        return { success: false, error: { code: 'spotify_type_invalid', message: 'El tipo de búsqueda debe ser track, artist o album.' } };
    }
    try {
        const response = await client.request('/search', {
            query: { q: query.trim(), type, limit: String(maxResults) },
        });
        const items = response?.[`${type}s`]?.items ?? [];
        const seenUris = new Set();
        const results = items.map(item => asResult(item, type, { includePlaybackMetadata })).filter(item => {
            if (!item || seenUris.has(item.uri)) return false;
            seenUris.add(item.uri);
            return true;
        }).slice(0, maxResults);
        return { success: true, query: query.trim(), type, count: results.length, results };
    } catch (error) {
        return spotifyFailure(error);
    }
}

export function chooseUnambiguousResult(query, results) {
    const requested = normalizeName(query);
    const exact = results.filter(item => {
        const name = normalizeName(item.name);
        const nameAndArtists = normalizeName([item.name, ...(item.artists ?? [])].join(' '));
        return requested === name || requested === nameAndArtists;
    });
    if (exact.length === 1) return { status: 'found', item: exact[0] };
    return { status: exact.length > 1 ? 'ambiguous' : 'no_exact_match', items: results };
}

// Exact track selection is deliberately conservative: an explicit "title de/by
// artist" request must match the title and primary artist, while irrelevant
// search-ranked results are ignored. Remaster suffixes are equivalent only
// when no exact-title candidate exists.
export function chooseTrackResult(query, results) {
    const request = normalizedTrackRequest(query);
    if (!request.normalized) return { status: 'invalid_query', items: [] };

    const candidates = results.filter(item => {
        const title = normalizeTrackTitle(item?.name);
        if (!title) return false;
        if (request.title && title !== request.title) return false;
        if (!request.title && title !== request.normalized) {
            const combined = normalizeName([item.name, ...(item.artists ?? [])].join(' '));
            if (combined !== request.normalized) return false;
        }
        if (request.artist) return normalizeName(item.artists?.[0]) === request.artist;
        return true;
    });
    if (!candidates.length) return { status: 'no_exact_match', items: results };

    // Prefer an unqualified title over an equivalent remaster, then collapse
    // repeated catalog entries for the same primary artist and title.
    const exactTitle = candidates.filter(item => normalizeName(item.name) === request.title
        || (!request.title && normalizeName(item.name) === request.normalized));
    const preferred = exactTitle.length ? exactTitle : candidates;
    const unique = new Map();
    for (const item of preferred) {
        const identity = `${normalizeTrackTitle(item.name)}|${normalizeName(item.artists?.[0])}`;
        if (!unique.has(identity)) unique.set(identity, item);
    }
    return unique.size === 1
        ? { status: 'found', item: unique.values().next().value }
        : { status: 'ambiguous', items: [...unique.values()] };
}

// Spotify returns search results in relevance order. For an open-ended request,
// choose the first distinct result and avoid repeating the same track identity.
export function chooseBestMatchResult(query, results) {
    if (!normalizeName(query)) return { status: 'invalid_query', items: [] };
    const seen = new Set();
    const distinct = results.filter(item => {
        const identity = `${normalizeName(item.name)}|${normalizeName((item.artists ?? []).join(' '))}`;
        if (!identity.replace('|', '').trim() || seen.has(identity)) return false;
        seen.add(identity);
        return true;
    });
    return distinct.length > 0 ? { status: 'found', item: distinct[0] } : { status: 'no_relevant_match', items: [] };
}

export function spotifyFailure(error) {
    const code = error instanceof SpotifyApiError || typeof error?.code === 'string'
        ? error.code
        : 'spotify_error';
    const messages = {
        spotify_auth_required: 'Spotify todavía no está autorizado. Ejecutá npm run spotify:auth.',
        spotify_config_missing: 'Falta SPOTIFY_CLIENT_ID o la configuración de Spotify en .env.',
        spotify_config_invalid: 'La Redirect URI de Spotify no coincide con la configuración local esperada.',
        spotify_reauthorization_required: 'La autorización de Spotify venció. Volvé a autorizar Nexa.',
        spotify_forbidden: 'Spotify rechazó la acción (HTTP 403); puede deberse a permisos, cuenta o una restricción del proveedor.',
        spotify_no_device: 'No hay un dispositivo Spotify disponible; abrí Spotify o activá un dispositivo Connect.',
        spotify_rate_limited: 'Spotify pidió reducir la frecuencia de solicitudes. Probá de nuevo más tarde.',
        spotify_network_error: 'No se pudo conectar con Spotify. Revisá la conexión e intentá de nuevo.',
        spotify_service_unavailable: 'Spotify no está disponible en este momento.',
        spotify_token_store_error: 'No se pudo acceder al archivo local de autorización de Spotify.',
        spotify_auth_failed: 'Falló la autorización de Spotify. Volvé a autorizar Nexa.',
    };
    return {
        success: false,
        error: { code, message: messages[code] ?? 'Spotify no pudo completar la solicitud.' },
        ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
        ...(error?.retryAfter ? { retryAfter: Number(error.retryAfter) || null } : {}),
    };
}
