import { createHash, randomUUID } from 'node:crypto';
import { screenMemorySecret } from '../secret-screening.js';

export const AUTOMATIC_MEMORY_POLICY_VERSION = 'automatic-memory-a1';
export const AUTOMATIC_MEMORY_MAX_INPUT_CHARS = 16000;
export const AUTOMATIC_MEMORY_MAX_CANDIDATES = 12;

const enums = Object.freeze({
    candidateType: ['fact', 'preference', 'decision', 'tool', 'purchase', 'hobby', 'professional', 'language', 'learning_activity', 'long_term_goal', 'relationship', 'situation', 'other'],
    durability: ['durable', 'temporary', 'ephemeral', 'unknown'],
    assertionMode: ['asserted', 'hypothetical', 'negated', 'question', 'conditional', 'quoted_or_imported', 'inferred', 'unknown'],
    updateIntent: ['new_fact', 'possible_correction', 'possible_supersession', 'addition', 'relation', 'unknown'],
    sensitivity: ['none', 'health', 'finance', 'precise_location', 'identity_document', 'intimate', 'minor',
        'political', 'religious', 'biometric', 'credential', 'other_sensitive', 'unknown'],
    disposition: ['auto_save', 'ask', 'ignore'],
    temporalCertainty: ['explicit', 'uncertain', 'none'],
});

// Model labels are semantic hints, not persisted predicates. Only these closed
// category-to-predicate mappings can reach policy evaluation.
const PREDICATE_BY_TYPE = Object.freeze({
    preference: 'user.preference', decision: 'project.decision', tool: 'user.uses_tool',
    purchase: 'user.owns_item', hobby: 'user.hobby', professional: 'user.professional_context',
    language: 'user.speaks_language', learning_activity: 'user.learning_activity', long_term_goal: 'user.long_term_goal',
    situation: 'user.situation', relationship: 'user.relationship',
});
const PREDICATE_HINTS = Object.freeze({
    preference: /^(?:user\.preference|prefer(?:s|red)?(?:_[a-z0-9]+)*|prefier(?:o|e|en|imos)(?:_[a-z0-9]+)*|preferred(?:_[a-z0-9]+)*|unidad_preferida(?:_[a-z0-9]+)*)$/u,
    decision: /^(?:project\.decision|decision(?:_[a-z0-9]+)*|decide[ds]?(?:_[a-z0-9]+)*|decidi(?:o|mos)?(?:_[a-z0-9]+)*|elegimos(?:_[a-z0-9]+)*)$/u,
    tool: /^(?:user\.uses_tool|use[sd]?(?:_[a-z0-9]+)*|usage(?:_[a-z0-9]+)*|uso(?:_[a-z0-9]+)*|usa(?:_[a-z0-9]+)*|utiliza(?:_[a-z0-9]+)*)$/u,
    purchase: /^(?:user\.owns_item|own[sed]?(?:_[a-z0-9]+)*|bought(?:_[a-z0-9]+)*|purchase(?:_[a-z0-9]+)*|tiene(?:_[a-z0-9]+)*|compro(?:_[a-z0-9]+)*|adquiri(?:o|do)?(?:_[a-z0-9]+)*|posee(?:_[a-z0-9]+)*)$/u,
    hobby: /^(?:user\.hobby|hobby(?:_[a-z0-9]+)*|enjoys?(?:_[a-z0-9]+)*|practices?(?:_[a-z0-9]+)*|pasatiempo(?:_[a-z0-9]+)*|aficion(?:_[a-z0-9]+)*)$/u,
    professional: /^(?:user\.professional_context|professional(?:_context)?(?:_[a-z0-9]+)*|works?(?:_[a-z0-9]+)*|trabaja(?:_[a-z0-9]+)*|profesion(?:_[a-z0-9]+)*)$/u,
    situation: /^(?:user\.situation|situation(?:_[a-z0-9]+)*|lives?(?:_[a-z0-9]+)*|resides?(?:_[a-z0-9]+)*|vive(?:_[a-z0-9]+)*|reside(?:_[a-z0-9]+)*)$/u,
    language: /^(?:user\.speaks_language|language|speaks?|habla|hablo|idioma)$/u,
    learning_activity: /^(?:user\.learning_activity|learning(?:_activity)?|learn(?:s|ing|ed)?(?:_[a-z0-9]+)*|aprendizaje|aprend(?:e|iendo|i[oó])(?:_[a-z0-9]+)*)$/u,
    long_term_goal: /^(?:user\.long_term_goal|long_?term_?goal|goal|goals|meta(?:s)?|objetivo(?:s)?(?:_a_largo_plazo)?)$/u,
    relationship: /^(?:user\.relationship|partner_of|sibling_of|brother_of|sister_of|friend_of|colleague_of|relationship|relaci[oó]n|herman[oa]|amig[oa]|compañer[oa]|pareja)$/u,
});
const PREDICATE_LABELS = Object.freeze([
    'user.preference', 'prefer', 'prefers', 'preferred', 'prefers_response_length_for_simple_questions',
    'unidad_preferida_para_distancias', 'prefiere', 'prefieren', 'prefiero', 'preferimos',
    'project.decision', 'decision', 'decide', 'decides', 'decided', 'decidio', 'decidimos', 'elegimos',
    'user.uses_tool', 'use', 'uses', 'used', 'usage', 'uso', 'usa', 'utiliza',
    'user.owns_item', 'own', 'owns', 'owned', 'bought', 'purchase', 'tiene', 'compro', 'adquiri', 'adquirio', 'adquirido', 'posee',
    'user.hobby', 'hobby', 'enjoy', 'enjoys', 'practice', 'practices', 'pasatiempo', 'aficion',
    'user.professional_context', 'professional', 'professional_context', 'work', 'works', 'trabaja', 'profesion',
    'user.speaks_language', 'language', 'speaks', 'speak', 'habla', 'hablo', 'idioma',
    'user.learning_activity', 'learning', 'learning_activity', 'learn', 'learns', 'aprendizaje', 'aprende', 'aprendiendo',
    'user.long_term_goal', 'long_term_goal', 'goal', 'goals', 'meta', 'metas', 'objetivo', 'objetivos',
    'user.situation', 'situation', 'live', 'lives', 'reside', 'resides', 'vive',
    'user.relationship', 'partner_of', 'sibling_of', 'brother_of', 'sister_of', 'friend_of', 'colleague_of',
    'relationship', 'relación', 'hermano', 'hermana', 'amigo', 'amiga', 'compañero', 'compañera', 'pareja', 'user.note',
]);

