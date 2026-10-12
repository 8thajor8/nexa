import { getSpotifyAccessToken, SpotifyAuthError } from './auth.js';

export class SpotifyApiError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'SpotifyApiError';
        this.code = code;
        Object.assign(this, details);
    }
}

function safeResponseLocation(response) {
    try {
        const location = new URL(response?.url);
        return { responseHost: location.hostname, responsePath: location.pathname,
            redirected: response?.redirected === true, responseType: typeof response?.type === 'string' ? response.type : 'unknown' };
    } catch {
        return { responseHost: null, responsePath: null,
            redirected: response?.redirected === true, responseType: typeof response?.type === 'string' ? response.type : 'unknown' };
    }
}

function mapHttpError(status, retryAfter) {
    if (status === 401) return new SpotifyApiError('spotify_auth_expired', 'Spotify rechazó el token. Volvé a autorizar Nexa.', { status });
    // HTTP 403 confirms a provider rejection, but its status alone does not
    // distinguish missing scopes from account/device restrictions.
    if (status === 403) return new SpotifyApiError('spotify_forbidden', 'Spotify rechazó la acción (HTTP 403); puede deberse a permisos, cuenta o una restricción del proveedor.', { status });
    if (status === 404) return new SpotifyApiError('spotify_no_device', 'No hay un dispositivo Spotify disponible para esta operación.', { status });
    if (status === 429) return new SpotifyApiError('spotify_rate_limited', 'Spotify pidió reducir la frecuencia de solicitudes.', { retryAfter, status });
    if (status >= 500) return new SpotifyApiError('spotify_service_unavailable', 'Spotify no está disponible en este momento.', { status });
    return new SpotifyApiError('spotify_api_error', 'Spotify no pudo completar la solicitud.', { status });
}

function reportResponseBody(onResponse, status, bodyKind, bodyLength, response) {
    const rawContentType = response?.headers?.get?.('content-type');
    const contentType = typeof rawContentType === 'string' && /^application\/json(?:\s*;|$)/iu.test(rawContentType)
        ? 'application/json'
        : typeof rawContentType === 'string' && rawContentType.length > 0 ? 'other' : 'missing';
    try { onResponse?.(status, { stage: 'response_body', bodyKind, bodyLength, contentType }); }
    catch { /* Diagnostics cannot change provider behavior. */ }
}

async function readSuccessfulResponseBody(response, onResponse) {
    if (typeof response?.text === 'function') {
        const text = await response.text();
        if (typeof text !== 'string') {
            reportResponseBody(onResponse, response.status, 'invalid_representation', null, response);
            throw new SpotifyApiError('spotify_invalid_response', 'Spotify devolvió una respuesta que Nexa no pudo interpretar.', { status: response.status });
        }
        // UTF-8 BOM is legal in some JSON transports, although JSON.parse does not accept it.
        const normalized = text.replace(/^\uFEFF/u, '');
        if (!normalized.trim()) {
            reportResponseBody(onResponse, response.status, 'empty', 0, response);
            return null;
        }
        try {
            const body = JSON.parse(normalized);
            reportResponseBody(onResponse, response.status, 'json', normalized.length, response);
            return body;
        } catch {
            reportResponseBody(onResponse, response.status, 'invalid_json', normalized.length, response);
            throw new SpotifyApiError('spotify_invalid_response', 'Spotify devolvió una respuesta que Nexa no pudo interpretar.', { status: response.status });
        }
    }
    if (typeof response?.json === 'function') {
        try {
            const body = await response.json();
            reportResponseBody(onResponse, response.status, 'json', null, response);
            return body;
        } catch {
            reportResponseBody(onResponse, response.status, 'invalid_json', null, response);
            throw new SpotifyApiError('spotify_invalid_response', 'Spotify devolvió una respuesta que Nexa no pudo interpretar.', { status: response.status });
        }
    }
    reportResponseBody(onResponse, response?.status, 'unreadable', null, response);
    throw new SpotifyApiError('spotify_invalid_response', 'Spotify devolvió una respuesta que Nexa no pudo interpretar.', { status: response?.status });
}

export class SpotifyClient {
    constructor({ fetchImpl = fetch, getAccessToken = getSpotifyAccessToken, tokenOptions = {} } = {}) {
        this.fetchImpl = fetchImpl;
        this.getAccessToken = getAccessToken;
        this.tokenOptions = tokenOptions;
    }

    async request(endpoint, { method = 'GET', query, body, onResponse, responseContract = 'json' } = {}) {
        const url = new URL(`https://api.spotify.com/v1/${endpoint.replace(/^\//u, '')}`);
        if (query) url.search = new URLSearchParams(query).toString();
        let retriedAuth = false;
        while (true) {
            let accessToken;
            try {
                accessToken = await this.getAccessToken(this.tokenOptions);
                this.tokenOptions = { ...this.tokenOptions, forceRefresh: false };
            } catch (error) {
                if (error instanceof SpotifyAuthError) throw error;
                throw new SpotifyApiError('spotify_auth_error', 'No se pudo obtener autorización para Spotify.');
            }

            let response;
            try {
                response = await this.fetchImpl(url, {
                    method,
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        ...(body ? { 'Content-Type': 'application/json' } : {}),
                    },
                    ...(body ? { body: JSON.stringify(body) } : {}),
                    signal: AbortSignal.timeout(15_000),
                });
            } catch {
                throw new SpotifyApiError('spotify_network_error', 'No se pudo conectar con Spotify.');
            }

            const responseLocation = safeResponseLocation(response);
            const requestLocation = { requestHost: url.hostname, requestPath: url.pathname, method };
            try { onResponse?.(response.status, { stage: 'provider_response', ...requestLocation, ...responseLocation }); }
            catch { /* Diagnostics cannot change provider behavior. */ }

            if (response.status === 204) return null;
            if (response.status === 401 && !retriedAuth && responseContract !== 'no-content') {
                retriedAuth = true;
                this.tokenOptions = { ...this.tokenOptions, forceRefresh: true };
                continue;
            }
            if (!response.ok) throw mapHttpError(response.status, response.headers?.get?.('retry-after'));
            // Spotify documents the playback write endpoints as 204 No Content.
            // A different 2xx response may mean the action ran, but is not a
            // documented confirmation and must not be mistaken for a success.
            if (responseContract === 'no-content') {
                // A 2xx body outside Spotify's documented 204 contract is deliberately
                // not read. Cancel the stream to release resources without exposing it.
                try { await response?.body?.cancel?.(); } catch { /* Preserve the uncertain result. */ }
                const contentType = response?.headers?.get?.('content-type');
                try { onResponse?.(response.status, { stage: 'response_body', ...requestLocation, ...responseLocation, bodyKind: 'not_read',
                    bodyLength: null,
                    contentType: typeof contentType === 'string' && contentType.length ? 'other' : 'missing' }); }
                catch { /* Diagnostics cannot change provider behavior. */ }
                throw new SpotifyApiError('spotify_unexpected_write_response',
                    'Spotify respondió con un formato de confirmación no documentado.', { status: response.status });
            }
            // The endpoint status is not enough: validate a present body, while allowing
            // the empty response contract used by Spotify playback writes.
            return await readSuccessfulResponseBody(response, onResponse);
        }
    }
}

export const spotifyClient = new SpotifyClient();
