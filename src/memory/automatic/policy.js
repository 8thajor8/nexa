import { createHash } from 'node:crypto';
import { resolveEntityMentions, retrieveCandidates } from '../retrieval.js';
import { validateMemoryStore } from '../schema.js';
import { AUTOMATIC_MEMORY_POLICY_VERSION, parseAutomaticMemoryProposal } from './schema.js';
import { screenMemorySecret } from '../secret-screening.js';
import { consumeTrustedSpeakerIdentity, trustedSpeakerIdentityDetails } from '../../core/trusted-speaker-identity.js';

const AUTO_PREDICATES = Object.freeze({
    preference: new Set(['user.preference']),
    decision: new Set(['project.decision']),
    tool: new Set(['user.uses_tool']),
    purchase: new Set(['user.owns_item']),
    hobby: new Set(['user.hobby']),
    professional: new Set(['user.professional_context']),
    language: new Set(['user.speaks_language']),
    situation: new Set(['user.situation']),
    relationship: new Set(['user.relationship']),
});
const REVIEW_ONLY_PREDICATES = Object.freeze({
    learning_activity: new Set(['user.learning_activity']),
    long_term_goal: new Set(['user.long_term_goal']),
});

const SENSITIVE_PATTERNS = Object.freeze([
    ['health', /\b(?:diagnosis|diagnosed|illness|disease|medication|medicine|therapy|depression|anxiety|pregnant|pregnancy|migraine|diabetes|asthma|salud|diagn[oó]stico|enfermedad|medicaci[oó]n|terapia|depresi[oó]n|ansiedad|embarazad[oa]|migrañas?|diabetes|asma|tratamiento|s[ií]ntoma)\b/iu],
    ['finance', /\b(?:salary|income|debt|loan|bank account|credit card|mortgage|net worth|sueldo|salario|ingresos?|deuda|pr[eé]stamo|hipoteca|cuenta bancaria|tarjeta de cr[eé]dito|patrimonio|inversi[oó]n)\b/iu],
    ['precise_location', /\b(?:street address|home address|coordinates|gps|street|avenue|apartment number|direcci[oó]n exacta|coordenadas|calle|avenida|n[uú]mero de portal|piso|c[oó]digo postal)\b/iu],
    ['identity_document', /\b(?:passport|national id|identity card|social security number|ssn|dni|nie|pasaporte|documento de identidad|n[uú]mero de identificaci[oó]n)\b/iu],
    ['intimate', /\b(?:sex life|sexual orientation|sexually active|vida sexual|orientaci[oó]n sexual|relaci[oó]n [ií]ntima)\b/iu],
    ['minor', /\b(?:my child|my son|my daughter|minor|school of my child|mi hijo|mi hija|menor|colegio de mi)\b/iu],
    ['political', /\b(?:political party|political affiliation|partido(?:\s+pol[ií]tico)?|afiliaci[oó]n pol[ií]tica)\b/iu],
    ['religious', /\b(?:religion|religious belief|faith|religi[oó]n|creencia religiosa|fe)\b/iu],
    ['biometric', /\b(?:fingerprint|face scan|voiceprint|retina scan|huella dactilar|esc[aá]ner facial|voz biom[eé]trica|retina)\b/iu],
]);

