import { inspectAppUi, useAppUiElement } from './provider.js';

export const defaultUiLimits = Object.freeze({
    maxDepth: 4,
    maxElements: 80,
    maxTextLength: 160,
});

const referenceLifetimeMs = 2 * 60 * 1000;
const maxReferences = 500;
const references = new Map();
let nextReference = 1;

function failure(code, message) {
    return { success: false, error: { code, message } };
}

function boundedInteger(value, fallback, minimum, maximum) {
    return Number.isInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

function cleanName(value, maxLength) {
    return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function createReference(app, windowId, element, now) {
    for (const [ref, entry] of references) {
        if (entry.expiresAt <= now) references.delete(ref);
    }
    const ref = `ui_${nextReference++}`;
    references.set(ref, {
        app,
        windowId,
        locator: element.locator,
        expected: {
            name: element.name ?? '',
            controlType: element.controlType ?? '',
            automationId: element.automationId ?? '',
        },
        expiresAt: now + referenceLifetimeMs,
    });
    while (references.size > maxReferences) references.delete(references.keys().next().value);
    return ref;
}

function publicElement(app, windowId, element, now) {
    return {
        ref: createReference(app, windowId, element, now),
        name: element.name ?? '',
        controlType: element.controlType ?? 'Unknown',
        automationId: element.automationId ?? '',
        enabled: element.enabled === true,
        focusable: element.focusable === true,
        patterns: Array.isArray(element.patterns) ? element.patterns : [],
        sensitivity: element.patterns?.some(pattern => ['Invoke', 'Value'].includes(pattern))
            ? 'may_be_sensitive'
            : 'no_action_pattern',
    };
}

function normalize(value) {
    return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('es');
}

function matches(element, criteria) {
    if (criteria.name && !normalize(element.name).includes(normalize(criteria.name))) return false;
    if (criteria.controlType && normalize(element.controlType) !== normalize(criteria.controlType)) return false;
    if (criteria.automationId && normalize(element.automationId) !== normalize(criteria.automationId)) return false;
    return true;
}

export function createUiAutomation({
    inspect = inspectAppUi,
    useElement = useAppUiElement,
    now = Date.now,
} = {}) {
    async function inspectUi({ args } = {}) {
        const app = typeof args?.app === 'string' ? args.app.trim() : '';
        const maxDepth = boundedInteger(args?.maxDepth, defaultUiLimits.maxDepth, 1, 6);
        const maxElements = boundedInteger(args?.maxElements, defaultUiLimits.maxElements, 1, 150);
        const maxTextLength = boundedInteger(args?.maxTextLength, defaultUiLimits.maxTextLength, 20, 300);
        let result;
        try {
            result = await inspect(app, { maxDepth, maxElements, maxTextLength });
        } catch {
            return failure('ui_automation_unavailable', 'No se pudo inspeccionar la interfaz de la aplicación.');
        }
        if (!result.success) return result;
        const timestamp = now();
        const elements = Array.isArray(result.elements) ? result.elements.slice(0, maxElements) : [];
        return {
            success: true,
            app: result.app ?? app,
            count: elements.length,
            truncated: result.truncated === true || (result.elements?.length ?? 0) > maxElements,
            elements: elements.map(element => publicElement(app, result.windowId, element, timestamp)),
        };
    }

    async function findUiElement({ args } = {}) {
        const app = typeof args?.app === 'string' ? args.app.trim() : '';
        const criteria = {
            name: typeof args?.name === 'string' ? args.name.trim() : '',
            controlType: typeof args?.controlType === 'string' ? args.controlType.trim() : '',
            automationId: typeof args?.automationId === 'string' ? args.automationId.trim() : '',
        };
        if (!criteria.name && !criteria.controlType && !criteria.automationId) {
            return failure('invalid_search', 'Indicá name, controlType o automationId para buscar.');
        }
        let result;
        try {
            result = await inspect(app, defaultUiLimits);
        } catch {
            return failure('ui_automation_unavailable', 'No se pudo buscar en la interfaz de la aplicación.');
        }
        if (!result.success) return result;
        const found = (result.elements ?? []).filter(element => matches(element, criteria));
        if (found.length === 0) return failure('element_not_found', 'No se encontró un control con esos datos.');
        if (found.length > 1) {
            return {
                ...failure('ambiguous_element', 'Hay varios controles coincidentes; agregá más criterios para distinguirlos.'),
                matches: found.slice(0, 10).map(element => ({
                    name: cleanName(element.name, defaultUiLimits.maxTextLength),
                    controlType: element.controlType,
                    automationId: element.automationId,
                })),
            };
        }
        return { success: true, element: publicElement(app, result.windowId, found[0], now()) };
    }

    async function act(ref, operation, value) {
        const saved = references.get(ref);
        if (!saved) return failure('stale_ui_reference', 'La referencia UI no existe o ya venció; inspeccioná la aplicación nuevamente.');
        if (saved.expiresAt <= now()) {
            references.delete(ref);
            return failure('stale_ui_reference', 'La referencia UI venció; inspeccioná la aplicación nuevamente.');
        }
        let result;
        try {
            result = await useElement(saved.app, saved.locator, operation, value, { windowId: saved.windowId, expected: saved.expected });
        } catch {
            return failure('action_failed', 'Windows UI Automation no pudo completar la acción.');
        }
        if (['app_not_running', 'window_not_found'].includes(result.error?.code)) {
            references.delete(ref);
            return failure('stale_ui_reference', 'La aplicación o su ventana cambió; inspeccioná nuevamente.');
        }
        if (result.error?.code === 'stale_ui_reference') references.delete(ref);
        return result;
    }

    return {
        inspectUi,
        findUiElement,
        focusUiElement: ({ args } = {}) => act(args?.ref, 'focus'),
        invokeUiElement: ({ args } = {}) => act(args?.ref, 'invoke'),
        setUiValue: ({ args } = {}) => {
            if (typeof args?.value !== 'string' || args.value.length > 2000) {
                return failure('invalid_value', 'El texto debe tener como máximo 2000 caracteres.');
            }
            return act(args?.ref, 'set_value', args.value);
        },
        getUiValue: async ({ args } = {}) => {
            const result = await act(args?.ref, 'get_value');
            if (result.success && typeof result.value === 'string') {
                return {
                    ...result,
                    value: result.value.slice(0, 1000),
                    truncated: result.truncated === true || result.value.length > 1000,
                };
            }
            return result;
        },
        clearReferences() {
            references.clear();
            nextReference = 1;
        },
    };
}

const uiAutomation = createUiAutomation();
export const inspectUi = uiAutomation.inspectUi;
export const findUiElement = uiAutomation.findUiElement;
export const focusUiElement = uiAutomation.focusUiElement;
export const invokeUiElement = uiAutomation.invokeUiElement;
export const setUiValue = uiAutomation.setUiValue;
export const getUiValue = uiAutomation.getUiValue;
export const clearUiReferences = uiAutomation.clearReferences;