const nullableString = { anyOf: [{ type: 'string', maxLength: 300 }, { type: 'null' }] };
const candidateSchema = {
    type: 'object', additionalProperties: false,
    required: ['candidate_type', 'subject_text', 'predicate', 'value_text', 'mentioned_person_text',
        'durability', 'linguistic_confidence', 'assertion_mode', 'temporal_hints', 'update_intent',
        'sensitivity', 'suggested_disposition', 'evidence_quote'],
    properties: {
        candidate_type: { type: 'string', enum: enums.candidateType,
            description: 'learning_activity means only explicitly stated current study; it does not imply mastery or a human language ability. long_term_goal means only an explicit goal. Both always require review.' },
        subject_text: { ...nullableString, description: 'Use exactly "user" only for an explicit first-person fact about the speaker; null if the subject is not explicit. Use a textual name for another person or exact project/workstream phrase from evidence, never an entity ID.' },
        predicate: { type: 'string', enum: PREDICATE_LABELS,
            description: 'Controlled semantic label only. The local validator maps compatible labels to canonical A1 predicates; do not invent a predicate. user.learning_activity and user.long_term_goal are review-only.' },
        value_text: { type: 'string', minLength: 1, maxLength: 2000 },
        mentioned_person_text: nullableString,
        durability: { type: 'string', enum: enums.durability },
        linguistic_confidence: { type: 'number', minimum: 0, maximum: 1 },
        assertion_mode: { type: 'string', enum: enums.assertionMode },
        temporal_hints: {
            type: 'object', additionalProperties: false, required: ['raw_text', 'certainty'],
            properties: { raw_text: nullableString, certainty: { type: 'string', enum: enums.temporalCertainty } },
        },
        update_intent: { type: 'string', enum: enums.updateIntent },
        sensitivity: { type: 'string', enum: enums.sensitivity },
        suggested_disposition: { type: 'string', enum: enums.disposition },
        evidence_quote: { type: 'string', minLength: 1, maxLength: 1200 },
    },
};

