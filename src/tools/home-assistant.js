import { createHomeAssistantClient, HomeAssistantError } from '../integrations/home-assistant/client.js';

const defaultClient = createHomeAssistantClient();
const HOME_ASSISTANT_TOOL_NAMES = new Set(['home_list_authorized_lights', 'home_get_light_state', 'home_control_light']);

/** Hide conversational HA tools until Main can validate a non-empty persistent authorization Store. */
export function createHomeAssistantToolSelector({ getTools, authorizationProvider } = {}) {
    if (typeof getTools !== 'function' || typeof authorizationProvider !== 'function')
        throw new TypeError('home_assistant_tool_selector_invalid');
    return policy => {
        const definitions = getTools(policy);
        let available = false;
        try {
            const authorization = authorizationProvider();
            available = authorization?.ok === true && Array.isArray(authorization.authorizedLights)
                && authorization.authorizedLights.length > 0;
        } catch { /* An unavailable Store must never expose HA operations to the model. */ }
        return available ? definitions : definitions.filter(tool => !HOME_ASSISTANT_TOOL_NAMES.has(tool.name));
    };
}
const entityIdSchema = { type: 'string', minLength: 0, maxLength: 128,
    description: 'ID autorizado, nombre descriptivo, habitaciÃ³n o alias exacto de home_list_authorized_lights. EnviÃ¡ la referencia del usuario; solo se resuelve si coincide con una luz Ãºnica. Deja vacÃ­o Ãºnicamente para una sola luz autorizada.' };

function functionTool(name, description, properties = {}) {
    const keys = Object.keys(properties);
    return Object.freeze({ type: 'function', name, description, strict: true,
        parameters: Object.freeze({ type: 'object', additionalProperties: false,
            properties: Object.freeze(properties), required: Object.freeze(keys) }) });
}

export const homeListAuthorizedLightsTool = functionTool('home_list_authorized_lights',
    'Lista Ãºnicamente las luces configuradas explÃ­citamente como autorizadas en Nexa, incluyendo su estado y el campo effectList con los efectos disponibles por luz. No descubre ni expone otras entidades de Home Assistant.');
export const homeGetLightStateTool = functionTool('home_get_light_state',
    'Consulta el estado actual de una luz autorizada. Usa el ID, nombre, habitaciÃ³n o alias exacto devuelto por home_list_authorized_lights; una habitaciÃ³n compartida por varias luces requiere aclaraciÃ³n. Si entity_id estÃ¡ vacÃ­o, solo se resuelve automÃ¡ticamente cuando hay exactamente una luz autorizada.',
    { entity_id: entityIdSchema });
export const homeControlLightTool = functionTool('home_control_light',
    'Controla una luz autorizada y consulta su estado despuÃ©s. Usa el ID, nombre, habitaciÃ³n o alias exacto devuelto por home_list_authorized_lights; no elijas arbitrariamente si hay varias coincidencias. Puede encender, apagar, ajustar brillo, color RGB o activar un efecto exacto incluido en el effectList de esa luz. Para usar un efecto, envÃ­alo en effect y deja brightness_pct/rgb_color en null. No inventes ni sustituyas efectos. Solo informa Ã©xito si Home Assistant confirma el resultado; una aceptaciÃ³n HTTP no basta.',
    { entity_id: entityIdSchema,
        action: { type: 'string', enum: ['turn_on', 'turn_off'] },
        brightness_pct: { type: ['integer', 'null'], minimum: 0, maximum: 100 },
        rgb_color: { type: ['array', 'null'], minItems: 3, maxItems: 3,
            items: { type: 'integer', minimum: 0, maximum: 255 } },
        effect: { type: ['string', 'null'], minLength: 1, maxLength: 80,
            description: 'Nombre exacto de un efecto ofrecido por Home Assistant para esta luz, o null si no se solicita un efecto.' } });

function failure(error) {
    const code = error instanceof HomeAssistantError ? error.code : 'home_assistant_request_failed';
    return { success: false, error: { code, message: error instanceof HomeAssistantError
        ? error.message : 'Home Assistant no pudo completar la solicitud.' } };
}

