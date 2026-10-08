/**
 * Inactive contracts for the future multi-user identity layer.
 *
 * These validators check data shape and invariants only. They do not authenticate
 * principals, issue capabilities, bootstrap an Owner, grant permissions, or
 * authorize memory access. No runtime component consumes these contracts yet.
 */

export const IDENTITY_STATES = Object.freeze({
    account: Object.freeze(['pending', 'active', 'suspended', 'revoked']),
    role: Object.freeze(['owner', 'member']),
    authentication: Object.freeze(['unauthenticated', 'authenticated']),
    assurance: Object.freeze(['none', 'standard', 'strong']),
    bootstrap: Object.freeze(['uninitialized', 'pending', 'active', 'recovery_required']),
    adminActions: Object.freeze(['invite_user', 'approve_identity_link', 'grant_permission',
        'revoke_permission', 'suspend_user', 'revoke_user', 'bind_device', 'revoke_device', 'recover_owner']),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PRINCIPAL_ID = /^principal_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PERSON_ID = /^person_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function exactRecord(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
    const own = Reflect.ownKeys(value);
    return own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key)
        && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
}

function result(valid, code = valid ? 'valid_contract' : 'identity_contract_invalid') {
    return Object.freeze({ valid, code });
}

function isNullableUuid(value) { return value === null || (typeof value === 'string' && UUID.test(value)); }

/** Validate installation metadata only; this does not establish an Owner. */
export function validateInstallationContract(value) {
    if (!exactRecord(value, ['schemaVersion', 'installationId', 'bootstrapState', 'ownerPrincipalId', 'ownerEpoch'])
        || value.schemaVersion !== 1 || typeof value.installationId !== 'string' || !UUID.test(value.installationId)
        || !IDENTITY_STATES.bootstrap.includes(value.bootstrapState)
        || !(value.ownerPrincipalId === null || (typeof value.ownerPrincipalId === 'string' && PRINCIPAL_ID.test(value.ownerPrincipalId)))
        || !Number.isSafeInteger(value.ownerEpoch) || value.ownerEpoch < 0) return result(false);
    if (value.bootstrapState === 'uninitialized') {
        return value.ownerPrincipalId === null && value.ownerEpoch === 0
            ? result(true) : result(false, 'bootstrap_state_inconsistent');
    }
    if (value.bootstrapState === 'active') {
        return value.ownerPrincipalId !== null && value.ownerEpoch > 0
            ? result(true) : result(false, 'owner_state_inconsistent');
    }
    // A pending or recovery state must not silently claim a usable Owner.
    return value.ownerPrincipalId === null ? result(true) : result(false, 'owner_state_inconsistent');
}

/** Validate a principal record as data. `role: owner` is not an authority proof. */
export function validatePrincipalContract(value) {
    if (!exactRecord(value, ['principalId', 'accountStatus', 'role', 'authenticationState',
        'assuranceLevel', 'authenticationMethod', 'memoryPersonId', 'accountEpoch'])
        || typeof value.principalId !== 'string' || !PRINCIPAL_ID.test(value.principalId)
        || !IDENTITY_STATES.account.includes(value.accountStatus) || !IDENTITY_STATES.role.includes(value.role)
        || !IDENTITY_STATES.authentication.includes(value.authenticationState)
        || !IDENTITY_STATES.assurance.includes(value.assuranceLevel)
        || !(value.authenticationMethod === null || (typeof value.authenticationMethod === 'string'
            && ['native_passkey', 'native_windows_hello', 'native_platform_authenticator'].includes(value.authenticationMethod)))
        || !(value.memoryPersonId === null || (typeof value.memoryPersonId === 'string' && PERSON_ID.test(value.memoryPersonId)))
        || !Number.isSafeInteger(value.accountEpoch) || value.accountEpoch < 0) return result(false);
    if (value.authenticationState === 'unauthenticated') {
        return value.assuranceLevel === 'none' && value.authenticationMethod === null
            ? result(true) : result(false, 'authentication_state_inconsistent');
    }
    return value.assuranceLevel !== 'none' && value.authenticationMethod !== null
        ? result(true) : result(false, 'authentication_state_inconsistent');
}

/** Enforce a single Owner slot across a directory; it does not grant Owner powers. */
export function validateIdentityDirectory(installation, principals) {
    const installationResult = validateInstallationContract(installation);
    if (!installationResult.valid || !Array.isArray(principals)) return result(false);
    const seen = new Set();
    let owners = 0;
    for (const principal of principals) {
        if (!validatePrincipalContract(principal).valid || seen.has(principal.principalId)) return result(false, 'principal_directory_invalid');
        seen.add(principal.principalId);
        if (principal.role === 'owner') {
            owners++;
            if (principal.accountStatus === 'revoked') return result(false, 'owner_revoked');
        }
    }
    if (installation.bootstrapState === 'active') {
        return owners === 1 && principals.some(item => item.principalId === installation.ownerPrincipalId
            && item.role === 'owner' && item.accountStatus === 'active')
            ? result(true) : result(false, 'owner_directory_inconsistent');
    }
    return owners === 0 ? result(true) : result(false, 'owner_exists_before_bootstrap');
}

/** A data-only session description. It is never accepted as authentication proof. */
export function validateSessionContract(value) {
    return exactRecord(value, ['sessionId', 'installationId', 'principalId', 'accountEpoch', 'deviceId',
        'authenticationMethod', 'assuranceLevel', 'expiresAt', 'revokedAt'])
        && typeof value.sessionId === 'string' && UUID.test(value.sessionId)
        && typeof value.installationId === 'string' && UUID.test(value.installationId)
        && typeof value.principalId === 'string' && PRINCIPAL_ID.test(value.principalId)
        && Number.isSafeInteger(value.accountEpoch) && value.accountEpoch >= 0
        && isNullableUuid(value.deviceId)
        && (value.authenticationMethod === null || ['native_passkey', 'native_windows_hello', 'native_platform_authenticator'].includes(value.authenticationMethod))
        && IDENTITY_STATES.assurance.includes(value.assuranceLevel)
        && typeof value.expiresAt === 'string' && Number.isFinite(Date.parse(value.expiresAt))
        && (value.revokedAt === null || (typeof value.revokedAt === 'string' && Number.isFinite(Date.parse(value.revokedAt))));
}

/** Device registration is a future account link, never device authentication. */
export function validateDeviceContract(value) {
    return exactRecord(value, ['deviceId', 'installationId', 'principalId', 'status', 'createdAt', 'revokedAt'])
        && typeof value.deviceId === 'string' && UUID.test(value.deviceId)
        && typeof value.installationId === 'string' && UUID.test(value.installationId)
        && typeof value.principalId === 'string' && PRINCIPAL_ID.test(value.principalId)
        && ['pending', 'active', 'suspended', 'revoked'].includes(value.status)
        && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt))
        && (value.revokedAt === null || (typeof value.revokedAt === 'string' && Number.isFinite(Date.parse(value.revokedAt))))
        && ((value.status === 'revoked') === (value.revokedAt !== null));
}

