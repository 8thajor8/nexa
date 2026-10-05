import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { loadSpotifyTokens, saveSpotifyTokens } from './token-store.js';

export const spotifyScopes = Object.freeze([
    'user-read-playback-state',
    'user-read-currently-playing',
    'user-modify-playback-state',
]);

export const defaultSpotifyRedirectUri = 'http://127.0.0.1:8888/callback';
const authorizeEndpoint = 'https://accounts.spotify.com/authorize';
const tokenEndpoint = 'https://accounts.spotify.com/api/token';

export class SpotifyAuthError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'SpotifyAuthError';
        this.code = code;
    }
}

export function getSpotifyConfiguration(environment = process.env) {
    const clientId = typeof environment.SPOTIFY_CLIENT_ID === 'string'
        ? environment.SPOTIFY_CLIENT_ID.trim()
        : '';
    const redirectUri = typeof environment.SPOTIFY_REDIRECT_URI === 'string'
        ? environment.SPOTIFY_REDIRECT_URI.trim() || defaultSpotifyRedirectUri
        : defaultSpotifyRedirectUri;
    let parsedRedirect;
    try {
        parsedRedirect = new URL(redirectUri);
    } catch {
        throw new SpotifyAuthError('spotify_config_invalid', 'SPOTIFY_REDIRECT_URI no es válida.');
    }
    if (
        !clientId || clientId.length > 256 ||
        parsedRedirect.protocol !== 'http:' ||
        parsedRedirect.hostname !== '127.0.0.1' ||
        parsedRedirect.pathname !== '/callback' ||
        parsedRedirect.search || parsedRedirect.hash ||
        parsedRedirect.port !== '8888'
    ) {
        throw new SpotifyAuthError(
            'spotify_config_missing',
            'Configurá SPOTIFY_CLIENT_ID y la redirect URI local esperada en .env.'
        );
    }
    return { clientId, redirectUri: defaultSpotifyRedirectUri };
}

function base64Url(buffer) {
    return buffer.toString('base64').replace(/=/gu, '').replace(/\+/gu, '-').replace(/\//gu, '_');
}

export function createSpotifyAuthorizationUrl({ clientId, redirectUri = defaultSpotifyRedirectUri } = {}) {
    const verifier = base64Url(randomBytes(48));
    const state = base64Url(randomBytes(24));
    const challenge = base64Url(createHash('sha256').update(verifier).digest());
    const url = new URL(authorizeEndpoint);
    url.search = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: spotifyScopes.join(' '),
        code_challenge_method: 'S256',
        code_challenge: challenge,
        state,
    }).toString();
    return { url: url.toString(), verifier, state };
}

async function postTokenForm(body, fetchImpl = fetch) {
    let response;
    try {
        response = await fetchImpl(tokenEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(body),
            signal: AbortSignal.timeout(15_000),
        });
    } catch {
        throw new SpotifyAuthError('spotify_network_error', 'No se pudo conectar con la autorización de Spotify.');
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || typeof payload.access_token !== 'string') {
        const code = payload.error === 'invalid_grant'
            ? 'spotify_reauthorization_required'
            : 'spotify_auth_failed';
        throw new SpotifyAuthError(code, 'Spotify rechazó la autorización o renovación del token.');
    }
    return payload;
}

function tokensFromResponse(payload, previous = {}) {
    const now = Date.now();
    return {
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token ?? previous.refreshToken ?? null,
        expiresAt: now + Math.max(0, Number(payload.expires_in) || 3600) * 1000,
        scope: typeof payload.scope === 'string' ? payload.scope.split(/\s+/u).filter(Boolean) : previous.scope ?? [],
    };
}

export async function exchangeSpotifyAuthorizationCode({ code, verifier, environment = process.env, fetchImpl = fetch, tokenStore = { save: saveSpotifyTokens } } = {}) {
    const { clientId, redirectUri } = getSpotifyConfiguration(environment);
    const payload = await postTokenForm({
        client_id: clientId,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
    }, fetchImpl);
    const tokens = tokensFromResponse(payload);
    if (!tokens.refreshToken) {
        throw new SpotifyAuthError('spotify_refresh_missing', 'Spotify no devolvió un refresh token; volvé a iniciar la autorización.');
    }
    await tokenStore.save(tokens);
    return tokens;
}

