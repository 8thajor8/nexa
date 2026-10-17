import { pollForConfirmation } from './confirmation-poll.js';

const LIGHT_ID = /^light\.[a-z0-9_]+$/u;
const NUMBER_ID = /^number\.[a-z0-9_]+$/u;
const DEFAULT_TIMEOUT_MS = 5_000;
const SAFE_MESSAGES = Object.freeze({
    home_assistant_not_configured: 'Home Assistant no está configurado.',
    home_assistant_configuration_invalid: 'La configuración de Home Assistant no es válida.',
    home_assistant_timeout: 'Home Assistant tardó demasiado en responder.',
    home_assistant_unavailable: 'No se pudo conectar con Home Assistant.',
    home_assistant_unauthorized: 'Home Assistant rechazó el token configurado.',
    home_assistant_forbidden: 'El token no tiene permiso para consultar esta entidad.',
    home_assistant_response_invalid: 'Home Assistant devolvió una respuesta que Nexa no pudo validar.',
    home_assistant_light_not_authorized: 'Esa luz no está autorizada para Nexa.',
    home_assistant_speed_not_linked: 'Esta luz no tiene un control de velocidad vinculado.',
    home_assistant_speed_link_stale: 'La asociación de velocidad ya no coincide con Home Assistant. Volvé a vincularla.',
    home_assistant_speed_unavailable: 'La velocidad del efecto no está disponible en este momento.',
    home_assistant_speed_value_invalid: 'El valor de velocidad no es válido para esta entidad.',
    home_assistant_request_rejected: 'Home Assistant rechazó la solicitud.',
    home_assistant_request_failed: 'Home Assistant no pudo completar la solicitud.',
});

export class HomeAssistantEffectSpeedError extends Error {
    constructor(code) {
        super(SAFE_MESSAGES[code] ?? SAFE_MESSAGES.home_assistant_request_failed);
        this.name = 'HomeAssistantEffectSpeedError';
        this.code = code;
    }
}

