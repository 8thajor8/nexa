const API_ROOT = '/api/v1/nexa';
const REQUEST_TIMEOUT_MS = 10_000;
const TEXT_FILTER_LIMITS = Object.freeze({ patient_name: 140, insurance_name: 140,
    external_insurance_reference: 45, service_name: 140, provider_name: 140 });
const DATE_FILTERS = Object.freeze(['attention_date_from', 'attention_date_to', 'created_date_from', 'created_date_to']);
const MESSAGES = Object.freeze({
    lifeguard_not_configured: 'Lifeguard no está configurado en este entorno.',
    lifeguard_authentication_failed: 'Lifeguard rechazó la credencial configurada.',
    lifeguard_permission_denied: 'La credencial no tiene permiso de lectura CRM.',
    incident_not_found: 'No se encontró una incidencia con esa referencia.',
    ambiguous: 'La referencia corresponde a más de una incidencia; requiere revisión en Lifeguard.',
    lifeguard_rate_limited: 'Lifeguard alcanzó su límite de solicitudes. Probá más tarde.',
    lifeguard_timeout: 'Lifeguard tardó demasiado en responder.',
    lifeguard_network_error: 'No se pudo conectar con Lifeguard.',
    lifeguard_service_unavailable: 'Lifeguard no está disponible en este momento.',
    lifeguard_request_invalid: 'Lifeguard rechazó los filtros de la solicitud.',
    lifeguard_response_invalid: 'Lifeguard devolvió una respuesta que Nexa no pudo validar.',
    lifeguard_request_failed: 'Lifeguard no pudo completar la solicitud.',
});

export class LifeguardError extends Error {
    constructor(code, retryAfter) {
        super(MESSAGES[code] ?? MESSAGES.lifeguard_request_failed);
        this.name = 'LifeguardError';
        this.code = code;
        if (Number.isInteger(retryAfter)) this.retryAfter = retryAfter;
    }
}

function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
    const [y, m, d] = value.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
function day(value) { const [y, m, d] = value.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; }

export function validateLifeguardSearch(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const allowed = new Set(['incident_reference', 'case_reference', 'limit', ...Object.keys(TEXT_FILTER_LIMITS), ...DATE_FILTERS]);
    if (Object.keys(input).some(key => !allowed.has(key))) return null;
    const filters = {};
    const limit = input.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) return null;
    for (const [key, prefix] of [['incident_reference', 'IN'], ['case_reference', 'LG']]) {
        if (input[key] == null) continue;
        if (typeof input[key] !== 'string' || !new RegExp(`^${prefix}-[0-9]{4,7}$`, 'u').test(input[key])) return null;
        filters[key] = input[key];
    }
    for (const [key, max] of Object.entries(TEXT_FILTER_LIMITS)) {
        if (input[key] == null) continue;
        if (typeof input[key] !== 'string') return null;
        const value = input[key].trim();
        if ([...value].length < 3 || [...value].length > max || /[\u0000-\u001f\u007f]/u.test(value)
            || (value.match(/[\p{L}\p{N}]/gu) ?? []).length < 3) return null;
        filters[key] = value;
    }
    for (const key of DATE_FILTERS) {
        if (input[key] == null) continue;
        if (!validDate(input[key])) return null;
        filters[key] = input[key];
    }
    if (!Object.keys(filters).length) return null;
    const dateOnly = Object.keys(filters).every(key => DATE_FILTERS.includes(key));
    for (const key of ['attention_date', 'created_date']) {
        const from = filters[`${key}_from`], to = filters[`${key}_to`];
        if ((from === undefined) !== (to === undefined)) return null;
        if (from !== undefined) { const days = day(to) - day(from) + 1; if (days < 1 || days > (dateOnly ? 31 : 366)) return null; }
    }
    return { ...filters, limit };
}