export async function refreshSpotifyTokens({ refreshToken, environment = process.env, fetchImpl = fetch, tokenStore = { save: saveSpotifyTokens }, previous = {} } = {}) {
    const { clientId } = getSpotifyConfiguration(environment);
    if (typeof refreshToken !== 'string' || !refreshToken) {
        throw new SpotifyAuthError('spotify_auth_required', 'Spotify todavía no está autorizado. Ejecutá npm run spotify:auth.');
    }
    const payload = await postTokenForm({
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
    }, fetchImpl);
    const tokens = tokensFromResponse(payload, { ...previous, refreshToken });
    await tokenStore.save(tokens);
    return tokens;
}

export async function getSpotifyAccessToken({ environment = process.env, tokenStore = { load: loadSpotifyTokens, save: saveSpotifyTokens }, fetchImpl = fetch, now = Date.now, forceRefresh = false } = {}) {
    try {
        const tokens = await tokenStore.load();
        if (!tokens?.refreshToken) {
            throw new SpotifyAuthError('spotify_auth_required', 'Spotify todavía no está autorizado. Ejecutá npm run spotify:auth.');
        }
        if (!forceRefresh && typeof tokens.accessToken === 'string' && tokens.expiresAt > now() + 30_000) {
            return tokens.accessToken;
        }
        const refreshed = await refreshSpotifyTokens({
            refreshToken: tokens.refreshToken,
            environment,
            fetchImpl,
            tokenStore,
            previous: tokens,
        });
        return refreshed.accessToken;
    } catch (error) {
        if (error instanceof SpotifyAuthError) throw error;
        throw new SpotifyAuthError('spotify_token_store_error', 'No se pudo leer o guardar la autorización local de Spotify.');
    }
}

export async function authorizeSpotify({ environment = process.env, fetchImpl = fetch, tokenStore = { save: saveSpotifyTokens }, output = console.log } = {}) {
    const { clientId, redirectUri } = getSpotifyConfiguration(environment);
    const authorization = createSpotifyAuthorizationUrl({ clientId, redirectUri });
    const callback = new URL(redirectUri);

    return new Promise((resolve, reject) => {
        const server = createServer(async (request, response) => {
            const requestUrl = new URL(request.url, redirectUri);
            if (requestUrl.pathname !== callback.pathname) {
                response.writeHead(404).end('Not found');
                return;
            }
            if (requestUrl.searchParams.get('state') !== authorization.state) {
                response.writeHead(400).end('State validation failed.');
                server.close();
                reject(new SpotifyAuthError('spotify_state_mismatch', 'Spotify devolvió un estado OAuth inválido.'));
                return;
            }
            const code = requestUrl.searchParams.get('code');
            if (!code) {
                response.writeHead(400).end('Spotify authorization was cancelled.');
                server.close();
                reject(new SpotifyAuthError('spotify_authorization_denied', 'La autorización de Spotify fue cancelada o denegada.'));
                return;
            }
            try {
                const tokens = await exchangeSpotifyAuthorizationCode({
                    code,
                    verifier: authorization.verifier,
                    environment,
                    fetchImpl,
                    tokenStore,
                });
                response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
                    .end('Nexa ya quedó autorizada con Spotify. Podés cerrar esta pestaña.');
                server.close();
                resolve(tokens);
            } catch (error) {
                response.writeHead(500).end('No se pudo completar Spotify OAuth. Revisá la terminal de Nexa.');
                server.close();
                reject(error);
            }
        });
        let timeout;
        server.once('error', () => {
            clearTimeout(timeout);
            reject(new SpotifyAuthError('spotify_callback_unavailable', 'No se pudo abrir el callback local 127.0.0.1:8888.'));
        });
        server.listen(Number(callback.port), '127.0.0.1', () => {
            output(`Abrí este enlace para autorizar Nexa con Spotify:\n${authorization.url}`);
        });
        timeout = setTimeout(() => {
            server.close();
            reject(new SpotifyAuthError('spotify_authorization_timeout', 'Se agotó el tiempo de espera para autorizar Spotify.'));
        }, 5 * 60_000);
        server.once('close', () => clearTimeout(timeout));
    });
}