function validRecord(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function numericState(value) {
    if (!value || typeof value !== 'object' || typeof value.state !== 'string'
        || !/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu.test(value.state)) return null;
    const number = Number(value.state);
    return Number.isFinite(number) ? number : null;
}
function finiteAttribute(attributes, key) {
    const value = attributes?.[key];
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

/** Main-only WiZ effect-speed operations. Entity IDs are always resolved from the authorized-light Store. */
export function createHomeAssistantEffectSpeedClient({ environment = process.env, fetchImpl = fetch,
    WebSocketImpl = globalThis.WebSocket, timeoutMs = DEFAULT_TIMEOUT_MS,
    waitImpl = ms => new Promise(resolve => setTimeout(resolve, ms)), nowImpl = () => performance.now(), authorizedLightsProvider,
} = {}) {
    if (typeof fetchImpl !== 'function' || typeof WebSocketImpl !== 'function'
        || typeof authorizedLightsProvider !== 'function' || typeof waitImpl !== 'function' || typeof nowImpl !== 'function')
        throw new TypeError('home_assistant_speed_client_invalid');

    function configuration() {
        const rawUrl = typeof environment.NEXA_HOME_ASSISTANT_URL === 'string' ? environment.NEXA_HOME_ASSISTANT_URL.trim() : '';
        const token = typeof environment.NEXA_HOME_ASSISTANT_TOKEN === 'string' ? environment.NEXA_HOME_ASSISTANT_TOKEN.trim() : '';
        if (!rawUrl || !token) throw new HomeAssistantEffectSpeedError('home_assistant_not_configured');
        let url;
        try { url = new URL(rawUrl); } catch { throw new HomeAssistantEffectSpeedError('home_assistant_configuration_invalid'); }
        if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
            || url.pathname !== '/' || url.search || url.hash || token.length > 4096
            || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000)
            throw new HomeAssistantEffectSpeedError('home_assistant_configuration_invalid');
        const websocketUrl = new URL(url.origin);
        websocketUrl.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        websocketUrl.pathname = '/api/websocket';
        return { origin: url.origin, websocketUrl: websocketUrl.href, token };
    }

    function authorizedLights() {
        let result;
        try { result = authorizedLightsProvider(); } catch { throw new HomeAssistantEffectSpeedError('home_assistant_request_failed'); }
        if (!result || result.ok !== true || !Array.isArray(result.authorizedLights))
            throw new HomeAssistantEffectSpeedError('home_assistant_request_failed');
        return result.authorizedLights.filter(light => validRecord(light) && LIGHT_ID.test(light.entityId));
    }
    function getAuthorizedLight(entityId) {
        if (typeof entityId !== 'string' || !LIGHT_ID.test(entityId))
            throw new HomeAssistantEffectSpeedError('home_assistant_light_not_authorized');
        const light = authorizedLights().find(candidate => candidate.entityId === entityId);
        if (!light) throw new HomeAssistantEffectSpeedError('home_assistant_light_not_authorized');
        return light;
    }

    async function request(path, { method = 'GET', body, timeoutMs: requestTimeoutMs = timeoutMs } = {}) {
        const config = configuration();
        const effectiveTimeoutMs = Math.max(1, Math.min(timeoutMs, Math.floor(requestTimeoutMs)));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
        try {
            const response = await fetchImpl(new URL(path, config.origin), {
                method, redirect: 'error', signal: controller.signal,
                headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json',
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            if (!response || typeof response.ok !== 'boolean') throw new HomeAssistantEffectSpeedError('home_assistant_response_invalid');
            if (!response.ok) {
                const status = response.status;
                throw new HomeAssistantEffectSpeedError(status === 401 ? 'home_assistant_unauthorized'
                    : status === 403 ? 'home_assistant_forbidden'
                        : [400, 404, 422].includes(status) ? 'home_assistant_request_rejected' : 'home_assistant_request_failed');
            }
            try { return await response.json(); }
            catch { throw new HomeAssistantEffectSpeedError('home_assistant_response_invalid'); }
        } catch (error) {
            if (error instanceof HomeAssistantEffectSpeedError) throw error;
            throw new HomeAssistantEffectSpeedError(controller.signal.aborted || error?.name === 'AbortError'
                ? 'home_assistant_timeout' : 'home_assistant_unavailable');
        } finally { clearTimeout(timer); }
    }

    async function registryEntries(entityIds) {
        const config = configuration();
        const ids = [...new Set(entityIds.filter(id => LIGHT_ID.test(id) || NUMBER_ID.test(id)))];
        if (ids.length === 0) return {};
        return new Promise((resolve, reject) => {
            let socket;
            let settled = false;
            let requestSent = false;
            let registryRequestSent = false;
            const commandId = 1;
            const timer = setTimeout(() => finish(new HomeAssistantEffectSpeedError('home_assistant_timeout')), timeoutMs);
            const finish = (error, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { socket?.close(); } catch { /* The request is already complete. */ }
                error ? reject(error) : resolve(value);
            };
            try { socket = new WebSocketImpl(config.websocketUrl); }
            catch { finish(new HomeAssistantEffectSpeedError('home_assistant_unavailable')); return; }
            socket.addEventListener('message', event => {
                if (settled || typeof event.data !== 'string') return finish(new HomeAssistantEffectSpeedError('home_assistant_response_invalid'));
                let message;
                try { message = JSON.parse(event.data); } catch { return finish(new HomeAssistantEffectSpeedError('home_assistant_response_invalid')); }
                if (message?.type === 'auth_required') {
                    if (requestSent) return finish(new HomeAssistantEffectSpeedError('home_assistant_response_invalid'));
                    requestSent = true;
                    try { socket.send(JSON.stringify({ type: 'auth', access_token: config.token })); }
                    catch { finish(new HomeAssistantEffectSpeedError('home_assistant_unavailable')); }
                    return;
                }
                if (message?.type === 'auth_invalid') return finish(new HomeAssistantEffectSpeedError('home_assistant_unauthorized'));
                if (message?.type === 'auth_ok') {
                    if (!requestSent || registryRequestSent) return finish(new HomeAssistantEffectSpeedError('home_assistant_response_invalid'));
                    registryRequestSent = true;
                    try { socket.send(JSON.stringify({ id: commandId, type: 'config/entity_registry/get_entries', entity_ids: ids })); }
                    catch { finish(new HomeAssistantEffectSpeedError('home_assistant_unavailable')); }
                    return;
                }
                if (message?.id !== commandId) return;
                if (message.type === 'result' && message.success === true && validRecord(message.result))
                    return finish(null, message.result);
                if (message.type === 'result' || message.type === 'error')
                    return finish(new HomeAssistantEffectSpeedError(message.error?.code === 'unauthorized'
                        ? 'home_assistant_forbidden' : 'home_assistant_request_rejected'));
                finish(new HomeAssistantEffectSpeedError('home_assistant_response_invalid'));
            });
            socket.addEventListener('error', () => finish(new HomeAssistantEffectSpeedError('home_assistant_unavailable')));
            socket.addEventListener('close', () => {
                if (!settled) finish(new HomeAssistantEffectSpeedError('home_assistant_unavailable'));
            });
        });
    }

    function isSpeedEntry(lightEntry, numberEntry, numberId) {
        return validRecord(lightEntry) && validRecord(numberEntry)
            && lightEntry.entity_id && LIGHT_ID.test(lightEntry.entity_id)
            && lightEntry.platform === 'wiz' && lightEntry.device_id
            && numberEntry.entity_id === numberId && NUMBER_ID.test(numberEntry.entity_id)
            && numberEntry.platform === 'wiz' && numberEntry.translation_key === 'effect_speed'
            && numberEntry.device_id === lightEntry.device_id && numberEntry.device_id !== null
            && numberEntry.disabled_by == null;
    }
    function toSpeedState(light, state, stale = false) {
        const attributes = state?.attributes && validRecord(state.attributes) ? state.attributes : {};
        const value = numericState(state);
        const min = finiteAttribute(attributes, 'min');
        const max = finiteAttribute(attributes, 'max');
        const step = finiteAttribute(attributes, 'step');
        const available = value !== null && state.state !== 'unavailable' && state.state !== 'unknown'
            && min !== null && max !== null && min <= max && (step === null || step > 0);
        return Object.freeze({ lightEntityId: light.entityId, linked: true, available: available && !stale,
            stale, value, min, max, step, entityName: typeof attributes.friendly_name === 'string'
                ? attributes.friendly_name.slice(0, 120) : null, error: null });
    }

    async function readAllStates() {
        const payload = await request('/api/states');
        if (!Array.isArray(payload)) throw new HomeAssistantEffectSpeedError('home_assistant_response_invalid');
        return payload;
    }
    async function discoverEffectSpeedCandidates(lightEntityId) {
        const light = getAuthorizedLight(lightEntityId);
        const states = await readAllStates();
        const numberStates = new Map();
        for (const state of states) {
            const id = state && typeof state.entity_id === 'string' ? state.entity_id : '';
            if (NUMBER_ID.test(id)) numberStates.set(id, state);
        }
        const entries = await registryEntries([light.entityId, ...numberStates.keys()]);
        const lightEntry = entries[light.entityId];
        if (!validRecord(lightEntry) || lightEntry.platform !== 'wiz' || !lightEntry.device_id) return [];
        const candidates = [];
        for (const [id, state] of numberStates) {
            if (!isSpeedEntry(lightEntry, entries[id], id)) continue;
            const attributes = validRecord(state?.attributes) ? state.attributes : {};
            candidates.push(Object.freeze({ entityId: id,
                name: typeof attributes.friendly_name === 'string' ? attributes.friendly_name.slice(0, 120) : 'Velocidad del efecto',
                available: numericState(state) !== null && state.state !== 'unavailable' && state.state !== 'unknown',
                sameDeviceVerified: true }));
        }
        return Object.freeze(candidates);
    }
    async function associationIsCurrent(light, numberId) {
        if (!NUMBER_ID.test(numberId)) return false;
        let currentState;
        try { currentState = await request(`/api/states/${numberId}`); }
        catch (error) {
            if (error instanceof HomeAssistantEffectSpeedError && error.code === 'home_assistant_request_rejected') return false;
            throw error;
        }
        if (!validRecord(currentState) || currentState.entity_id !== numberId) return false;
        const entries = await registryEntries([light.entityId, numberId]);
        return isSpeedEntry(entries[light.entityId], entries[numberId], numberId);
    }
    async function readLinkedState(light, numberId) {
        if (!await associationIsCurrent(light, numberId)) throw new HomeAssistantEffectSpeedError('home_assistant_speed_link_stale');
        const states = await request(`/api/states/${numberId}`);
        if (!validRecord(states) || states.entity_id !== numberId) throw new HomeAssistantEffectSpeedError('home_assistant_response_invalid');
        return toSpeedState(light, states);
    }
    async function getEffectSpeed(lightEntityId) {
        const light = getAuthorizedLight(lightEntityId);
        const numberId = light.effectSpeedEntityId;
        if (typeof numberId !== 'string') return Object.freeze({ lightEntityId, linked: false, available: false,
            stale: false, value: null, min: null, max: null, step: null, entityName: null, error: null });
        try { return await readLinkedState(light, numberId); }
        catch (error) {
            if (error instanceof HomeAssistantEffectSpeedError && error.code === 'home_assistant_speed_link_stale')
                return Object.freeze({ lightEntityId, linked: true, available: false, stale: true,
                    value: null, min: null, max: null, step: null, entityName: null, error: null });
            return Object.freeze({ lightEntityId, linked: true, available: false, stale: false,
                value: null, min: null, max: null, step: null, entityName: null,
                error: error instanceof HomeAssistantEffectSpeedError ? error.code : 'home_assistant_request_failed' });
        }
    }
    async function getAuthorizedEffectSpeeds() {
        return Promise.all(authorizedLights().map(light => getEffectSpeed(light.entityId)));
    }
    function valueIsAligned(value, min, step) {
        if (step === null) return true;
        const units = (value - min) / step;
        return Math.abs(units - Math.round(units)) <= 1e-8;
    }
    async function setEffectSpeed({ lightEntityId, value } = {}) {
        const light = getAuthorizedLight(lightEntityId);
        if (typeof light.effectSpeedEntityId !== 'string') throw new HomeAssistantEffectSpeedError('home_assistant_speed_not_linked');
        const numberId = light.effectSpeedEntityId;
        const state = await readLinkedState(light, numberId);
        if (!state.available) throw new HomeAssistantEffectSpeedError('home_assistant_speed_unavailable');
        if (typeof value !== 'number' || !Number.isFinite(value) || value < state.min || value > state.max
            || !valueIsAligned(value, state.min, state.step))
            throw new HomeAssistantEffectSpeedError('home_assistant_speed_value_invalid');
        const currentAuthorization = getAuthorizedLight(lightEntityId);
        if (currentAuthorization.effectSpeedEntityId !== numberId
            || !await associationIsCurrent(currentAuthorization, numberId))
            throw new HomeAssistantEffectSpeedError('home_assistant_speed_link_stale');
        const latestAuthorization = getAuthorizedLight(lightEntityId);
        if (latestAuthorization.effectSpeedEntityId !== numberId)
            throw new HomeAssistantEffectSpeedError('home_assistant_speed_link_stale');
        await request('/api/services/number/set_value', { method: 'POST', body: { entity_id: numberId, value } });
        const confirms = current => current.available && current.value !== null
            && Math.abs(current.value - value) <= Math.max(1e-8, (state.step ?? 0) * 1e-6);
        const readObservedState = async requestTimeoutMs => {
            const currentLight = getAuthorizedLight(lightEntityId);
            if (currentLight.effectSpeedEntityId !== numberId)
                throw new HomeAssistantEffectSpeedError('home_assistant_speed_link_stale');
            const payload = await request(`/api/states/${numberId}`, { timeoutMs: requestTimeoutMs });
            if (!validRecord(payload) || payload.entity_id !== numberId)
                throw new HomeAssistantEffectSpeedError('home_assistant_response_invalid');
            return toSpeedState(currentLight, payload);
        };
        const observation = await pollForConfirmation({ read: readObservedState, isConfirmed: confirms,
            waitImpl, nowImpl, stopOnError: error => ['home_assistant_unauthorized', 'home_assistant_forbidden',
                'home_assistant_request_rejected', 'home_assistant_speed_link_stale'].includes(error?.code) });
        return Object.freeze({ outcome: observation.confirmed ? 'confirmed' : 'accepted_not_confirmed',
            state: observation.state });
    }

    return Object.freeze({ discoverEffectSpeedCandidates, associationIsCurrent, getEffectSpeed,
        getAuthorizedEffectSpeeds, setEffectSpeed });
}

