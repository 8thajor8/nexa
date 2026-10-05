import { SpotifyApiError, spotifyClient } from './client.js';

export const spotifySearchTypes = Object.freeze(['track', 'artist', 'album']);
const maxResults = 5;

function normalizeName(value) {
    return typeof value === 'string'
        ? value.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').toLowerCase()
            .replace(/\bde\b/gu, ' ').replace(/[^a-z0-9]+/gu, ' ').trim()
        : '';
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

function asResult(item, type) {
    if (typeof item?.name !== 'string' || typeof item.uri !== 'string' ||
        !new RegExp(`^spotify:${type}:[A-Za-z0-9]+$`, 'u').test(item.uri)) return null;
    return {
        type,
        name: item.name,
        artists: Array.isArray(item.artists) ? item.artists.map(artist => artist.name).filter(Boolean) : [],
        album: typeof item.album?.name === 'string' ? item.album.name : null,
        uri: item.uri,
        spotifyUrl: spotifyLink(item),
        durationMs: Number.isInteger(item.duration_ms) ? item.duration_ms : null,
    };
}

export async function searchSpotify(query, type = 'track', { client = spotifyClient } = {}) {
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
        const results = items.map(item => asResult(item, type)).filter(Boolean).slice(0, maxResults);
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

export function spotifyFailure(error) {
    const code = error instanceof SpotifyApiError || typeof error?.code === 'string'
        ? error.code
        : 'spotify_error';
    const messages = {
        spotify_auth_required: 'Spotify todavía no está autorizado. Ejecutá npm run spotify:auth.',
        spotify_config_missing: 'Falta SPOTIFY_CLIENT_ID o la configuración de Spotify en .env.',
        spotify_config_invalid: 'La Redirect URI de Spotify no coincide con la configuración local esperada.',
        spotify_reauthorization_required: 'La autorización de Spotify venció. Volvé a autorizar Nexa.',
        spotify_scope_or_premium_required: 'Spotify requiere scopes adicionales o una cuenta Premium para esta operación.',
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
        ...(error?.retryAfter ? { retryAfter: Number(error.retryAfter) || null } : {}),
    };
}