async function resolveEntity(value, client) {
    if (typeof value !== 'string' || value.length > 128)
        throw new HomeAssistantError('home_assistant_arguments_invalid');
    if (typeof client.resolveLightReference === 'function') return client.resolveLightReference(value);
    const configured = client.configuration().entityIds;
    if (configured.includes(value)) return { status: 'resolved', entityId: value };
    if (!value && configured.length === 1) return { status: 'resolved', entityId: configured[0] };
    if (!value && configured.length > 1) return { status: 'ambiguous', candidates: [] };
    if (value.startsWith('light.')) return { status: 'not_authorized' };
    return { status: 'not_found' };
}

function resolutionFailure(resolution) {
    if (resolution.status === 'ambiguous') return { success: false, outcome: 'ambiguous',
        candidates: resolution.candidates ?? [], error: { code: 'home_assistant_entity_ambiguous',
            message: new HomeAssistantError('home_assistant_entity_ambiguous').message } };
    const code = resolution.status === 'not_authorized' ? 'home_assistant_entity_not_authorized'
        : resolution.status === 'not_found' ? 'home_assistant_light_reference_not_found'
            : 'home_assistant_arguments_invalid';
    return failure(new HomeAssistantError(code));
}

function validControlArgs(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)
        || Object.keys(args).some(key => !['entity_id', 'action', 'brightness_pct', 'rgb_color', 'effect'].includes(key))
        || !['turn_on', 'turn_off'].includes(args.action)
        || (args.brightness_pct !== null && (!Number.isInteger(args.brightness_pct)
            || args.brightness_pct < 0 || args.brightness_pct > 100))
        || (args.rgb_color !== null && (!Array.isArray(args.rgb_color) || args.rgb_color.length !== 3
            || args.rgb_color.some(value => !Number.isInteger(value) || value < 0 || value > 255)))
        || (args.effect !== undefined && args.effect !== null
            && (typeof args.effect !== 'string' || args.effect.trim().length === 0 || args.effect.length > 80))
        || (args.action === 'turn_off' && (args.brightness_pct !== null || args.rgb_color !== null || args.effect != null))
        || (args.effect != null && (args.brightness_pct !== null || args.rgb_color !== null))) return false;
    return true;
}

export function createHomeAssistantRegistrations(client = defaultClient) {
    return Object.freeze([
        { definition: homeListAuthorizedLightsTool, execute: async () => {
            try { return { success: true, lights: await client.listAuthorizedLights() }; }
            catch (error) { return failure(error); }
        } },
        { definition: homeGetLightStateTool, execute: async ({ args }) => {
            try {
                if (!args || typeof args !== 'object' || Array.isArray(args)
                    || Object.keys(args).some(key => key !== 'entity_id')) throw new HomeAssistantError('home_assistant_arguments_invalid');
                const resolution = await resolveEntity(args.entity_id, client);
                if (resolution.status !== 'resolved') return resolutionFailure(resolution);
                const state = await client.getEntity(resolution.entityId);
                if (!state.available) return { success: false, outcome: 'device_unavailable', error: {
                    code: 'home_assistant_entity_unavailable', message: 'La luz no estÃ¡ disponible en Home Assistant.' } };
                return { success: true, state };
            } catch (error) { return failure(error); }
        } },
        { definition: homeControlLightTool, execute: async ({ args }) => {
            try {
                if (!validControlArgs(args)) throw new HomeAssistantError('home_assistant_arguments_invalid');
                const resolution = await resolveEntity(args.entity_id, client);
                if (resolution.status !== 'resolved') return resolutionFailure(resolution);
                const result = typeof args.effect === 'string'
                    ? await client.applyLightEffect({ entityId: resolution.entityId, effect: args.effect })
                    : await client.controlLight({ entityId: resolution.entityId, action: args.action,
                        brightnessPct: args.brightness_pct, rgbColor: args.rgb_color });
                if (result.success) return { success: true, outcome: 'confirmed', state: result.state };
                if (result.outcome === 'device_unavailable') return { success: false, outcome: 'device_unavailable',
                    error: { code: 'home_assistant_entity_unavailable', message: 'La luz no estÃ¡ disponible en Home Assistant.' } };
                return { success: false, accepted: true, outcome: 'accepted_not_confirmed',
                    state: result.state, error: { code: result.errorCode ?? 'home_assistant_state_unconfirmed',
                        message: 'Home Assistant aceptÃ³ la solicitud, pero el estado final no confirmÃ³ el cambio.' } };
            } catch (error) { return failure(error); }
        } },
    ]);
}

export const homeAssistantRegistrations = createHomeAssistantRegistrations();
