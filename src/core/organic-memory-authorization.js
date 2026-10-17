const ALLOWED_SCOPES = new Set(['daily_preferences', 'tool_preferences', 'technologies_used', 'declared_projects',
    'entertainment_preferences', 'food_activity_preferences', 'interaction_preferences', 'daily_routines',
    'work_patterns', 'recurring_activities', 'active_projects', 'interests', 'goals', 'personal_relationships',
    'biography', 'hobbies', 'decisions', 'third_party_facts', 'everyday_facts']);
export const ORGANIC_THIRD_PARTY_SCOPE = 'third_party_facts';
const ALLOWED_OPERATIONS = new Set(['remember', 'update', 'remember_relationship']);
export const ORGANIC_RELATIONSHIP_SCOPE = 'personal_relationships';
export const ORGANIC_RELATIONSHIP_ATTRIBUTE = 'relationship.partner';
// Reserved for the future verified semantic extractor; no production issuer
// currently mints evidence for this attribute.
export const ORGANIC_TYPED_RELATIONSHIP_ATTRIBUTE = 'relationship.personal';
const ORGANIC_RELATIONSHIP_ATTRIBUTES = new Set([ORGANIC_RELATIONSHIP_ATTRIBUTE, ORGANIC_TYPED_RELATIONSHIP_ATTRIBUTE]);

/** Accept only a direct, narrowly phrased owner statement; not a third-party relation or inference. */
export function parseDirectOwnerPartnerStatement(quote) {
    if (typeof quote !== 'string' || quote.length > 300 || /[\p{Cc}\p{Cf}]/u.test(quote)) return null;
    const patterns = [
        /^\s*(.+?)\s+es\s+mi\s+pareja\s*[.!]?\s*$/iu,
        /^\s*mi\s+pareja\s+es\s+(.+?)\s*[.!]?\s*$/iu,
        /^\s*mi\s+pareja\s+se\s+llama\s+(.+?)\s*[.!]?\s*$/iu,
        /^\s*soy\s+pareja\s+de\s+(.+?)\s*[.!]?\s*$/iu,
    ];
    for (const pattern of patterns) {
        const match = pattern.exec(quote);
        if (!match) continue;
        const preferredName = match[1].trim();
        try {
            if (preferredName && [...preferredName].length <= 120 && normalizeOrganicName(preferredName))
                return Object.freeze({ preferredName });
        } catch { return null; }
    }
    return null;
}

function normalizeOrganicName(value) {
    return value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase().normalize('NFC');
}