// These are model-produced role labels only. They identify Self only when a
// validated snapshot supplies the structural owner person; text alone is never identity.
const SELF_ROLE_LABELS = new Set(['user', 'self', 'i', 'me', 'my', 'mine', 'myself', 'yo', 'mí', 'mi', 'mis', 'conmigo']);
const DURABLE_TYPES = new Set(Object.keys(AUTO_PREDICATES));
const MAX_POLICY_CONFIDENCE = 0.8;
const EXPLICIT_FICTIONAL_FRAME = /\b(?:fictici[oa]s?|inventad[oa]s?|fictional|made-up|hypothetical)\b/iu;
const EXPLICIT_DECISION = /(?:decidí|decidimos|decidió|elegimos|acordamos|decided|chose|agreed)/iu;
const BOUNDED_END_CONDITION = /\b(?:hasta (?:que )?(?:termin(?:ar|e|en)|finaliz(?:ar|e|en)|concluy(?:a|an)) las pruebas|until (?:the )?tests? (?:finish|are complete|are completed))\b/iu;
const PROJECT_LABEL = /\b(?:proyecto|project)\s+([\p{L}\p{N}][\p{L}\p{N}_-]*)/giu;
const CANONICAL_ID_SHAPE = /^(?:(?:person|project|organization|org|place|device|account)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;

function stableText(value) { return value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und'); }
function explicitProjectNames(text) {
    return [...text.matchAll(PROJECT_LABEL)].map(match => stableText(match[1]));
}

function isBoundedDecisionRecord(candidate) {
    const temporalText = candidate.temporal_hints.raw_text;
    return candidate.candidate_type === 'decision' && candidate.predicate === 'project.decision'
        && candidate.assertion_mode === 'asserted' && candidate.durability === 'temporary'
        && typeof temporalText === 'string' && BOUNDED_END_CONDITION.test(temporalText)
        && candidate.evidence_quote.includes(temporalText)
        && EXPLICIT_DECISION.test(candidate.evidence_quote)
        && /\b(?:paus(?:ar|o|amos)|suspend(?:er|o|emos)|mantener|mantengamos|almacenar|elegimos|decidimos)\b/iu.test(candidate.evidence_quote);
}
const NEGATIVE_PREFERENCE = /\b(?:no me gusta(?:n)?|no me agrada(?:n)?|no soporto|i do not like|i don't like)\b/iu;
function sensitiveCategory(candidate) {
    const text = `${candidate.predicate} ${candidate.value_text} ${candidate.subject_text ?? ''} ${candidate.mentioned_person_text ?? ''} ${candidate.evidence_quote}`;
    const found = SENSITIVE_PATTERNS.find(([, pattern]) => pattern.test(text));
    if (found) return found[0];
    if (candidate.sensitivity === 'credential') return 'credential';
    if (candidate.sensitivity === 'unknown') return 'unknown';
    if (candidate.sensitivity !== 'none') return candidate.sensitivity;
    return 'none';
}

function policyDecision(candidate, validated, snapshot, trustedSpeaker) {
    const reasons = [];
    if (validated.secretDetected) return { disposition: 'ignore', sensitivity: 'credential', reasons: ['secret_detected'] };
    if (!validated.evidence.verified) return { disposition: 'ignore', sensitivity: 'unknown', reasons: [validated.validationCode ?? 'evidence_unverified'] };
    if (validated.evidence.quotedOrImported || candidate.assertion_mode === 'quoted_or_imported')
        return { disposition: 'ignore', sensitivity: sensitiveCategory(candidate), reasons: ['quoted_or_external_evidence'] };
    if (EXPLICIT_FICTIONAL_FRAME.test(candidate.evidence_quote))
        return { disposition: 'ignore', sensitivity: sensitiveCategory(candidate), reasons: ['explicitly_fictional_content'] };
    const negativePreferenceInEvidence = NEGATIVE_PREFERENCE.test(candidate.evidence_quote);
    const negativePreferencePreserved = negativePreferenceInEvidence
        && candidate.candidate_type === 'preference' && candidate.predicate === 'user.preference'
        && NEGATIVE_PREFERENCE.test(candidate.value_text);
    if (negativePreferenceInEvidence && !negativePreferencePreserved)
        return { disposition: 'ignore', sensitivity: 'none', reasons: ['negative_preference_polarity_not_preserved'] };
    if (['inferred', 'negated', 'hypothetical', 'question', 'conditional'].includes(candidate.assertion_mode)
        && !(candidate.assertion_mode === 'negated' && negativePreferencePreserved))
        return { disposition: 'ignore', sensitivity: sensitiveCategory(candidate), reasons: ['not_asserted_as_fact'] };
    if (candidate.assertion_mode !== 'asserted' && !(candidate.assertion_mode === 'negated' && negativePreferencePreserved))
        return { disposition: 'ignore', sensitivity: sensitiveCategory(candidate), reasons: ['assertion_mode_uncertain'] };

    const sensitivity = sensitiveCategory(candidate);
    if (sensitivity === 'credential') return { disposition: 'ignore', sensitivity, reasons: ['credential_blocked'] };
    if (sensitivity !== 'none') return { disposition: 'ask', sensitivity, reasons: ['sensitive_or_unknown_category'] };
    const boundedDecisionRecord = isBoundedDecisionRecord(candidate);
    if (candidate.durability === 'ephemeral') return { disposition: 'ignore', sensitivity, reasons: ['ephemeral_information'] };
    const reviewOnly = Object.hasOwn(REVIEW_ONLY_PREDICATES, candidate.candidate_type);
    if (candidate.durability !== 'durable' && !boundedDecisionRecord && !reviewOnly)
        return { disposition: 'ignore', sensitivity, reasons: ['durability_not_established'] };
    if (candidate.linguistic_confidence < MAX_POLICY_CONFIDENCE)
        return { disposition: 'ignore', sensitivity, reasons: ['confidence_below_policy_threshold'] };
    const autoPredicate = AUTO_PREDICATES[candidate.candidate_type]?.has(candidate.predicate) ?? false;
    const reviewPredicate = REVIEW_ONLY_PREDICATES[candidate.candidate_type]?.has(candidate.predicate) ?? false;
    if ((!DURABLE_TYPES.has(candidate.candidate_type) || !autoPredicate) && !reviewPredicate)
        return { disposition: 'ignore', sensitivity, reasons: ['category_or_predicate_not_allowlisted'] };
    if (candidate.temporal_hints.certainty === 'uncertain'
        || (candidate.temporal_hints.certainty === 'explicit' && candidate.temporal_hints.raw_text === null))
        return { disposition: 'ask', sensitivity, reasons: ['temporal_scope_uncertain'] };
    if (candidate.update_intent === 'unknown' || candidate.update_intent === 'relation')
        return { disposition: 'ask', sensitivity, reasons: ['update_or_relation_requires_review'] };
    if (negativePreferencePreserved) reasons.push('explicit_negative_preference');

    let entityResolution = { status: 'not_required', entityId: null };
    if (candidate.mentioned_person_text) {
        if (!snapshot) return { disposition: 'ask', sensitivity, reasons: ['person_resolution_unavailable'], entityResolution: { status: 'unavailable', entityId: null } };
        const resolution = resolveEntityMentions(candidate.mentioned_person_text, snapshot);
        entityResolution = { status: resolution.mentions.length === 1 ? resolution.mentions[0].status : 'ambiguous',
            entityId: resolution.mentions.length === 1 ? resolution.mentions[0].entityId : null };
        if (entityResolution.status !== 'resolved') return { disposition: 'ask', sensitivity, reasons: ['person_not_uniquely_resolved'], entityResolution };
        return { disposition: 'ask', sensitivity, reasons: ['third_party_fact_requires_review'], entityResolution };
    }

    const subject = stableText(candidate.subject_text ?? '');
    const isSelf = Boolean(trustedSpeaker?.origin === 'direct_user'
        && trustedSpeaker.authenticationState === 'os_account_session_unverified'
        && trustedSpeaker.selfBindingStatus === 'linked'
        && trustedSpeaker.selfPersonId === snapshot?.snapshot.self_person_id
        && snapshot && snapshot.snapshot.self_person_id
        && SELF_ROLE_LABELS.has(subject)
        && snapshot.snapshot.entities.some(entity => entity.id === snapshot.snapshot.self_person_id && entity.type === 'person'));
    if (!isSelf && candidate.candidate_type !== 'decision')
        return { disposition: 'ask', sensitivity, reasons: ['subject_not_canonically_resolved'], entityResolution: { status: 'unresolved', entityId: null } };
    if (candidate.candidate_type === 'decision' && !subject)
        return { disposition: 'ask', sensitivity, reasons: ['project_subject_missing'] };
    if (candidate.candidate_type === 'decision') {
        const source = candidate.evidence_quote;
        const names = explicitProjectNames(source);
        if (CANONICAL_ID_SHAPE.test(candidate.subject_text.trim()))
            return { disposition: 'ask', sensitivity, reasons: ['project_identity_must_be_textual'], entityResolution: { status: 'unresolved', entityId: null } };
        if (!source.includes(candidate.subject_text) || names.length > 1)
            return { disposition: 'ask', sensitivity, reasons: ['project_subject_not_unambiguous_text'], entityResolution: { status: 'ambiguous', entityId: null } };
        if (!EXPLICIT_DECISION.test(source))
            return { disposition: 'ask', sensitivity, reasons: ['project_decision_not_explicit'], entityResolution: { status: 'textual_only', entityId: null } };
    }
    if (candidate.candidate_type === 'relationship')
        return { disposition: 'ask', sensitivity, reasons: ['relationship_requires_review'] };
    if (reviewOnly)
        return { disposition: 'ask', sensitivity,
            reasons: [candidate.candidate_type === 'learning_activity' ? 'learning_activity_requires_review' : 'long_term_goal_requires_review'],
            entityResolution: { status: isSelf ? 'self' : 'unresolved', entityId: isSelf ? snapshot.snapshot.self_person_id : null } };

    if (snapshot) {
        const retrieved = retrieveCandidates(snapshot, {
            entityIds: [], includeSelf: isSelf, predicates: [candidate.predicate], relationPredicates: [], statuses: ['active'],
            limits: { maxRelationDepth: 0, maxAssertions: 20 },
        });
        const exact = retrieved.assertions.find(item => stableText(item.record.object?.value ?? '') === stableText(candidate.value_text));
        if (exact) return { disposition: 'ignore', sensitivity, reasons: ['duplicate_active_assertion'], entityResolution: { status: isSelf ? 'self' : 'not_required', entityId: isSelf ? snapshot.snapshot.self_person_id : null } };
        const samePredicate = retrieved.assertions.length > 0;
        if (samePredicate && candidate.update_intent !== 'addition')
            return { disposition: 'ask', sensitivity, reasons: ['possible_contradiction_requires_review'], entityResolution: { status: isSelf ? 'self' : 'not_required', entityId: isSelf ? snapshot.snapshot.self_person_id : null } };
        if (!samePredicate && ['possible_correction', 'possible_supersession'].includes(candidate.update_intent))
            return { disposition: 'ask', sensitivity, reasons: ['correction_target_missing'], entityResolution: { status: isSelf ? 'self' : 'not_required', entityId: isSelf ? snapshot.snapshot.self_person_id : null } };
    }

    reasons.push(boundedDecisionRecord ? 'bounded_project_decision_record' : 'low_risk_durable_explicit_candidate');
    if (candidate.update_intent === 'addition') reasons.push('addition_does_not_select_supersession_target');
    return { disposition: 'auto_save', sensitivity, reasons,
        entityResolution: { status: isSelf ? 'self' : candidate.candidate_type === 'decision' ? 'textual_only' : 'not_required',
            entityId: isSelf && snapshot ? snapshot.snapshot.self_person_id : null } };
}

/** Pure recommendation policy. Self requires an opaque, current-turn identity capability. */
export function evaluateAutomaticMemoryPolicy(validatedCandidates, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)
        || (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)
        || Reflect.ownKeys(options).some(key => !['snapshot', 'speakerIdentityCapability', 'trustedSpeakerContext'].includes(key))) throw new TypeError('candidate_evaluation_invalid');
    for (const key of Reflect.ownKeys(options)) {
        const descriptor = Object.getOwnPropertyDescriptor(options, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new TypeError('candidate_evaluation_invalid');
    }
    const snapshot = options.snapshot ?? null;
    const firstRuntime = validatedCandidates?.[0]?.runtime;
    const sourceTextSha256 = firstRuntime?.sourceTextSha256;
    const allSameSource = Array.isArray(validatedCandidates) && validatedCandidates.every(item =>
        item?.runtime?.sourceTextSha256 === sourceTextSha256);
    const trustedSpeakerContext = options.trustedSpeakerContext
        ?? (options.speakerIdentityCapability && allSameSource
            ? consumeTrustedSpeakerIdentity(options.speakerIdentityCapability, sourceTextSha256) : null);
    const trustedSpeaker = trustedSpeakerIdentityDetails(trustedSpeakerContext);
    const contextMatchesSource = Boolean(trustedSpeaker && allSameSource
        && trustedSpeaker.sourceTextSha256 === sourceTextSha256);
    if (!Array.isArray(validatedCandidates)) throw new TypeError('candidate_evaluation_invalid');
    if (snapshot && (Reflect.ownKeys(snapshot).length !== 3 || !['snapshot', 'revision', 'digest'].every(key => Object.hasOwn(snapshot, key))
        || !Number.isSafeInteger(snapshot.revision) || typeof snapshot.digest !== 'string')) throw new TypeError('memory_snapshot_invalid');
    if (snapshot) validateMemoryStore(snapshot.snapshot);
    const decisions = validatedCandidates.map(validated => {
        const runtimeKeys = ['turnId', 'sourceTextSha256', 'sourceClass', 'policyVersion'];
        const evidenceKeys = ['verified', 'start', 'end', 'quotedOrImported'];
        if (!validated || typeof validated !== 'object' || Reflect.ownKeys(validated).length !== 7
            || !['index', 'proposal', 'redacted', 'evidence', 'runtime', 'validationCode', 'secretDetected'].every(key => Object.hasOwn(validated, key))
            || !Number.isSafeInteger(validated.index) || typeof validated.redacted !== 'boolean'
            || typeof validated.secretDetected !== 'boolean' || !validated.runtime || typeof validated.runtime !== 'object'
            || Reflect.ownKeys(validated.runtime).length !== runtimeKeys.length
            || !runtimeKeys.every(key => Object.hasOwn(validated.runtime, key))
            || validated.runtime.sourceClass !== 'dry_run_input'
            || !/^dryrun_[0-9a-f-]{36}$/u.test(validated.runtime.turnId ?? '')
            || !/^[a-f0-9]{64}$/u.test(validated.runtime.sourceTextSha256 ?? '')
            || validated.runtime.policyVersion !== AUTOMATIC_MEMORY_POLICY_VERSION
            || !validated.evidence || typeof validated.evidence !== 'object'
            || Reflect.ownKeys(validated.evidence).length !== evidenceKeys.length
            || !evidenceKeys.every(key => Object.hasOwn(validated.evidence, key))
            || typeof validated.evidence.verified !== 'boolean'
            || typeof validated.evidence.quotedOrImported !== 'boolean'
            || (validated.evidence.verified && (!Number.isSafeInteger(validated.evidence.start)
                || !Number.isSafeInteger(validated.evidence.end) || validated.evidence.start < 0 || validated.evidence.end <= validated.evidence.start)))
            throw new TypeError('candidate_evaluation_invalid');
        const parsed = validated.proposal === null ? null : parseAutomaticMemoryProposal({ candidates: [validated.proposal] });
        const proposalHasSecret = validated.proposal !== null && !screenMemorySecret(JSON.stringify(validated.proposal)).safe;
        if (validated.proposal !== null && (!parsed?.success || proposalHasSecret)) {
            return { candidateIndex: validated.index, proposal: null, redacted: true,
                evidence: { verified: false, start: null, end: null, quotedOrImported: false },
                runtime: { turnId: validated.runtime.turnId, sourceTextSha256: validated.runtime.sourceTextSha256,
                    sourceClass: validated.runtime.sourceClass, policyVersion: validated.runtime.policyVersion },
                disposition: 'ignore', reasonCodes: ['candidate_untrusted_or_secret'],
                sensitivity: proposalHasSecret ? 'credential' : 'unknown',
                entityResolution: { status: 'not_evaluated', entityId: null }, suggestedDisposition: null,
                updateIntent: 'unknown', temporalStatus: 'unknown' };
        }
        const decision = validated.proposal
            ? policyDecision(validated.proposal, validated, snapshot, contextMatchesSource ? trustedSpeaker : null)
            : { disposition: 'ignore', sensitivity: validated.secretDetected ? 'credential' : 'unknown',
                reasons: [validated.secretDetected ? 'secret_detected' : (validated.validationCode ?? 'candidate_unavailable')] };
        // The model suggestion is visible for offline comparison, never used by the policy.
        return {
            candidateIndex: validated.index,
            proposal: validated.proposal ? structuredClone(validated.proposal) : null,
            redacted: validated.redacted,
            evidence: structuredClone(validated.evidence),
            runtime: { turnId: validated.runtime.turnId, sourceTextSha256: validated.runtime.sourceTextSha256,
                sourceClass: validated.runtime.sourceClass, policyVersion: validated.runtime.policyVersion },
            disposition: decision.disposition,
            reasonCodes: decision.reasons,
            sensitivity: decision.sensitivity,
            entityResolution: decision.entityResolution ?? { status: 'not_evaluated', entityId: null },
            suggestedDisposition: validated.proposal?.suggested_disposition ?? null,
            updateIntent: validated.proposal?.update_intent ?? 'unknown',
            temporalStatus: validated.proposal?.temporal_hints.certainty ?? 'unknown',
        };
    });
    const identityCanBeHandedToAuthorization = Boolean(contextMatchesSource
        && trustedSpeaker?.selfBindingStatus === 'linked'
        && decisions.some(item => item.disposition === 'auto_save' || item.reasonCodes.includes('possible_contradiction_requires_review')));
    return { success: true, policyVersion: AUTOMATIC_MEMORY_POLICY_VERSION, candidates: decisions,
        ...(identityCanBeHandedToAuthorization ? { speakerIdentityContext: trustedSpeakerContext } : {}) };
}

export function snapshotFingerprint(snapshot) {
    if (!snapshot?.snapshot) throw new TypeError('memory_snapshot_invalid');
    return createHash('sha256').update(JSON.stringify(snapshot.snapshot)).digest('hex');
}