/** Voice is a speaker-identification signal only; confidence cannot authenticate. */
export function validateSpeakerSignal(value) {
    return exactRecord(value, ['speakerPersonId', 'method', 'confidence', 'observedAt'])
        && (value.speakerPersonId === null || (typeof value.speakerPersonId === 'string' && PERSON_ID.test(value.speakerPersonId)))
        && ['voice_match', 'unknown', 'manual_selection'].includes(value.method)
        && (value.confidence === null || (typeof value.confidence === 'number'
            && Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1))
        && typeof value.observedAt === 'string' && Number.isFinite(Date.parse(value.observedAt));
}

/** Attribution fields distinguish speaker, fact subject, and information contributor. */
export function validateMemoryAttributionContract(value) {
    return exactRecord(value, ['speakerPersonId', 'subjectPersonId', 'contributorPrincipalId', 'sourceKind'])
        && (value.speakerPersonId === null || (typeof value.speakerPersonId === 'string' && PERSON_ID.test(value.speakerPersonId)))
        && (value.subjectPersonId === null || (typeof value.subjectPersonId === 'string' && PERSON_ID.test(value.subjectPersonId)))
        && (value.contributorPrincipalId === null || (typeof value.contributorPrincipalId === 'string'
            && PRINCIPAL_ID.test(value.contributorPrincipalId)))
        && ['direct_user', 'tool_output', 'imported', 'model_output', 'unknown'].includes(value.sourceKind);
}

