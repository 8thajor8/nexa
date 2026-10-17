import { pollForConfirmation } from './confirmation-poll.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_LIGHTS = 32;
const ENTITY_ID_PATTERN = /^light\.[a-z0-9_]+$/u;
const COLOR_MODES = new Set(['hs', 'xy', 'rgb', 'rgbw', 'rgbww']);
const SAFE_MESSAGES = Object.freeze({
    home_assistant_not_configured: 'Configurá NEXA_HOME_ASSISTANT_URL, NEXA_HOME_ASSISTANT_TOKEN y NEXA_HOME_ASSISTANT_LIGHTS en el entorno local de Nexa.',
    home_assistant_configuration_invalid: 'La configuración de Home Assistant no es válida.',
    home_assistant_timeout: 'Home Assistant tardó demasiado en responder.',
    home_assistant_unavailable: 'No se pudo conectar con Home Assistant.',
    home_assistant_unauthorized: 'Home Assistant rechazó el token configurado.',
    home_assistant_forbidden: 'El token no tiene permiso para consultar o controlar esta entidad.',
    home_assistant_entity_not_found: 'Home Assistant no encontró la entidad de luz autorizada.',
    home_assistant_request_rejected: 'Home Assistant rechazó la solicitud.',
    home_assistant_request_failed: 'Home Assistant no pudo completar la solicitud.',
    home_assistant_response_invalid: 'Home Assistant devolvió un estado que Nexa no pudo validar.',
    home_assistant_entity_unavailable: 'La luz no está disponible en Home Assistant.',
    home_assistant_entity_not_authorized: 'Esa entidad no está autorizada para Nexa.',
    home_assistant_entity_ambiguous: 'Hay varias luces autorizadas; indicá cuál querés usar.',
    home_assistant_no_authorized_lights: 'No hay luces autorizadas configuradas para Nexa.',
    home_assistant_authorization_store_unavailable: 'No se pudo validar el registro de luces autorizadas de Nexa.',
    home_assistant_brightness_unsupported: 'Esta luz no informa soporte para ajustar el brillo.',
    home_assistant_color_unsupported: 'Esta luz no informa soporte para cambiar el color.',
    home_assistant_effect_not_supported: 'Esta luz no informa que el efecto solicitado sea compatible.',
    home_assistant_arguments_invalid: 'Los parámetros para controlar la luz no son válidos.',
});

export class HomeAssistantError extends Error {
    constructor(code) {
        super(SAFE_MESSAGES[code] ?? SAFE_MESSAGES.home_assistant_request_failed);
        this.name = 'HomeAssistantError';
        this.code = code;
    }
}