const ATTRIBUTE_GROUPS = Object.freeze({
    general: Object.freeze({ scope: 'everyday_facts', kind: 'fact', category: 'fact', predicate: 'personal.fact',
        render: (_key, value) => value }),
    biography: Object.freeze({ scope: 'biography', kind: 'fact', category: 'fact', predicate: 'user.biography',
        render: (_key, value) => `Mi ocupación es ${value}.` }),
    hobby: Object.freeze({ scope: 'hobbies', kind: 'fact', category: 'fact', predicate: 'user.hobby',
        render: (key, value) => key.startsWith('hobby.instrument_') ? `Toco ${value}.` : `Practico ${value}.` }),
    practice: Object.freeze({ scope: 'hobbies', kind: 'fact', category: 'fact', predicate: 'user.practice',
        render: (_key, value) => `Practico ${value}.` }),
    decision: Object.freeze({ scope: 'decisions', kind: 'fact', category: 'project', predicate: 'user.decision',
        render: (_key, value) => `Decidí ${value}.` }),
    editor: Object.freeze({ scope: 'tool_preferences', kind: 'preference', category: 'preference', predicate: 'user.preference',
        render: (key, value) => key === 'editor.habitual' ? `Mi editor habitual es ${value}.`
            : key === 'editor.testing_favorite' ? `Mi editor favorito para hacer pruebas es ${value}.`
                : `Mi preferencia de edición es ${value}.` }),
    app: Object.freeze({ scope: 'tool_preferences', kind: 'preference', category: 'preference', predicate: 'user.preference',
        render: (_key, value) => `Mi aplicación preferida es ${value}.` }),
    tool: Object.freeze({ scope: 'tool_preferences', kind: 'preference', category: 'preference', predicate: 'user.preference',
        render: (_key, value) => `Mi herramienta preferida es ${value}.` }),
    music: Object.freeze({ scope: 'entertainment_preferences', kind: 'preference', category: 'preference', predicate: 'user.preference',
        render: (_key, value) => `Mi preferencia musical es ${value}.` }),
    entertainment: Object.freeze({ scope: 'entertainment_preferences', kind: 'preference', category: 'preference', predicate: 'user.preference',
        render: (_key, value) => `Mi preferencia de entretenimiento es ${value}.` }),
    food: Object.freeze({ scope: 'food_activity_preferences', kind: 'preference', category: 'preference', predicate: 'user.preference',
        render: (key, value) => key === 'food.beverage_favorite' ? `Mi bebida favorita es ${value}.`
            : `Mi preferencia de comida es ${value}.` }),
    activity: Object.freeze({ scope: 'food_activity_preferences', kind: 'preference', category: 'preference', predicate: 'user.preference',
        render: (_key, value) => `Mi actividad preferida es ${value}.` }),
    interaction: Object.freeze({ scope: 'interaction_preferences', kind: 'preference', category: 'preference', predicate: 'user.preference',
        render: (_key, value) => `Mi preferencia al interactuar con Nexa es ${value}.` }),
    routine: Object.freeze({ scope: 'daily_routines', kind: 'fact', category: 'routine', predicate: 'user.routine',
        render: (_key, value) => `Mi rutina cotidiana es ${value}.` }),
    work: Object.freeze({ scope: 'work_patterns', kind: 'fact', category: 'routine', predicate: 'user.routine',
        render: (_key, value) => `Mi forma habitual de trabajar es ${value}.` }),
    recurring: Object.freeze({ scope: 'recurring_activities', kind: 'fact', category: 'routine', predicate: 'user.routine',
        render: (_key, value) => `Mi actividad recurrente es ${value}.` }),
    project: Object.freeze({ scope: 'active_projects', kind: 'fact', category: 'project', predicate: 'user.project',
        render: (_key, value) => `Mi proyecto activo es ${value}.` }),
    interest: Object.freeze({ scope: 'interests', kind: 'fact', category: 'fact', predicate: 'user.interest',
        render: (_key, value) => `Me interesa ${value}.` }),
    goal: Object.freeze({ scope: 'goals', kind: 'fact', category: 'project', predicate: 'user.goal',
        render: (_key, value) => `Mi objetivo actual es ${value}.` }),
});

/** Bounded attribute namespaces shared by Runtime and the trusted Desktop host. */
export function getOrganicMemoryAttributePolicy(attribute) {
    if (typeof attribute !== 'string' || attribute.length > 96
        || !/^\p{L}[\p{L}\p{N}_-]*(?:\.\p{L}[\p{L}\p{N}_-]*){1,3}$/u.test(attribute)) return null;
    const namespace = attribute.split('.')[0];
    // Relationship facts have a dedicated consent scope and typed graph write
    // path. They must never fall through to the generic everyday-facts scope.
    if (namespace === 'relationship') return null;
    // The namespace remains a bounded storage key for compatibility, not a
    // vocabulary gate. Previously unseen semantic topics use the generic fact
    // representation and the existing everyday-facts consent scope.
    const group = Object.hasOwn(ATTRIBUTE_GROUPS, namespace) ? ATTRIBUTE_GROUPS[namespace] : ATTRIBUTE_GROUPS.general;
    return Object.freeze({ ...group, key: attribute, scope: group.scope, category: group.category,
        predicate: group.predicate, render: (value) => group.render(attribute, value) });
}

function denied(reason, scope = null) {
    return Object.freeze({ allowed: false, status: 'denied', scope, authorizationId: null, reason });
}

function eligibleEvidence(evidence, attribute, ownerId = null, scope = null) {
    const thirdParty = scope === ORGANIC_THIRD_PARTY_SCOPE;
    return Boolean(evidence && evidence.origin === 'direct_user'
        && evidence.subject === (thirdParty ? 'third_party' : 'owner')
        && evidence.explicit === true && evidence.certain === true && evidence.sensitive === false
        && evidence.ambiguous === false && evidence.thirdParty === thirdParty && evidence.modelOriginated === false
        && (!thirdParty || (typeof evidence.subjectName === 'string' && evidence.subjectName.length > 0
            && evidence.proposal?.subject?.type === 'entity' && evidence.proposal.subject.entity_type === 'person'))
        && evidence.attribute === attribute && (ownerId === null || evidence.ownerId === ownerId));
}

