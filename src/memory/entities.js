// Pure views over a validated store. Names are evidence-backed assertions, not
// identity/authentication. No persisted index, implicit entity, or cached name.
export function isEntityName(predicate) {
    return predicate === 'entity.preferred_name' || predicate === 'entity.alias';
}

export function normalizeEntityName(value) {
    if (typeof value !== 'string' || !value.isWellFormed() || [...value].length > 200
        || /[\p{Cc}\p{Cf}]/u.test(value)) throw new TypeError('memory_name_invalid');
    const normalized = value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase().normalize('NFC');
    if (!normalized.length) throw new TypeError('memory_name_invalid');
    return normalized;
}

export function canonicalSubject(subject, store) {
    return subject.type === 'owner'
        ? { type: 'entity', entity_type: 'person', id: store.self_person_id }
        : { ...subject };
}

export function eligibleNameAssertions(store) {
    const sources = new Map(store.sources.map(source => [source.id, source]));
    const explicit = new Set(store.evidence.filter(evidence => {
        const source = sources.get(evidence.source_id);
        return evidence.derivation === 'explicit' && source?.kind === 'user_statement'
            && source.origin_trust === 'user_asserted' && source.authority === 'data_only';
    }).map(evidence => evidence.assertion_id));
    return store.assertions.filter(record => record.status === 'active' && isEntityName(record.predicate) && explicit.has(record.id));
}

export function projectPerson(store, id) {
    const entity = store.entities.find(record => record.id === id && record.type === 'person');
    if (!entity) return null;
    const names = eligibleNameAssertions(store).filter(record => canonicalSubject(record.subject, store).id === id);
    return { id, type: 'person', createdAt: entity.created_at, isSelf: store.self_person_id === id,
        preferredName: names.find(record => record.predicate === 'entity.preferred_name')?.object.value ?? null,
        aliases: names.filter(record => record.predicate === 'entity.alias')
            .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(record => record.object.value) };
}