function parseConfiguration(environment, timeoutMs, authorizedLightsProvider = null) {
    const configuredUrl = typeof environment.NEXA_HOME_ASSISTANT_URL === 'string'
        ? environment.NEXA_HOME_ASSISTANT_URL.trim() : '';
    const token = typeof environment.NEXA_HOME_ASSISTANT_TOKEN === 'string'
        ? environment.NEXA_HOME_ASSISTANT_TOKEN.trim() : '';
    if (!configuredUrl || !token) throw new HomeAssistantError('home_assistant_not_configured');
    let configuredLights;
    let rawMetadata;
    if (authorizedLightsProvider !== null) {
        let authorization;
        try { authorization = authorizedLightsProvider(); }
        catch { throw new HomeAssistantError('home_assistant_authorization_store_unavailable'); }
        if (!authorization || authorization.ok !== true || !Array.isArray(authorization.authorizedLights))
            throw new HomeAssistantError('home_assistant_authorization_store_unavailable');
        configuredLights = authorization.authorizedLights.map(light => light && typeof light === 'object'
            ? light.entityId : null);
        // The persistent authorization record may include technical associations (for example,
        // the optional WiZ effect-speed entity). Those are not light metadata and must not be
        // passed through the strict metadata validator below.
        rawMetadata = JSON.stringify(authorization.authorizedLights.map(light => {
            if (!light || typeof light !== 'object' || Array.isArray(light)) return light;
            const { effectSpeedEntityId: _effectSpeedEntityId, ...metadata } = light;
            return metadata;
        }));
        if (configuredLights.length === 0) throw new HomeAssistantError('home_assistant_no_authorized_lights');
    } else {
        configuredLights = typeof environment.NEXA_HOME_ASSISTANT_LIGHTS === 'string'
            ? environment.NEXA_HOME_ASSISTANT_LIGHTS.split(',').map(value => value.trim()).filter(Boolean) : [];
        rawMetadata = environment.NEXA_HOME_ASSISTANT_LIGHT_METADATA;
        if (configuredLights.length === 0) throw new HomeAssistantError('home_assistant_not_configured');
    }
    let baseUrl;
    try { baseUrl = new URL(configuredUrl); } catch { throw new HomeAssistantError('home_assistant_configuration_invalid'); }
    if (!['http:', 'https:'].includes(baseUrl.protocol) || !baseUrl.hostname || baseUrl.username || baseUrl.password
        || baseUrl.search || baseUrl.hash || baseUrl.pathname !== '/' || token.length > 4096
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000
        || configuredLights.length > MAX_LIGHTS || configuredLights.some(id => !ENTITY_ID_PATTERN.test(id))
        || new Set(configuredLights).size !== configuredLights.length) {
        throw new HomeAssistantError('home_assistant_configuration_invalid');
    }
    let lightMetadata = [];
    rawMetadata = typeof rawMetadata === 'string' ? rawMetadata.trim() : '';
    if (rawMetadata) {
        try { lightMetadata = JSON.parse(rawMetadata); }
        catch { throw new HomeAssistantError('home_assistant_configuration_invalid'); }
        if (!Array.isArray(lightMetadata) || lightMetadata.length > configuredLights.length)
            throw new HomeAssistantError('home_assistant_configuration_invalid');
        const seenEntities = new Set();
        lightMetadata = lightMetadata.map(item => {
            if (!item || typeof item !== 'object' || Array.isArray(item)
                || Object.keys(item).some(key => !['entityId', 'name', 'area', 'aliases'].includes(key))
                || typeof item.entityId !== 'string' || !configuredLights.includes(item.entityId)
                || seenEntities.has(item.entityId))
                throw new HomeAssistantError('home_assistant_configuration_invalid');
            seenEntities.add(item.entityId);
            const cleanOptionalText = (value, maxLength) => {
                if (value === undefined) return null;
                if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength)
                    throw new HomeAssistantError('home_assistant_configuration_invalid');
                return value.trim();
            };
            const name = cleanOptionalText(item.name, 120);
            const area = cleanOptionalText(item.area, 80);
            const aliases = item.aliases === undefined ? [] : item.aliases;
            if (!Array.isArray(aliases) || aliases.length > 16
                || aliases.some(alias => typeof alias !== 'string' || !alias.trim() || alias.trim().length > 80))
                throw new HomeAssistantError('home_assistant_configuration_invalid');
            return Object.freeze({ entityId: item.entityId, name, area,
                aliases: Object.freeze(aliases.map(alias => alias.trim())) });
        });
    }
    return Object.freeze({ origin: baseUrl.origin, token, entityIds: Object.freeze(configuredLights),
        lightMetadata: Object.freeze(lightMetadata) });
}

