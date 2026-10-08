import { screenMemorySecret } from '../secret-screening.js';
import { AUTOMATIC_MEMORY_MAX_INPUT_CHARS } from './schema.js';

export const AUTOMATIC_MEMORY_CONSENT_POLICY_VERSION = 'automatic-memory-c4-v1';
export const AUTOMATIC_MEMORY_ASSESSMENT_TIMEOUT_MS = 5000;

const excluded = Object.freeze([
    ['user_requested_message_exclusion', /^\s*(?:nexa,\s*)?no\s+aprendas\s+de\s+este\s+mensaje[.!]?(?:\s*[:—-]\s*[\s\S]*)?\s*$/iu],
    ['credential', /\b(?:contrase(?:ñ|n)a|clave(?:\s+(?:api|secreta|de\s+acceso))?|token(?:\s+de\s+(?:acceso|recuperaci[oó]n))?|c[oó]digo\s+2fa)\s*[:=]\s*\S+/iu],
    ['financial_credential', /\b(?:(?:credit|debit|cr[eé]dito|d[eé]bito)\s+card|tarjeta\s+(?:de\s+)?(?:cr[eé]dito|d[eé]bito))\b.{0,32}\b(?:number|no\.?|#|n[uú]mero)?\s*[:=]?\s*(?:\d[ -]?){13,19}\b|\b(?:pin|cvv|cvc)\s*[:=]?\s*\d{3,8}\b/iu],
    ['identity_document', /\b(?:passport|pasaporte|dni|nie|ssn|social\s+security\s+number|national\s+id|identity\s+(?:document|number)|documento\s+de\s+identidad)\b/iu],
    ['location_or_movement', /\b(?:home\s+address|street\s+address|direcci[oó]n|domicilio|ubicaci[oó]n|location|coordenadas|gps|postal\s+code|c[oó]digo\s+postal|coordinates|my\s+commute|daily\s+route|mi\s+ruta|desplazamiento|commute|travel|viaj[oa]s?|viajamos|de\s+viaje|horario\s+de\s+viaje|vivo\s+en|live\s+at)\b/iu],
    ['temporary_or_ephemeral', /\b(?:temporarily|temporary|for\s+now|just\s+for\s+today|today|this\s+week|currently|right\s+now|just\s+now|today\s+only|this\s+week\s+only|por\s+ahora|ahora\s+mismo|en\s+este\s+momento|hoy|esta\s+semana|temporalmente|solo\s+por\s+(?:hoy|esta\s+semana)|solo\s+esta\s+semana|de\s+momento)\b/iu],
    ['quoted_or_imported', /(?:["“”«»]|```|^\s*>|\b(?:quoted\s+from|copied\s+from|the\s+email\s+says|someone\s+wrote|imported\s+from|citado\s+de|copiado\s+de|el\s+correo\s+dice|alguien\s+escribi[oó])\b)/imu],
    ['question_or_hypothetical', /[¿?]|\b(?:what\s+if|suppose|hypothetically|imagine|qu[eé]\s+pasar[ií]a\s+si|supongamos|hipot[eé]ticamente|imagina)\b/iu],
    ['protected_professional_or_patient_data', /\b(?:patient\s+(?:record|data|file)|medical\s+record|expediente\s+(?:m[eé]dico|del\s+paciente)|datos\s+del\s+paciente|secreto\s+profesional|professional\s+secret|attorney[- ]client|client\s+confidential|trade\s+secret)\b/iu],
    ['instruction_injection', /\b(?:ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions|reveal\s+(?:the\s+)?system\s+prompt|bypass\s+(?:the\s+)?safety|ignora\s+(?:todas\s+)?(?:las\s+)?instrucciones|revela\s+(?:el\s+)?prompt\s+del\s+sistema|omite\s+(?:las\s+)?protecciones)\b/iu],
]);

/** Preflight only: returns fixed reason codes and never echoes input text. */
export function screenAutomaticMemoryTurn(text) {
    if (typeof text !== 'string' || !text.isWellFormed() || text.length === 0
        || text.length > AUTOMATIC_MEMORY_MAX_INPUT_CHARS) {
        return { eligible: false, reason: 'turn_invalid_or_out_of_bounds' };
    }
    try {
        const secret = screenMemorySecret(text);
        if (!secret.safe) return { eligible: false, reason: 'excluded_credential' };
        for (const [reason, pattern] of excluded) {
            if (pattern.test(text)) return { eligible: false, reason: `excluded_${reason}` };
        }
        if (!text.trim() || /^(?:ok(?:ay)?|thanks?|thank\s+you|gracias|vale|de\s+acuerdo)[.!\s]*$/iu.test(text.trim()))
            return { eligible: false, reason: 'not_memory_worthy_cue' };
        return { eligible: true, reason: null };
    } catch {
        return { eligible: false, reason: 'preflight_failed' };
    }
}

/** Session-only, descriptive consent record. It grants no persistence permission. */
export function createAutomaticMemorySessionConsent({ sessionId, consentId, grantedAt = new Date().toISOString() } = {}) {
    if (typeof sessionId !== 'string' || !sessionId || typeof consentId !== 'string' || !consentId
        || typeof grantedAt !== 'string' || !Number.isFinite(Date.parse(grantedAt))) return null;
    return Object.freeze({
        consentId,
        sessionId,
        grantedAt,
        policyVersion: AUTOMATIC_MEMORY_CONSENT_POLICY_VERSION,
        purpose: 'assess_future_direct_user_turns_for_possible_memory_candidates',
        scope: 'future_direct_user_turns_in_this_runtime_session',
        externalProcessing: 'may_be_sent_to_openai_if_an_extractor_is_explicitly_composed',
        exclusions: Object.freeze(['credentials', 'financial_credentials', 'identity_documents',
            'location_and_movement', 'temporary_or_ephemeral', 'quoted_or_imported',
            'patient_or_professional_secrets', 'ambiguous_preflight']),
        allowedAssessmentCategories: Object.freeze(['health', 'personal_finance', 'relationships',
            'legal_and_migration', 'work_and_projects', 'emotionally_sensitive_context', 'general_third_party_context']),
        sensitivePersistence: 'requires_independent_confirmation',
        grantsMemoryWrite: false,
    });
}

export function isCurrentAutomaticMemoryConsent(consent, sessionId) {
    if (!consent || consent.policyVersion !== AUTOMATIC_MEMORY_CONSENT_POLICY_VERSION
        || consent.grantsMemoryWrite !== false
        || consent.purpose !== 'assess_future_direct_user_turns_for_possible_memory_candidates') return false;
    if (consent.scope === 'future_direct_user_turns_across_runtime_sessions')
        return typeof consent.consentId === 'string' && typeof consent.grantedAt === 'string';
    return consent.sessionId === sessionId && consent.scope === 'future_direct_user_turns_in_this_runtime_session';
}
