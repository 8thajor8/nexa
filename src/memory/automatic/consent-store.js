import { randomUUID } from 'node:crypto';
import { createLocalJsonLedger, getAutomaticMemoryLocalPath } from './local-json-ledger.js';
import { AUTOMATIC_MEMORY_CONSENT_POLICY_VERSION, isCurrentAutomaticMemoryConsent } from './privacy.js';

const FORMAT = 'nexa-automatic-memory-consent';
const SCOPE = 'future_direct_user_turns_across_runtime_sessions';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function exactObject(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
        || Reflect.ownKeys(value).length !== keys.length || Reflect.ownKeys(value).some(key => !keys.includes(key)))
        throw new Error('automatic_memory_storage_corrupt');
    return value;
}

function validateConsentRecord(value) {
    if (value === null) return null;
    exactObject(value, ['format', 'version', 'status', 'updatedAt', 'consent', 'excludedConversations']);
    if (value.format !== FORMAT || value.version !== 1 || !['granted', 'revoked'].includes(value.status)
        || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
        || !Array.isArray(value.excludedConversations) || value.excludedConversations.length > 2000)
        throw new Error('automatic_memory_storage_corrupt');
    for (const exclusion of value.excludedConversations) {
        exactObject(exclusion, ['conversationId', 'excludedAt']);
        if (!UUID.test(exclusion.conversationId) || typeof exclusion.excludedAt !== 'string'
            || !Number.isFinite(Date.parse(exclusion.excludedAt))) throw new Error('automatic_memory_storage_corrupt');
    }
    if (value.status === 'revoked') {
        if (value.consent !== null) throw new Error('automatic_memory_storage_corrupt');
        return structuredClone(value);
    }
    exactObject(value.consent, ['consentId', 'grantedAt', 'policyVersion', 'purpose', 'scope', 'grantsMemoryWrite']);
    if (typeof value.consent.consentId !== 'string' || !UUID.test(value.consent.consentId)
        || typeof value.consent.grantedAt !== 'string' || !Number.isFinite(Date.parse(value.consent.grantedAt))
        || typeof value.consent.policyVersion !== 'string'
        || value.consent.purpose !== 'assess_future_direct_user_turns_for_possible_memory_candidates'
        || value.consent.scope !== SCOPE || value.consent.grantsMemoryWrite !== false)
        throw new Error('automatic_memory_storage_corrupt');
    return structuredClone(value);
}

export function createPersistentAutomaticMemoryConsent({ consentId = randomUUID(), grantedAt = new Date().toISOString() } = {}) {
    return Object.freeze({ consentId, grantedAt, policyVersion: AUTOMATIC_MEMORY_CONSENT_POLICY_VERSION,
        purpose: 'assess_future_direct_user_turns_for_possible_memory_candidates', scope: SCOPE,
        grantsMemoryWrite: false });
}

export function createAutomaticMemoryConsentStore({ filePath = getAutomaticMemoryLocalPath('consent.json'), now = () => new Date() } = {}) {
    const ledger = createLocalJsonLedger({ filePath, validate: validateConsentRecord, initialValue: null });

    return Object.freeze({
        async load() {
            const record = await ledger.read();
            if (!record || record.status !== 'granted') return null;
            return isCurrentAutomaticMemoryConsent(record.consent) ? Object.freeze({ ...record.consent,
                excludedConversations: Object.freeze(record.excludedConversations.map(item => item.conversationId)) }) : null;
        },
        async grant() {
            const consent = createPersistentAutomaticMemoryConsent({ grantedAt: now().toISOString() });
            const record = { format: FORMAT, version: 1, status: 'granted', updatedAt: consent.grantedAt,
                consent, excludedConversations: [] };
            await ledger.write(record);
            return Object.freeze(consent);
        },
        async revoke() {
            const timestamp = now().toISOString();
            await ledger.write({ format: FORMAT, version: 1, status: 'revoked', updatedAt: timestamp,
                consent: null, excludedConversations: [] });
            return { success: true, status: 'revoked' };
        },
        async excludeConversation(conversationId) {
            if (!UUID.test(conversationId)) throw new Error('automatic_memory_storage_scope_invalid');
            const timestamp = now().toISOString();
            return ledger.update(record => {
                if (!record || record.status !== 'granted') return record;
                if (!record.excludedConversations.some(item => item.conversationId === conversationId)) {
                    if (record.excludedConversations.length >= 2000) throw new Error('automatic_memory_storage_full');
                    record.excludedConversations.push({ conversationId, excludedAt: timestamp });
                    record.updatedAt = timestamp;
                }
                return record;
            }).then(record => ({ success: Boolean(record?.status === 'granted'
                && record.excludedConversations.some(item => item.conversationId === conversationId)) }));
        },
    });
}

export function createDefaultAutomaticMemoryConsentStore() {
    return createAutomaticMemoryConsentStore();
}