function freezeDeep(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const item of Object.values(value)) freezeDeep(item);
    return Object.freeze(value);
}

export const AUTOMATIC_MEMORY_OUTPUT_SCHEMA = freezeDeep({
    type: 'object', additionalProperties: false, required: ['candidates'],
    properties: { candidates: { type: 'array', maxItems: AUTOMATIC_MEMORY_MAX_CANDIDATES, items: candidateSchema } },
});

function isRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Reflect.ownKeys(value).every(key => typeof key === 'string'
        && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
}
function exactKeys(value, keys) {
    return isRecord(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function boundedText(value, max, { nullable = false, empty = false } = {}) {
    return (nullable && value === null) || (typeof value === 'string' && value.isWellFormed()
        && [...value].length <= max && (empty || value.length > 0));
}
function oneOf(value, options) { return options.includes(value); }
function reason(code) { return { success: false, error: { code, message: 'Automatic Memory proposal was rejected.' } }; }

/** Parses and validates only the model-owned proposal shape. It creates no trusted metadata. */
export function parseAutomaticMemoryProposal(value) {
    let proposal = value;
    if (typeof value === 'string') {
        try { proposal = JSON.parse(value); } catch { return reason('candidate_output_invalid'); }
    }
    if (!exactKeys(proposal, ['candidates']) || !Array.isArray(proposal.candidates)
        || Object.getPrototypeOf(proposal.candidates) !== Array.prototype
        || proposal.candidates.length > AUTOMATIC_MEMORY_MAX_CANDIDATES) return reason('candidate_output_invalid');
    const fields = ['candidate_type', 'subject_text', 'predicate', 'value_text', 'mentioned_person_text',
        'durability', 'linguistic_confidence', 'assertion_mode', 'temporal_hints', 'update_intent',
        'sensitivity', 'suggested_disposition', 'evidence_quote'];
    for (const item of proposal.candidates) {
        if (!exactKeys(item, fields) || !oneOf(item.candidate_type, enums.candidateType)
            || !boundedText(item.subject_text, 300, { nullable: true })
            || !oneOf(item.predicate, PREDICATE_LABELS)
            || !boundedText(item.value_text, 2000) || !boundedText(item.mentioned_person_text, 300, { nullable: true })
            || !oneOf(item.durability, enums.durability)
            || typeof item.linguistic_confidence !== 'number' || !Number.isFinite(item.linguistic_confidence)
            || item.linguistic_confidence < 0 || item.linguistic_confidence > 1
            || !oneOf(item.assertion_mode, enums.assertionMode)
            || !exactKeys(item.temporal_hints, ['raw_text', 'certainty'])
            || !boundedText(item.temporal_hints.raw_text, 300, { nullable: true })
            || !oneOf(item.temporal_hints.certainty, enums.temporalCertainty)
            || !oneOf(item.update_intent, enums.updateIntent)
            || !oneOf(item.sensitivity, enums.sensitivity)
            || !oneOf(item.suggested_disposition, enums.disposition)
            || !boundedText(item.evidence_quote, 1200)) return reason('candidate_output_invalid');
    }
    return { success: true, proposal: structuredClone(proposal) };
}

/** Maps a controlled semantic category plus a compatible label to its one canonical policy predicate. */
export function normalizeAutomaticMemoryProposal(value) {
    const parsed = parseAutomaticMemoryProposal(value);
    if (!parsed.success) return parsed;
    const normalization = [];
    const candidates = [];
    for (let index = 0; index < parsed.proposal.candidates.length; index++) {
        const candidate = parsed.proposal.candidates[index];
        const pattern = PREDICATE_HINTS[candidate.candidate_type];
        if (!pattern) {
            candidates.push(candidate);
            normalization.push({ candidateIndex: index, status: 'unsupported_category', canonicalPredicate: null });
            continue;
        }
        const canonicalPredicate = pattern.test(candidate.predicate) ? PREDICATE_BY_TYPE[candidate.candidate_type] : null;
        if (!canonicalPredicate) {
            return { success: false, error: { code: 'candidate_normalization_failed', message: 'Candidate category or predicate could not be normalized.' },
                normalization: [...normalization, { candidateIndex: index, status: 'unsupported', canonicalPredicate: null }] };
        }
        candidates.push({ ...candidate, predicate: canonicalPredicate });
        normalization.push({ candidateIndex: index,
            status: candidate.predicate === canonicalPredicate ? 'canonical' : 'mapped', canonicalPredicate });
    }
    return { success: true, proposal: { candidates }, normalization };
}

function occurrences(text, fragment) {
    let count = 0, first = -1, from = 0;
    while ((from = text.indexOf(fragment, from)) !== -1) {
        if (first === -1) first = from;
        count++;
        from += 1;
        if (count > 1) break;
    }
    return { count, start: first, end: first < 0 ? -1 : first + fragment.length };
}

function likelyQuotedOrImported(text, span) {
    const quote = text.slice(span.start, span.end);
    const surrounding = text.slice(Math.max(0, span.start - 240), Math.min(text.length, span.end + 240));
    const explicitQuote = /^\s*[>"“”‘’]/u.test(quote) || /["“”‘’]\s*$/u.test(quote);
    const externalCue = /\b(?:email|e-mail|correo|mensaje|web|website|sitio|p[aá]gina|herramienta|tool|documento|archivo|import|copi[ée]|cita|quoted|says|dice|escribe)\b/iu.test(surrounding);
    const attributedToolSource = /\b(?:crm|herramienta|tool)\s+(?:indica|dice|muestra|reporta|says|states|reports|shows)\b/iu.test(surrounding);
    return explicitQuote || externalCue || attributedToolSource;
}

/** Verifies exact quotes and attaches dry-run metadata generated by this module. */
export function validateAutomaticMemoryCandidates(proposal, sourceText) {
    if (typeof sourceText !== 'string' || !sourceText.isWellFormed() || sourceText.length > AUTOMATIC_MEMORY_MAX_INPUT_CHARS)
        return reason('candidate_input_invalid');
    const parsed = parseAutomaticMemoryProposal(proposal);
    if (!parsed.success) return parsed;
    const textHash = createHash('sha256').update(sourceText).digest('hex');
    const runtime = { turnId: `dryrun_${randomUUID()}`, sourceTextSha256: textHash,
        sourceClass: 'dry_run_input', policyVersion: AUTOMATIC_MEMORY_POLICY_VERSION };
    const candidates = parsed.proposal.candidates.map((candidate, index) => {
        const span = occurrences(sourceText, candidate.evidence_quote);
        const secret = screenMemorySecret(JSON.stringify(candidate));
        const sourceSecret = screenMemorySecret(candidate.evidence_quote);
        return {
            index,
            proposal: secret.safe && sourceSecret.safe ? candidate : null,
            redacted: !secret.safe || !sourceSecret.safe,
            evidence: span.count === 1 ? { verified: true, start: span.start, end: span.end,
                quotedOrImported: likelyQuotedOrImported(sourceText, span) } : {
                verified: false, start: null, end: null, quotedOrImported: false,
            },
            runtime: structuredClone(runtime),
            validationCode: span.count === 0 ? 'evidence_span_missing' : span.count > 1 ? 'evidence_span_ambiguous' : null,
            secretDetected: !secret.safe || !sourceSecret.safe,
        };
    });
    return { success: true, runtime, candidates };
}