function safeEntityState(value, expectedEntityId) {
    if (!value || typeof value !== 'object' || value.entity_id !== expectedEntityId
        || typeof value.state !== 'string' || !['on', 'off', 'unavailable', 'unknown'].includes(value.state)) return null;
    const attributes = value.attributes && typeof value.attributes === 'object' ? value.attributes : {};
    const supportedColorModes = Array.isArray(attributes.supported_color_modes)
        ? attributes.supported_color_modes.filter(mode => typeof mode === 'string' && mode.length <= 32).slice(0, 16) : [];
    const rgbColor = Array.isArray(attributes.rgb_color) && attributes.rgb_color.length === 3
        && attributes.rgb_color.every(channel => Number.isInteger(channel) && channel >= 0 && channel <= 255)
        ? attributes.rgb_color : null;
    const rgbwColor = Array.isArray(attributes.rgbw_color) && attributes.rgbw_color.length === 4
        && attributes.rgbw_color.every(channel => Number.isInteger(channel) && channel >= 0 && channel <= 255)
        ? attributes.rgbw_color : null;
    const effectList = Array.isArray(attributes.effect_list)
        ? [...new Set(attributes.effect_list.filter(effect => typeof effect === 'string' && effect.trim().length > 0
            && effect.trim().length <= 80).map(effect => effect.trim()))].slice(0, 32) : [];
    const effect = typeof attributes.effect === 'string' && attributes.effect.trim().length > 0
        && attributes.effect.trim().length <= 80 ? attributes.effect.trim() : null;
    const kelvin = Number.isInteger(attributes.color_temp_kelvin) && attributes.color_temp_kelvin >= 1000
        && attributes.color_temp_kelvin <= 40_000 ? attributes.color_temp_kelvin
        : Number.isInteger(attributes.color_temp) && attributes.color_temp > 0
            ? Math.round(1_000_000 / attributes.color_temp) : null;
    return Object.freeze({
        entityId: expectedEntityId,
        name: typeof attributes.friendly_name === 'string' && attributes.friendly_name.trim()
            ? attributes.friendly_name.trim().slice(0, 120) : expectedEntityId,
        state: value.state,
        available: value.state === 'on' || value.state === 'off',
        brightness: Number.isInteger(attributes.brightness) && attributes.brightness >= 0 && attributes.brightness <= 255
            ? attributes.brightness : null,
        rgbColor,
        rgbwColor,
        colorTemperatureKelvin: kelvin,
        effect,
        effectList: Object.freeze(effectList),
        supportedColorModes: Object.freeze(supportedColorModes),
        supportsBrightness: Number.isInteger(attributes.brightness) || supportedColorModes.some(mode => mode !== 'onoff'),
        supportsColor: supportedColorModes.some(mode => COLOR_MODES.has(mode)),
    });
}

