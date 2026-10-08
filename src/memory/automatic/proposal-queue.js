import { createHash, randomUUID } from 'node:crypto';
import { createLocalJsonLedger, getAutomaticMemoryLocalPath } from './local-json-ledger.js';
import { screenAutomaticMemoryTurn } from './privacy.js';

const FORMAT = 'nexa-automatic-memory-proposal-queue';
const VERSION = 1;
export const AUTOMATIC_MEMORY_PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ITEMS = 500;
const MAX_TOMBSTONES = 2000;
const CATEGORIES = new Set(['stable_preference', 'device', 'project', 'health_sensitive',
    'finance_sensitive', 'relationship_sensitive', 'legal_sensitive', 'work_sensitive', 'other_sensitive']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const forbiddenSummary = /(?:[\w.+-]+@[\w.-]+\.[a-z]{2,}|https?:\/\/|\b(?:\d[ -]?){9,}\b|\b(?:dni|nie|ssn|passport|pasaporte|domicilio|direcci[oó]n|coordenadas|gps)\b)/iu;
const confidentialThirdParty = /\b(?:patient\s+(?:record|data|file)|medical\s+record|expediente\s+(?:m[eé]dico|del\s+paciente)|datos\s+del\s+paciente|secreto\s+profesional|professional\s+secret|attorney[- ]client|client\s+confidential|trade\s+secret|confidential\s+third[- ]party)\b/iu;
const sensitiveCategory = category => category.endsWith('_sensitive');

function strictObject(value, keys, code = 'automatic_memory_queue_corrupt') {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
        || Reflect.ownKeys(value).length !== keys.length || Reflect.ownKeys(value).some(key => !keys.includes(key)))
        throw new Error(code);
    return value;
}

function validDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }

function validateItem(item) {
    strictObject(item, ['proposalId', 'conversationId', 'consentId', 'turnId', 'fingerprint', 'createdAt',
        'expiresAt', 'updatedAt', 'status', 'action', 'category', 'sensitive', 'summary', 'targetSummary']);
    if (typeof item.proposalId !== 'string' || !/^prop_[0-9a-f-]{36}$/iu.test(item.proposalId)
        || !UUID.test(item.conversationId) || !UUID.test(item.consentId) || !UUID.test(item.turnId)
        || !/^[0-9a-f]{64}$/u.test(item.fingerprint) || !validDate(item.createdAt)
        || !validDate(item.expiresAt) || !validDate(item.updatedAt)
        || Date.parse(item.expiresAt) !== Date.parse(item.createdAt) + AUTOMATIC_MEMORY_PROPOSAL_TTL_MS
        || Date.parse(item.updatedAt) < Date.parse(item.createdAt)
        || !['pending', 'approved', 'rejected', 'expired'].includes(item.status)) throw new Error('automatic_memory_queue_corrupt');
    if (item.status === 'pending' || (item.status === 'approved' && item.summary !== null)) {
        if (!['ADD', 'REPLACE'].includes(item.action) || !CATEGORIES.has(item.category)
            || typeof item.sensitive !== 'boolean' || sensitiveCategory(item.category) !== item.sensitive
            || typeof item.summary !== 'string' || item.summary.length < 1 || item.summary.length > 180
            || !item.summary.isWellFormed() || typeof item.targetSummary !== 'string' && item.targetSummary !== null
            || item.targetSummary?.length > 180 || (item.action === 'REPLACE') !== Boolean(item.targetSummary))
            throw new Error('automatic_memory_queue_corrupt');
        validateSummary(item.summary);
        if (item.targetSummary !== null) validateSummary(item.targetSummary);
    } else if (item.action !== null || item.category !== null || item.sensitive !== null
        || item.summary !== null || item.targetSummary !== null) throw new Error('automatic_memory_queue_corrupt');
    return structuredClone(item);
}

function validateSummary(summary) {
    if (typeof summary !== 'string' || !summary.trim() || summary.length > 180 || !summary.isWellFormed()
        || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(summary)
        || forbiddenSummary.test(summary) || confidentialThirdParty.test(summary)
        || !screenAutomaticMemoryTurn(summary).eligible) throw new Error('automatic_memory_queue_content_rejected');
}

