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

function writeUiDiagnostic(event, details) {
    if (process.env.NEXA_UI_AUTOMATION_DEBUG !== 'true') return;
    console.debug(`[ui-automation] ${JSON.stringify({ event, ...details })}`);
}

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
    const ref = `ui_${nextReference++}`;
    const locator = element.locator ?? (
        Array.isArray(element.path)
            ? { path: element.path, runtimeId: element.runtimeId, ancestry: element.ancestry ?? [] }
            : null
    );
    references.set(ref, {
        app,
        windowId,
        locator,
        expected: {
            ...(element.identity ?? {}),
            name: element.identity?.name ?? element.name ?? '',
            controlType: element.identity?.controlType ?? element.controlType ?? '',
            automationId: element.identity?.automationId ?? element.automationId ?? '',
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
    logger = writeUiDiagnostic,
} = {}) {
    function diagnostic(event, details = {}) {
        try { logger(event, details); } catch { /* diagnostics never change tool behavior */ }
    }

    async function inspectUi({ args } = {}) {
        const app = typeof args?.app === 'string' ? args.app.trim() : '';
        const maxDepth = boundedInteger(args?.maxDepth, defaultUiLimits.maxDepth, 1, 6);
        const maxElements = boundedInteger(args?.maxElements, defaultUiLimits.maxElements, 1, 150);
        const maxTextLength = boundedInteger(args?.maxTextLength, defaultUiLimits.maxTextLength, 20, 300);
        diagnostic('tool_call', { tool: 'inspect_ui', appProvided: Boolean(app), maxDepth, maxElements });
        let result;
        try {
            result = await inspect(app, { maxDepth, maxElements, maxTextLength });
        } catch {
            return failure('ui_automation_unavailable', 'No se pudo inspeccionar la interfaz de la aplicación.');
        }
        if (!result?.success) {
            diagnostic('tool_result', { tool: 'inspect_ui', success: false, code: result?.error?.code ?? 'ui_automation_unavailable' });
            return result ?? failure('ui_automation_unavailable', 'No se pudo inspeccionar la interfaz de la aplicación.');
        }
        const timestamp = now();
        const elements = Array.isArray(result.elements) ? result.elements.slice(0, maxElements) : [];
        const output = {
            success: true,
            app: result.app ?? app,
            count: elements.length,
            truncated: result.truncated === true || (result.elements?.length ?? 0) > maxElements,
            elements: elements.map(element => publicElement(app, result.windowId, element, timestamp)),
        };
        diagnostic('references_created', { tool: 'inspect_ui', count: output.count });
        diagnostic('tool_result', { tool: 'inspect_ui', success: true, count: output.count });
        return output;
    }

    async function findUiElement({ args } = {}) {
        const app = typeof args?.app === 'string' ? args.app.trim() : '';
        const criteria = {
            name: typeof args?.name === 'string' ? args.name.trim() : '',
            controlType: typeof args?.controlType === 'string' ? args.controlType.trim() : '',
            automationId: typeof args?.automationId === 'string' ? args.automationId.trim() : '',
        };
        diagnostic('tool_call', {
            tool: 'find_ui_element',
            appProvided: Boolean(app),
            criteriaCount: Object.values(criteria).filter(Boolean).length,
        });
        if (!criteria.name && !criteria.controlType && !criteria.automationId) {
            diagnostic('tool_result', { tool: 'find_ui_element', success: false, code: 'invalid_search' });
            return failure('invalid_search', 'Indicá name, controlType o automationId para buscar.');
        }
        let result;
        try {
            result = await inspect(app, defaultUiLimits);
        } catch {
            return failure('ui_automation_unavailable', 'No se pudo buscar en la interfaz de la aplicación.');
        }
        if (!result?.success) {
            diagnostic('tool_result', { tool: 'find_ui_element', success: false, code: result?.error?.code ?? 'ui_automation_unavailable' });
            return result ?? failure('ui_automation_unavailable', 'No se pudo buscar en la interfaz de la aplicación.');
        }
        const found = (result.elements ?? []).filter(element => matches(element, criteria));
        if (found.length === 0) {
            diagnostic('tool_result', { tool: 'find_ui_element', success: false, code: 'element_not_found' });
            return failure('element_not_found', 'No se encontró un control con esos datos.');
        }
        if (found.length > 1) {
            diagnostic('tool_result', { tool: 'find_ui_element', success: false, code: 'ambiguous_element', matches: found.length });
            return {
                ...failure('ambiguous_element', 'Hay varios controles coincidentes; agregá más criterios para distinguirlos.'),
                matches: found.slice(0, 10).map(element => ({
                    name: cleanName(element.name, defaultUiLimits.maxTextLength),
                    controlType: element.controlType,
                    automationId: element.automationId,
                })),
            };
        }
        const element = publicElement(app, result.windowId, found[0], now());
        diagnostic('reference_created', { tool: 'find_ui_element', ref: element.ref });
        diagnostic('tool_result', { tool: 'find_ui_element', success: true, count: 1 });
        return { success: true, element };
    }

    async function act(ref, operation, value) {
        const saved = references.get(ref);
        if (!saved) {
            diagnostic('reference_invalidated', { ref, operation, reason: 'reference_missing_or_evicted' });
            return failure('stale_ui_reference', 'La referencia UI no existe o ya venció; inspeccioná la aplicación nuevamente.');
        }
        if (saved.expiresAt <= now()) {
            references.delete(ref);
            diagnostic('reference_invalidated', { ref, operation, reason: 'reference_expired' });
            return { ...failure('stale_ui_reference', 'La referencia UI venció; inspeccioná la aplicación nuevamente.'), reason: 'reference_expired' };
        }
        const toolName = {
            focus: 'focus_ui_element',
            invoke: 'invoke_ui_element',
            set_value: 'set_ui_value',
            get_value: 'get_ui_value',
        }[operation];
        diagnostic('tool_call', { tool: toolName, operation, ref, ...(typeof value === 'string' ? { valueLength: value.length } : {}) });
        diagnostic('reference_reused', { ref, operation });
        let result;
        try {
            result = await useElement(saved.app, saved.locator, operation, value, { windowId: saved.windowId, expected: saved.expected });
        } catch {
            return failure('action_failed', 'Windows UI Automation no pudo completar la acción.');
        }
        if (!result) result = failure('action_failed', 'Windows UI Automation no devolvió un resultado.');
        if (['app_not_running', 'window_not_found', 'ambiguous_window', 'app_not_found'].includes(result.error?.code)) {
            references.delete(ref);
            const reason = result.error.code === 'app_not_running' ? 'app_not_running' : 're_resolution_failed';
            diagnostic('reference_invalidated', { ref, operation, reason });
            return { ...failure('stale_ui_reference', 'La aplicación o su ventana cambió; inspeccioná nuevamente.'), reason };
        }
        if (result.error?.code === 'stale_ui_reference') {
            references.delete(ref);
            diagnostic('reference_invalidated', { ref, operation, reason: result.reason ?? 'element_disappeared' });
        }
        diagnostic('tool_result', { tool: toolName, success: result.success === true, code: result.error?.code ?? null, operation });
        return result;
    }

    return {
        inspectUi,
        findUiElement,
        focusUiElement: ({ args } = {}) => act(args?.ref, 'focus'),
        invokeUiElement: ({ args } = {}) => act(args?.ref, 'invoke'),
        setUiValue: ({ args } = {}) => {
            if (typeof args?.value !== 'string' || args.value.length > 2000) {
                diagnostic('tool_call', { tool: 'set_ui_value', ref: args?.ref, valueLength: typeof args?.value === 'string' ? args.value.length : null });
                diagnostic('tool_result', { tool: 'set_ui_value', success: false, code: 'invalid_value' });
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