function validKey(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 96
        && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function exactDataRecord(value, keys) {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
        const own = Reflect.ownKeys(value);
        return own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key)
            && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
    } catch { return false; }
}

/**
 * Runtime-owned authorization contract for organic Memory2 learning.
 * Consent and evidence are opaque capabilities verified by trusted host code;
 * ordinary model output or assessment consent cannot issue either capability.
 * Personal grants are bound to the selected writable Desktop mode and owner;
 * synthetic pilot grants remain synthetic-only.
 */
export function createOrganicMemoryAuthorization({
    storeCapability,
    verifyStoreCapability,
    persist,
    verifyConsentCapability,
    verifyEvidenceCapability,
    now = () => Date.now(),
} = {}) {
    if (typeof verifyStoreCapability !== 'function' || typeof verifyConsentCapability !== 'function'
        || typeof verifyEvidenceCapability !== 'function' || typeof persist !== 'function' || typeof now !== 'function')
        throw new TypeError('organic_memory_authorization_configuration_invalid');

    function verifyStore() {
        try {
            const store = verifyStoreCapability(storeCapability);
            if (store?.kind === 'synthetic_test' && store.isolated === true && store.personalData === false)
                return { ...store, authorizationKind: 'synthetic' };
            if (store?.kind === 'memory2_personal' && store.personalData === true
                && store.mode === 'memory2-confirmed-write' && typeof store.ownerId === 'string' && store.ownerId.length > 0)
                return { ...store, authorizationKind: 'personal' };
            return null;
        } catch { return null; }
    }
    const initialStoreProof = verifyStore();

    let consent = Object.freeze({ status: 'absent', authorizationId: null, scopes: Object.freeze([]), expiresAt: 0 });
    let sequence = 0;

    function activeConsent() {
        if (consent.status === 'granted' && now() >= consent.expiresAt) {
            consent = Object.freeze({ status: 'revoked', authorizationId: consent.authorizationId,
                scopes: Object.freeze([]), expiresAt: 0 });
        }
        return consent;
    }

    function setConsent(capability, decision, scopes, ttlMs, kind) {
        const store = verifyStore();
        if (!store || store.authorizationKind !== kind) return denied(kind === 'synthetic' ? 'synthetic_store_required' : 'personal_memory2_store_required');
        if (!['granted', 'denied', 'revoked'].includes(decision)) return denied('consent_decision_invalid');
        if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some(scope => !ALLOWED_SCOPES.has(scope))
            || new Set(scopes).size !== scopes.length) return denied('scope_not_allowed');
        let proof;
        try { proof = verifyConsentCapability(capability); } catch { return denied('consent_verification_failed'); }
        if (!proof || proof.issuer !== 'owner' || proof[kind === 'synthetic' ? 'synthetic' : 'personal'] !== true
            || proof.purpose !== 'organic_memory_learning' || proof.decision !== decision
            || (kind === 'personal' && (proof.ownerId !== store.ownerId || proof.mode !== store.mode))
            || !Array.isArray(proof.scopes) || scopes.length !== proof.scopes.length
            || scopes.some((scope, index) => scope !== proof.scopes[index]))
            return denied('trusted_owner_consent_required');
        const maxTtl = kind === 'synthetic' ? 60_000 : 12 * 60 * 60 * 1000;
        if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > maxTtl) return denied('consent_duration_invalid');
        const authorizationId = `${kind}-learning-${++sequence}`;
        consent = Object.freeze({ status: decision, authorizationId,
            scopes: Object.freeze(decision === 'granted' ? [...scopes] : []),
            expiresAt: decision === 'granted' ? now() + ttlMs : 0 });
        return Object.freeze({ success: true, status: consent.status, authorizationId,
            scopes: consent.scopes, syntheticOnly: kind === 'synthetic', ownerOnly: kind === 'personal' });
    }

    function setSyntheticConsent(capability, decision, scopes, ttlMs = 60_000) {
        return setConsent(capability, decision, scopes, ttlMs, 'synthetic');
    }

    function setOwnerConsent(capability, decision, scopes, ttlMs = 60 * 60 * 1000) {
        return setConsent(capability, decision, scopes, ttlMs, 'personal');
    }

    function revokeSyntheticConsent(capability) {
        const currentScopes = activeConsent().scopes;
        const scopes = currentScopes.length ? [...currentScopes] : ['daily_preferences'];
        return setSyntheticConsent(capability, 'revoked', scopes, 1);
    }

    function revokeOwnerConsent(capability) {
        const currentScopes = activeConsent().scopes;
        return setOwnerConsent(capability, 'revoked', currentScopes.length ? [...currentScopes] : ['daily_preferences'], 1);
    }

    function inspect() {
        const current = activeConsent();
        return Object.freeze({ status: current.status, authorizationId: current.authorizationId,
            scopes: current.scopes, syntheticOnly: verifyStore()?.authorizationKind === 'synthetic',
            ownerOnly: verifyStore()?.authorizationKind === 'personal' });
    }

    function verify(input) {
        const store = verifyStore();
        if (!store) return denied(initialStoreProof?.authorizationKind === 'synthetic'
            ? 'synthetic_store_required' : 'organic_store_not_authorized', input?.scope ?? null);
        if (!exactDataRecord(input, ['scope', 'operation', 'attribute', 'evidenceCapability']))
            return denied('authorization_input_invalid');
        if (!ALLOWED_SCOPES.has(input.scope) || !ALLOWED_OPERATIONS.has(input.operation) || !validKey(input.attribute)
            || (input.operation === 'remember_relationship'
                && (input.scope !== ORGANIC_RELATIONSHIP_SCOPE || !ORGANIC_RELATIONSHIP_ATTRIBUTES.has(input.attribute)))
            || (input.scope === ORGANIC_RELATIONSHIP_SCOPE && input.operation !== 'remember_relationship'))
            return denied('operation_out_of_scope', input.scope ?? null);
        const current = activeConsent();
        if (current.status !== 'granted') return denied(`consent_${current.status}`, input.scope);
        if (!current.scopes.includes(input.scope)) return denied('scope_not_granted', input.scope);

        let evidence;
        try { evidence = verifyEvidenceCapability(input.evidenceCapability); }
        catch { return denied('evidence_verification_failed', input.scope); }
        if (!eligibleEvidence(evidence, input.attribute, store.authorizationKind === 'personal' ? store.ownerId : null, input.scope))
            return denied('evidence_not_eligible', input.scope);

        return Object.freeze({ allowed: true, status: 'granted', scope: input.scope,
            authorizationId: current.authorizationId, reason: null });
    }

    /** Verify immediately before invoking persistence. Rejections never call it. */
    async function persistIfAuthorized(input) {
        let authorization;
        try { authorization = verify(input); }
        catch { authorization = denied('verification_failed', null); }
        if (!authorization.allowed) return Object.freeze({ success: false,
            authorization, error: { code: authorization.reason } });
        let evidence;
        try { evidence = verifyEvidenceCapability(input.evidenceCapability); }
        catch { evidence = null; }
        const store = verifyStore();
        if (!eligibleEvidence(evidence, input.attribute, store?.authorizationKind === 'personal' ? store.ownerId : null, input.scope)) return Object.freeze({ success: false,
            authorization: denied('evidence_not_eligible', input.scope), error: { code: 'evidence_not_eligible' } });
        try {
            const result = await persist(input, Object.freeze({ scope: authorization.scope,
                authorizationId: authorization.authorizationId, syntheticOnly: store?.authorizationKind === 'synthetic',
                ownerOnly: store?.authorizationKind === 'personal' }), evidence);
            return Object.freeze({ success: true, authorization, result });
        } catch {
            return Object.freeze({ success: false, authorization,
                error: { code: 'persistence_failed' } });
        }
    }

    return Object.freeze({ setSyntheticConsent, revokeSyntheticConsent, setOwnerConsent, revokeOwnerConsent,
        inspect, verify, persistIfAuthorized, storeMode: initialStoreProof?.authorizationKind ?? null });
}

export const ORGANIC_MEMORY_ALLOWED_SCOPES = Object.freeze([...ALLOWED_SCOPES]);