function validateQueue(value) {
    strictObject(value, ['format', 'version', 'items', 'excludedConversations', 'revokedConsentIds']);
    if (value.format !== FORMAT || value.version !== VERSION || !Array.isArray(value.items)
        || value.items.length > MAX_ITEMS || !Array.isArray(value.excludedConversations)
        || value.excludedConversations.length > MAX_TOMBSTONES || !Array.isArray(value.revokedConsentIds)
        || value.revokedConsentIds.length > MAX_TOMBSTONES) throw new Error('automatic_memory_queue_corrupt');
    const items = value.items.map(validateItem), ids = new Set(), fingerprints = new Set();
    for (const item of items) {
        if (ids.has(item.proposalId)) throw new Error('automatic_memory_queue_corrupt');
        ids.add(item.proposalId);
        if (item.status === 'pending') {
            const key = `${item.conversationId}:${item.fingerprint}`;
            if (fingerprints.has(key)) throw new Error('automatic_memory_queue_corrupt');
            fingerprints.add(key);
        }
    }
    for (const entry of value.excludedConversations) {
        strictObject(entry, ['conversationId', 'excludedAt']);
        if (!UUID.test(entry.conversationId) || !validDate(entry.excludedAt)) throw new Error('automatic_memory_queue_corrupt');
    }
    for (const entry of value.revokedConsentIds) {
        strictObject(entry, ['consentId', 'revokedAt']);
        if (!UUID.test(entry.consentId) || !validDate(entry.revokedAt)) throw new Error('automatic_memory_queue_corrupt');
    }
    return structuredClone(value);
}

function fingerprintProposal(proposal) {
    const canonical = JSON.stringify([proposal.action, proposal.category, proposal.sensitive,
        proposal.summary.normalize('NFC').trim(), proposal.targetSummary?.normalize('NFC').trim() ?? null]);
    return createHash('sha256').update(canonical).digest('hex');
}

function sweep(queue, now) {
    const nowMs = now.getTime();
    let changed = false;
    for (const item of queue.items) {
        if (item.status === 'pending' && Date.parse(item.expiresAt) <= nowMs) {
            Object.assign(item, { status: 'expired', action: null, category: null, sensitive: null,
                summary: null, targetSummary: null, updatedAt: now.toISOString() });
            changed = true;
        } else if (item.status === 'approved' && item.summary !== null && Date.parse(item.expiresAt) <= nowMs) {
            Object.assign(item, { action: null, category: null, sensitive: null,
                summary: null, targetSummary: null, updatedAt: now.toISOString() });
            changed = true;
        }
    }
    const kept = queue.items.filter(item => {
        const terminal = item.status !== 'pending' && item.summary === null;
        const retain = !terminal || nowMs - Date.parse(item.updatedAt) <= TOMBSTONE_TTL_MS;
        if (!retain) changed = true;
        return retain;
    });
    queue.items = kept;
    for (const key of ['excludedConversations', 'revokedConsentIds']) {
        const timeKey = key === 'excludedConversations' ? 'excludedAt' : 'revokedAt';
        const filtered = queue[key].filter(item => nowMs - Date.parse(item[timeKey]) <= TOMBSTONE_TTL_MS);
        if (filtered.length !== queue[key].length) changed = true;
        queue[key] = filtered;
    }
    return changed;
}

function initialQueue() { return { format: FORMAT, version: VERSION, items: [], excludedConversations: [], revokedConsentIds: [] }; }