function text(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function date(value) { return validDate(value) ? value : null; }
function presentIncident(value) {
    if (!value || typeof value !== 'object' || typeof value.reference !== 'string' || typeof value.cancelled !== 'boolean') return null;
    const obj = x => x && typeof x === 'object' ? x : {};
    const service = obj(value.service), provider = obj(value.provider), status = obj(value.status);
    const patient = obj(value.patient), insurance = obj(value.insurance), caseInfo = obj(value.case);
    return { reference: value.reference, attention_date: date(value.attention_date), created_date: date(value.created_date),
        service: { name: text(service.name) }, cancelled: value.cancelled, provider: { name: text(provider.name) },
        status: { gop: text(status.gop), medical_report: text(status.medical_report), billing: text(status.billing) },
        patient: { display_name: text(patient.display_name) },
        insurance: { name: text(insurance.name), external_reference: text(insurance.external_reference) },
        case: { reference: text(caseInfo.reference), status: text(caseInfo.status) } };
}
function presentSearch(payload) {
    const data = payload?.data;
    if (payload?.success !== true || !data || !Array.isArray(data.results) || !Number.isInteger(data.limit)
        || typeof data.has_more !== 'boolean' || data.limit < 1 || data.limit > 20 || data.results.length > 20) return null;
    const results = data.results.map(presentIncident);
    return results.some(item => item === null) ? null : { results, limit: data.limit, has_more: data.has_more };
}

export class LifeguardClient {
    constructor({ environment = process.env, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
        this.environment = environment; this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs;
    }
    configuration() {
        const baseUrl = this.environment.LIFEGUARD_API_BASE_URL?.trim();
        const token = this.environment.LIFEGUARD_API_TOKEN?.trim();
        if (!baseUrl || !token) throw new LifeguardError('lifeguard_not_configured');
        let parsed;
        try { parsed = new URL(baseUrl); } catch { throw new LifeguardError('lifeguard_not_configured'); }
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash
            || !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60000)
            throw new LifeguardError('lifeguard_not_configured');
        return { origin: parsed.origin, basePath: parsed.pathname.replace(/\/$/u, ''), token };
    }
    async request(path, { method, body } = {}) {
        const config = this.configuration();
        const url = new URL(`${config.basePath}${API_ROOT}${path}`, config.origin);
        let response;
        try {
            response = await this.fetchImpl(url, { method, redirect: 'error', headers: { Authorization: `Bearer ${config.token}`,
                Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
                ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(this.timeoutMs) });
        } catch (error) {
            throw new LifeguardError(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'lifeguard_timeout' : 'lifeguard_network_error');
        }
        if (response.status === 401) throw new LifeguardError('lifeguard_authentication_failed');
        if (response.status === 403) throw new LifeguardError('lifeguard_permission_denied');
        if (response.status === 404) throw new LifeguardError('incident_not_found');
        if (response.status === 409) throw new LifeguardError('ambiguous');
        if (response.status === 429) {
            const retry = Number(response.headers?.get?.('retry-after'));
            throw new LifeguardError('lifeguard_rate_limited', Number.isFinite(retry) ? retry : undefined);
        }
        if ([400, 413, 415].includes(response.status)) throw new LifeguardError('lifeguard_request_invalid');
        if (response.status === 503 || response.status >= 500) throw new LifeguardError('lifeguard_service_unavailable');
        if (!response.ok) throw new LifeguardError('lifeguard_request_failed');
        try { return await response.json(); } catch { throw new LifeguardError('lifeguard_response_invalid'); }
    }
    async search(input) {
        const filters = validateLifeguardSearch(input);
        if (!filters) return { success: false, error: { code: 'lifeguard_filters_invalid', message: 'Los filtros de búsqueda no son válidos.' } };
        try {
            const payload = await this.request('/incidents/search', { method: 'POST', body: filters });
            const data = presentSearch(payload);
            return data ? { success: true, source: 'api:lifeguard', externalDataUntrusted: true, ...data }
                : { success: false, error: { code: 'lifeguard_response_invalid', message: MESSAGES.lifeguard_response_invalid } };
        } catch (error) { return failure(error); }
    }
    async read(reference) {
        if (typeof reference !== 'string' || !/^IN-[0-9]{4,7}$/u.test(reference))
            return { success: false, error: { code: 'lifeguard_reference_invalid', message: 'La referencia debe tener el formato IN- y 4 a 7 dígitos.' } };
        try {
            const payload = await this.request(`/incidents/${encodeURIComponent(reference)}`, { method: 'GET' });
            const data = payload?.success === true ? presentIncident(payload?.data?.incident) : null;
            return data ? { success: true, source: 'api:lifeguard', externalDataUntrusted: true, incident: data }
                : { success: false, error: { code: 'lifeguard_response_invalid', message: MESSAGES.lifeguard_response_invalid } };
        } catch (error) { return failure(error); }
    }
}
function failure(error) {
    const code = error instanceof LifeguardError ? error.code : 'lifeguard_request_failed';
    return { success: false, error: { code, message: MESSAGES[code] ?? MESSAGES.lifeguard_request_failed },
        ...(Number.isInteger(error?.retryAfter) ? { retryAfter: error.retryAfter } : {}) };
}
export const lifeguardClient = new LifeguardClient();