/** Validate a requested administrative action without executing or authorizing it. */
export function validateAdministrativeRequest(value) {
    if (!exactRecord(value, ['requestId', 'installationId', 'actorPrincipalId', 'actorAccountEpoch',
        'action', 'targetPrincipalId', 'targetDeviceId', 'permission', 'operationFingerprint', 'expiresAt'])
        || typeof value.requestId !== 'string' || !UUID.test(value.requestId)
        || typeof value.installationId !== 'string' || !UUID.test(value.installationId)
        || typeof value.actorPrincipalId !== 'string' || !PRINCIPAL_ID.test(value.actorPrincipalId)
        || !Number.isSafeInteger(value.actorAccountEpoch) || value.actorAccountEpoch < 0
        || !IDENTITY_STATES.adminActions.includes(value.action)
        || !(value.targetPrincipalId === null || (typeof value.targetPrincipalId === 'string' && PRINCIPAL_ID.test(value.targetPrincipalId)))
        || !(value.targetDeviceId === null || (typeof value.targetDeviceId === 'string' && UUID.test(value.targetDeviceId)))
        || !(value.permission === null || (typeof value.permission === 'string' && /^[a-z][a-z0-9_.:-]{0,95}$/u.test(value.permission)))
        || typeof value.operationFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(value.operationFingerprint)
        || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))) return result(false);
    return result(true);
}

/**
 * Check that a pending request still refers to the same active Owner/session
 * epochs. This only checks data consistency; it is not authorization and cannot
 * issue a capability or make an administrative action executable.
 */
export function validateAdministrativeRequestBinding(request, session, principal, installation) {
    if (!validateAdministrativeRequest(request).valid || !validateSessionContract(session)
        || !validatePrincipalContract(principal).valid || !validateInstallationContract(installation).valid)
        return result(false, 'request_binding_invalid');
    if (Date.parse(request.expiresAt) <= Date.now() || session.revokedAt !== null
        || Date.parse(session.expiresAt) <= Date.now()) return result(false, 'request_binding_expired');
    if (request.installationId !== installation.installationId || session.installationId !== installation.installationId
        || request.actorPrincipalId !== principal.principalId || session.principalId !== principal.principalId
        || request.actorAccountEpoch !== principal.accountEpoch || session.accountEpoch !== principal.accountEpoch)
        return result(false, 'request_binding_stale');
    if (installation.bootstrapState !== 'active' || installation.ownerPrincipalId !== principal.principalId
        || principal.role !== 'owner' || principal.accountStatus !== 'active')
        return result(false, 'request_binding_not_owner');
    return result(true, 'request_context_consistent_only');
}

/**
 * Production behavior remains fail-closed until a native trusted provider,
 * durable account registry, and independent confirmation flow exist.
 */
export function evaluateAdministrativeAuthorization(request, _session, _directory) {
    if (!validateAdministrativeRequest(request).valid) return Object.freeze({ authorized: false, code: 'request_invalid' });
    return Object.freeze({ authorized: false, code: 'trusted_authentication_provider_unavailable' });
}

/** No identity or role currently confers access to another user's private memory. */
export function evaluateMemoryScopeAccess(_principal, _session, _memoryPersonId, _scope) {
    return Object.freeze({ allowed: false, code: 'trusted_memory_scope_provider_unavailable' });
}

/** Bootstrap deliberately cannot proceed until native human authentication exists. */
export function evaluateOwnerBootstrap(_installation, _authenticationEvidence) {
    return Object.freeze({ allowed: false, code: 'trusted_bootstrap_provider_unavailable' });
}