export function createAutomaticMemoryProposalQueue({ filePath = getAutomaticMemoryLocalPath('proposals.json'),
    now = () => new Date() } = {}) {
    const ledger = createLocalJsonLedger({ filePath, validate: validateQueue, initialValue: initialQueue() });

    async function mutate(mutator) {
        let result;
        const state = await ledger.update(async queue => {
            sweep(queue, now());
            result = await mutator(queue);
            return queue;
        });
        return { state, result };
    }

    return Object.freeze({
        async listGrouped({ consentId = undefined, excludedConversationId = null, excludedConversationIds = [] } = {}) {
            if (!Array.isArray(excludedConversationIds) || excludedConversationIds.some(id => !UUID.test(id)))
                throw new Error('automatic_memory_queue_scope_invalid');
            const excluded = new Set(excludedConversationIds);
            if (excludedConversationId) excluded.add(excludedConversationId);
            const { state: queue } = await mutate(() => undefined);
            const groups = new Map();
            for (const item of queue.items.filter(candidate => candidate.status === 'pending'
                && (consentId === undefined || candidate.consentId === consentId)
                && !excluded.has(candidate.conversationId))) {
                const key = `${item.category}:${item.action}:${item.sensitive ? 'sensitive' : 'standard'}`;
                const group = groups.get(key) ?? { category: item.category, action: item.action,
                    sensitive: item.sensitive, proposals: [] };
                group.proposals.push({ proposalId: item.proposalId, summary: item.summary,
                    targetSummary: item.targetSummary, expiresAt: item.expiresAt });
                groups.set(key, group);
            }
            return [...groups.values()].map(group => Object.freeze({ ...group,
                proposals: Object.freeze(group.proposals.map(Object.freeze)) }));
        },
        async review(proposalId) {
            const { state: queue } = await mutate(() => undefined);
            const item = queue.items.find(candidate => candidate.proposalId === proposalId && candidate.status === 'pending');
            return item ? Object.freeze(structuredClone(item)) : null;
        },
        async enqueue(input) {
            strictObject(input, ['conversationId', 'consentId', 'turnId', 'action', 'category', 'sensitive', 'summary', 'targetSummary'],
                'automatic_memory_queue_proposal_invalid');
            if (!UUID.test(input.conversationId) || !UUID.test(input.consentId) || !UUID.test(input.turnId)
                || !['ADD', 'REPLACE'].includes(input.action) || !CATEGORIES.has(input.category)
                || typeof input.sensitive !== 'boolean' || sensitiveCategory(input.category) !== input.sensitive
                || typeof input.summary !== 'string' || typeof input.targetSummary !== 'string' && input.targetSummary !== null
                || (input.action === 'REPLACE') !== Boolean(input.targetSummary)) throw new Error('automatic_memory_queue_proposal_invalid');
            validateSummary(input.summary);
            if (input.targetSummary !== null) validateSummary(input.targetSummary);
            const fingerprint = fingerprintProposal(input);
            return (await mutate(queue => {
                if (queue.excludedConversations.some(item => item.conversationId === input.conversationId)
                    || queue.revokedConsentIds.some(item => item.consentId === input.consentId))
                    return { status: 'discarded', reason: 'scope_invalidated' };
                const duplicate = queue.items.find(item => (item.status === 'pending' || item.status === 'approved' && item.summary !== null)
                    && item.conversationId === input.conversationId && item.fingerprint === fingerprint);
                if (duplicate) return { status: 'duplicate', proposalId: duplicate.proposalId };
                if (queue.items.length >= MAX_ITEMS) throw new Error('automatic_memory_queue_full');
                const createdAt = now().toISOString();
                const item = { proposalId: `prop_${randomUUID()}`, conversationId: input.conversationId,
                    consentId: input.consentId, turnId: input.turnId, fingerprint, createdAt,
                    expiresAt: new Date(Date.parse(createdAt) + AUTOMATIC_MEMORY_PROPOSAL_TTL_MS).toISOString(),
                    updatedAt: createdAt, status: 'pending', action: input.action, category: input.category,
                    sensitive: input.sensitive, summary: input.summary.trim(), targetSummary: input.targetSummary?.trim() ?? null };
                queue.items.push(item);
                return { status: 'pending', proposalId: item.proposalId, fingerprint };
            })).result;
        },
        async approve(proposalId, expectedFingerprint) {
            return (await mutate(queue => {
                const item = queue.items.find(candidate => candidate.proposalId === proposalId);
                if (!item || item.status !== 'pending' || item.fingerprint !== expectedFingerprint)
                    return { success: false, code: 'proposal_stale_or_missing' };
                item.status = 'approved'; item.updatedAt = now().toISOString();
                return { success: true, status: item.status, proposalId: item.proposalId };
            })).result;
        },
        async reject(proposalId, expectedFingerprint) {
            return (await mutate(queue => {
                const item = queue.items.find(candidate => candidate.proposalId === proposalId);
                if (!item || item.status !== 'pending' || item.fingerprint !== expectedFingerprint)
                    return { success: false, code: 'proposal_stale_or_missing' };
                Object.assign(item, { status: 'rejected', action: null, category: null, sensitive: null,
                    summary: null, targetSummary: null, updatedAt: now().toISOString() });
                return { success: true, status: item.status };
            })).result;
        },
        async discard(proposalId) {
            return (await mutate(queue => {
                const before = queue.items.length;
                queue.items = queue.items.filter(item => item.proposalId !== proposalId);
                return { success: queue.items.length !== before };
            })).result;
        },
        async excludeConversation(conversationId) {
            if (!UUID.test(conversationId)) throw new Error('automatic_memory_queue_scope_invalid');
            return (await mutate(queue => {
                queue.items = queue.items.filter(item => item.conversationId !== conversationId
                    || !['pending', 'approved'].includes(item.status));
                const knownExclusion = queue.excludedConversations.some(item => item.conversationId === conversationId);
                if (!knownExclusion && queue.excludedConversations.length >= MAX_TOMBSTONES)
                    throw new Error('automatic_memory_queue_full');
                if (!knownExclusion)
                    queue.excludedConversations.push({ conversationId, excludedAt: now().toISOString() });
                return { success: true };
            })).result;
        },
        async revokeConsent(consentId) {
            if (!UUID.test(consentId)) throw new Error('automatic_memory_queue_scope_invalid');
            return (await mutate(queue => {
                queue.items = queue.items.filter(item => item.consentId !== consentId
                    || !['pending', 'approved'].includes(item.status));
                const knownRevocation = queue.revokedConsentIds.some(item => item.consentId === consentId);
                if (!knownRevocation && queue.revokedConsentIds.length >= MAX_TOMBSTONES)
                    throw new Error('automatic_memory_queue_full');
                if (!knownRevocation)
                    queue.revokedConsentIds.push({ consentId, revokedAt: now().toISOString() });
                return { success: true };
            })).result;
        },
    });
}

export function createDefaultAutomaticMemoryProposalQueue() { return createAutomaticMemoryProposalQueue(); }