function normalizeLightReference(value) {
    return value.normalize('NFKD').replace(/\p{M}/gu, '').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function enrichLightState(state, entityId, config) {
    const metadata = config.lightMetadata.find(item => item.entityId === entityId);
    return Object.freeze({ ...state, friendlyName: state.name, name: metadata?.name ?? state.name,
        area: metadata?.area ?? null, aliases: metadata?.aliases ?? Object.freeze([]) });
}

function safeLightCandidate(light) {
    return Object.freeze({ entityId: light.entityId, name: light.name,
        friendlyName: light.friendlyName ?? light.name, area: light.area ?? null, aliases: light.aliases ?? Object.freeze([]) });
}

function apiError(status) {
    if (status === 401) return 'home_assistant_unauthorized';
    if (status === 403) return 'home_assistant_forbidden';
    if (status === 404) return 'home_assistant_entity_not_found';
    if ([400, 422].includes(status)) return 'home_assistant_request_rejected';
    return 'home_assistant_request_failed';
}

export function createHomeAssistantClient({ environment = process.env, fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS, waitImpl = ms => new Promise(resolve => setTimeout(resolve, ms)),
    nowImpl = () => performance.now(),
    authorizedLightsProvider = null } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('home_assistant_fetch_invalid');
    if (typeof waitImpl !== 'function' || typeof nowImpl !== 'function') throw new TypeError('home_assistant_wait_invalid');
    if (authorizedLightsProvider !== null && typeof authorizedLightsProvider !== 'function')
        throw new TypeError('home_assistant_authorization_provider_invalid');
    function configuration() { return parseConfiguration(environment, timeoutMs, authorizedLightsProvider); }

    async function request(path, { method = 'GET', body, parseJson = true, timeoutMs: requestTimeoutMs = timeoutMs } = {}) {
        const config = configuration();
        const effectiveTimeoutMs = Math.max(1, Math.min(timeoutMs, Math.floor(requestTimeoutMs)));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
        try {
            const response = await fetchImpl(new URL(`/api${path}`, config.origin), {
                method, redirect: 'error', headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json',
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal,
            });
            if (!response || typeof response.ok !== 'boolean') throw new HomeAssistantError('home_assistant_response_invalid');
            if (!response.ok) throw new HomeAssistantError(apiError(response.status));
            if (!parseJson) return response;
            try { return await response.json(); } catch { throw new HomeAssistantError('home_assistant_response_invalid'); }
        } catch (error) {
            if (error instanceof HomeAssistantError) throw error;
            throw new HomeAssistantError(controller.signal.aborted || error?.name === 'AbortError'
                || error?.name === 'TimeoutError' ? 'home_assistant_timeout' : 'home_assistant_unavailable');
        } finally { clearTimeout(timer); }
    }

    async function getEntity(entityId, { timeoutMs: requestTimeoutMs = timeoutMs } = {}) {
        const config = configuration();
        if (!config.entityIds.includes(entityId)) throw new HomeAssistantError('home_assistant_entity_not_authorized');
        const payload = await request(`/states/${encodeURIComponent(entityId)}`, { timeoutMs: requestTimeoutMs });
        const state = safeEntityState(payload, entityId);
        if (!state) throw new HomeAssistantError('home_assistant_response_invalid');
        return state;
    }

    async function listAuthorizedLights() {
        const config = configuration();
        const lights = [];
        for (const entityId of config.entityIds) {
            try { lights.push(enrichLightState(await getEntity(entityId), entityId, config)); }
            catch (error) {
                if (error?.code === 'home_assistant_entity_not_found') {
                    lights.push(enrichLightState(Object.freeze({ entityId, name: entityId, state: 'unavailable', available: false,
                        brightness: null, rgbColor: null, supportedColorModes: Object.freeze([]),
                        supportsBrightness: false, supportsColor: false }), entityId, config));
                } else if (lights.length === 0) throw error;
                else lights.push(enrichLightState(Object.freeze({ entityId, name: entityId, state: 'unavailable', available: false,
                    brightness: null, rgbColor: null, supportedColorModes: Object.freeze([]),
                    supportsBrightness: false, supportsColor: false }), entityId, config));
            }
        }
        return Object.freeze(lights);
    }

    async function resolveLightReference(reference) {
        const config = configuration();
        if (typeof reference !== 'string' || reference.length > 128)
            return Object.freeze({ status: 'invalid' });
        if (config.entityIds.includes(reference)) return Object.freeze({ status: 'resolved', entityId: reference });
        if (ENTITY_ID_PATTERN.test(reference)) return Object.freeze({ status: 'not_authorized' });
        const normalized = normalizeLightReference(reference);
        if (!normalized) {
            if (config.entityIds.length === 1)
                return Object.freeze({ status: 'resolved', entityId: config.entityIds[0] });
            const lights = await listAuthorizedLights();
            return Object.freeze({ status: 'ambiguous', candidates: Object.freeze(lights.map(safeLightCandidate)) });
        }
        const lights = await listAuthorizedLights();
        const matches = lights.filter(light => [light.entityId, light.name, light.friendlyName, light.area,
            ...light.aliases].some(value => typeof value === 'string' && normalizeLightReference(value) === normalized));
        if (matches.length === 1) return Object.freeze({ status: 'resolved', entityId: matches[0].entityId });
        if (matches.length > 1)
            return Object.freeze({ status: 'ambiguous', candidates: Object.freeze(matches.map(safeLightCandidate)) });
        return Object.freeze({ status: 'not_found' });
    }

    async function controlLight({ entityId, action, brightnessPct = null, rgbColor = null } = {}) {
        const config = configuration();
        if (!config.entityIds.includes(entityId)) throw new HomeAssistantError('home_assistant_entity_not_authorized');
        const before = await getEntity(entityId);
        if (!before.available) throw new HomeAssistantError('home_assistant_entity_unavailable');
        if (brightnessPct !== null && !before.supportsBrightness)
            throw new HomeAssistantError('home_assistant_brightness_unsupported');
        if (rgbColor !== null && !before.supportsColor) throw new HomeAssistantError('home_assistant_color_unsupported');
        const turnOffForZeroBrightness = action === 'turn_on' && brightnessPct === 0 && rgbColor === null;
        const service = action === 'turn_off' || turnOffForZeroBrightness ? 'turn_off' : 'turn_on';
        // Re-read authorization immediately before the physical service request.
        if (!configuration().entityIds.includes(entityId))
            throw new HomeAssistantError('home_assistant_entity_not_authorized');
        const serviceData = { entity_id: entityId };
        if (service === 'turn_on' && brightnessPct !== null) serviceData.brightness_pct = brightnessPct;
        if (service === 'turn_on' && rgbColor !== null) serviceData.rgb_color = rgbColor;
        await request(`/services/light/${service}`, { method: 'POST', body: serviceData, parseJson: false });
        const expectedState = service === 'turn_on' ? 'on' : 'off';
        const confirmsRequest = after => {
            let confirmed = after.available && after.state === expectedState;
            if (confirmed && service === 'turn_on' && brightnessPct !== null && brightnessPct > 0) {
                const expectedBrightness = Math.round(brightnessPct * 255 / 100);
                confirmed = after.brightness !== null && Math.abs(after.brightness - expectedBrightness) <= 3;
            }
            if (confirmed && service === 'turn_on' && rgbColor !== null)
                confirmed = after.rgbColor !== null
                    && rgbColor.every((channel, index) => Math.abs(after.rgbColor[index] - channel) <= 3);
            return confirmed;
        };
        const observation = await pollForConfirmation({ read: requestTimeoutMs => getEntity(entityId, { timeoutMs: requestTimeoutMs }),
            isConfirmed: confirmsRequest, waitImpl, nowImpl,
            stopOnError: error => ['home_assistant_unauthorized', 'home_assistant_forbidden',
                'home_assistant_request_rejected', 'home_assistant_entity_not_found'].includes(error?.code) });
        if (observation.confirmed)
            return Object.freeze({ success: true, outcome: 'confirmed', state: observation.state, service });
        const error = observation.error;
        if (error?.code === 'home_assistant_entity_not_found' || error?.code === 'home_assistant_entity_unavailable')
            return Object.freeze({ success: false, outcome: 'device_unavailable', state: null, service });
        return Object.freeze({ success: false, outcome: 'accepted_not_confirmed', state: observation.state, service,
            ...(error ? { errorCode: error?.code ?? 'home_assistant_request_failed' } : {}) });
    }
    async function applyLightEffect({ entityId, effect } = {}) {
        const config = configuration();
        if (!config.entityIds.includes(entityId)) throw new HomeAssistantError('home_assistant_entity_not_authorized');
        if (typeof effect !== 'string' || effect.trim().length === 0 || effect.length > 80)
            throw new HomeAssistantError('home_assistant_arguments_invalid');
        const before = await getEntity(entityId);
        if (!before.available) throw new HomeAssistantError('home_assistant_entity_unavailable');
        if (!before.effectList.includes(effect)) throw new HomeAssistantError('home_assistant_effect_not_supported');
        if (!configuration().entityIds.includes(entityId))
            throw new HomeAssistantError('home_assistant_entity_not_authorized');
        await request('/services/light/turn_on', { method: 'POST', body: { entity_id: entityId, effect }, parseJson: false });
        const confirmed = state => state.available && state.effect === effect;
        const observation = await pollForConfirmation({ read: requestTimeoutMs => getEntity(entityId, { timeoutMs: requestTimeoutMs }),
            isConfirmed: confirmed, waitImpl, nowImpl,
            stopOnError: error => ['home_assistant_unauthorized', 'home_assistant_forbidden',
                'home_assistant_request_rejected', 'home_assistant_entity_not_found'].includes(error?.code) });
        if (observation.confirmed)
            return Object.freeze({ success: true, outcome: 'confirmed', state: observation.state, service: 'turn_on' });
        const error = observation.error;
        if (error?.code === 'home_assistant_entity_not_found' || error?.code === 'home_assistant_entity_unavailable')
            return Object.freeze({ success: false, outcome: 'device_unavailable', state: null, service: 'turn_on' });
        return Object.freeze({ success: false, outcome: 'accepted_not_confirmed', state: observation.state, service: 'turn_on',
            ...(error ? { errorCode: error?.code ?? 'home_assistant_request_failed' } : {}) });
    }
    return Object.freeze({ configuration, listAuthorizedLights, getEntity, resolveLightReference, controlLight, applyLightEffect });
}

/** Read-only discovery for the Main-process device administration flow. */
export function createHomeAssistantDiscoveryClient({ environment = process.env, fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('home_assistant_fetch_invalid');
    function connection() {
        const configuredUrl = typeof environment.NEXA_HOME_ASSISTANT_URL === 'string'
            ? environment.NEXA_HOME_ASSISTANT_URL.trim() : '';
        const token = typeof environment.NEXA_HOME_ASSISTANT_TOKEN === 'string'
            ? environment.NEXA_HOME_ASSISTANT_TOKEN.trim() : '';
        if (!configuredUrl || !token) throw new HomeAssistantError('home_assistant_not_configured');
        let baseUrl;
        try { baseUrl = new URL(configuredUrl); } catch { throw new HomeAssistantError('home_assistant_configuration_invalid'); }
        if (!['http:', 'https:'].includes(baseUrl.protocol) || !baseUrl.hostname || baseUrl.username || baseUrl.password
            || baseUrl.search || baseUrl.hash || baseUrl.pathname !== '/' || token.length > 4096
            || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000)
            throw new HomeAssistantError('home_assistant_configuration_invalid');
        return { origin: baseUrl.origin, token };
    }
    async function discoverLights() {
        const config = connection();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImpl(new URL('/api/states', config.origin), {
                method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
                signal: controller.signal,
            });
            if (!response || typeof response.ok !== 'boolean') throw new HomeAssistantError('home_assistant_response_invalid');
            if (!response.ok) throw new HomeAssistantError(apiError(response.status));
            let payload;
            try { payload = await response.json(); } catch { throw new HomeAssistantError('home_assistant_response_invalid'); }
            if (!Array.isArray(payload)) throw new HomeAssistantError('home_assistant_response_invalid');

            const lights = [];
            for (const value of payload) {
                const entityId = value && typeof value === 'object' && typeof value.entity_id === 'string'
                    ? value.entity_id : '';
                if (!ENTITY_ID_PATTERN.test(entityId)) continue;
                const state = safeEntityState(value, entityId);
                if (!state) continue;
                lights.push(Object.freeze({ entityId, name: state.name, state: state.state,
                    available: state.available,
                    capabilities: Object.freeze({ brightness: state.supportsBrightness, color: state.supportsColor }) }));
            }
            return Object.freeze(lights);
        } catch (error) {
            if (error instanceof HomeAssistantError) throw error;
            throw new HomeAssistantError(controller.signal.aborted || error?.name === 'AbortError'
                || error?.name === 'TimeoutError' ? 'home_assistant_timeout' : 'home_assistant_unavailable');
        } finally { clearTimeout(timer); }
    }
    return Object.freeze({ discoverLights });
}

export const homeAssistantSafeMessages = SAFE_MESSAGES;

