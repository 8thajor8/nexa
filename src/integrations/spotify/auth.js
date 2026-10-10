import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSpotifyTokens, saveSpotifyTokens } from './token-store.js';

export const spotifyScopes = Object.freeze([
    'user-read-playback-state',
    'user-read-currently-playing',
    'user-modify-playback-state',
]);

export const defaultSpotifyRedirectUri = 'http://127.0.0.1:8888/callback';
const authorizeEndpoint = 'https://accounts.spotify.com/authorize';
const tokenEndpoint = 'https://accounts.spotify.com/api/token';
let activeAuthorizationFlow = null;
let spotifyEnvironmentLoad;

async function ensureSpotifyEnvironment(environment) {
    if (environment !== process.env) return environment;
    if (!spotifyEnvironmentLoad) {
        const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
        spotifyEnvironmentLoad = import('dotenv').then(({ config: loadDotenv }) => {
            loadDotenv({ path: path.join(projectRoot, '.env'), override: false, quiet: true });
        }).catch(() => {});
    }
    await spotifyEnvironmentLoad;
    return environment;
}

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
    await ensureSpotifyEnvironment(environment);
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
    await ensureSpotifyEnvironment(environment);
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
        await ensureSpotifyEnvironment(environment);
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

/** Start one loopback PKCE flow. The returned URL is generated for this flow;
 * completion contains token data for trusted process code only. */
export async function startSpotifyAuthorizationFlow({ environment = process.env, fetchImpl = fetch,
    tokenStore = { save: saveSpotifyTokens }, signal } = {}) {
    await ensureSpotifyEnvironment(environment);
    const { clientId, redirectUri } = getSpotifyConfiguration(environment);
    const authorization = createSpotifyAuthorizationUrl({ clientId, redirectUri });
    const callback = new URL(redirectUri);
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('spotify_authorization_signal_invalid');
    if (signal?.aborted) throw new SpotifyAuthError('spotify_authorization_cancelled', 'La autorización de Spotify fue cancelada.');
    if (activeAuthorizationFlow) throw new SpotifyAuthError('spotify_authorization_in_progress', 'Ya hay una autorización de Spotify en curso.');

    const owner = {};
    activeAuthorizationFlow = owner;
    let server;
    let timeout;
    let started = false;
    let settled = false;
    let callbackProcessing = false;
    let resolveCompletion;
    let rejectCompletion;
    const completion = new Promise((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
    });
    // A caller may cancel before awaiting completion. Keep that rejection
    // handled while preserving the original promise for the caller.
    completion.catch(() => {});

    const result = await new Promise((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
        };
        const release = () => {
            if (activeAuthorizationFlow === owner) activeAuthorizationFlow = null;
        };
        const finish = (error, value) => {
            if (settled) return false;
            settled = true;
            cleanup();
            const complete = () => {
                release();
                if (error) rejectCompletion(error);
                else resolveCompletion(value);
            };
            if (started) server.close(complete);
            else complete();
            return true;
        };
        const failToStart = error => {
            cleanup();
            if (server?.listening) server.close();
            release();
            reject(error);
        };
        const onAbort = () => {
            if (settled || callbackProcessing) return false;
            const error = new SpotifyAuthError('spotify_authorization_cancelled', 'La autorización de Spotify fue cancelada.');
            if (started) finish(error);
            else failToStart(error);
            return true;
        };

        server = createServer(async (request, response) => {
            const requestUrl = new URL(request.url, redirectUri);
            if (requestUrl.pathname !== callback.pathname) {
                response.writeHead(404).end('Not found');
                return;
            }
            if (settled || callbackProcessing) {
                response.writeHead(409).end('Authorization flow is no longer active.');
                return;
            }
            if (requestUrl.searchParams.get('state') !== authorization.state) {
                response.writeHead(400).end('State validation failed.');
                finish(new SpotifyAuthError('spotify_state_mismatch', 'Spotify devolvió un estado OAuth inválido.'));
                return;
            }
            const providerError = requestUrl.searchParams.get('error');
            if (providerError) {
                response.writeHead(400).end('Spotify authorization was cancelled.');
                finish(new SpotifyAuthError('spotify_authorization_denied', 'La autorización de Spotify fue cancelada o denegada.'));
                return;
            }
            const code = requestUrl.searchParams.get('code');
            if (!code) {
                response.writeHead(400).end('Spotify authorization was cancelled.');
                finish(new SpotifyAuthError('spotify_authorization_denied', 'La autorización de Spotify fue cancelada o denegada.'));
                return;
            }
            callbackProcessing = true;
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
                finish(null, tokens);
            } catch (error) {
                response.writeHead(500).end('No se pudo completar Spotify OAuth. Revisá la terminal de Nexa.');
                finish(error);
            }
        });
        server.once('error', () => {
            const error = new SpotifyAuthError('spotify_callback_unavailable', 'No se pudo abrir el callback local 127.0.0.1:8888.');
            if (started) finish(error);
            else failToStart(error);
        });
        server.listen(Number(callback.port), '127.0.0.1', () => {
            started = true;
            timeout = setTimeout(() => finish(new SpotifyAuthError('spotify_authorization_timeout', 'Se agotó el tiempo de espera para autorizar Spotify.')),
                5 * 60_000);
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) onAbort();
            else resolve({ authorizationUrl: authorization.url, completion, cancel: onAbort });
        });
    });
    return result;
}

export async function authorizeSpotify({ environment = process.env, fetchImpl = fetch,
    tokenStore = { save: saveSpotifyTokens }, output = console.log } = {}) {
    const flow = await startSpotifyAuthorizationFlow({ environment, fetchImpl, tokenStore });
    output(`Abrí este enlace para autorizar Nexa con Spotify:\n${flow.authorizationUrl}`);
    return flow.completion;
}
