import {
    validateDeviceContract,
    validateIdentityDirectory,
    validateInstallationContract,
    validatePrincipalContract,
    validateSessionContract,
} from './identity-contracts.js';

/**
 * Pure policy evaluation for C.5g.2. A hypothetical ALLOW is a policy result
 * over synthetic/data-only state; it is never an executable authorization.
 * Real execution remains DENY until trusted authentication and grant storage
 * are implemented and connected at a separate runtime boundary.
 */

export const AUTHORIZATION_POLICY_VERSION = 'c5g2-v1';
export const AUTHORIZATION_CATEGORIES = Object.freeze({
    permissions: Object.freeze([
        'tool.execute', 'data.read', 'data.write', 'external.action', 'automation.manage',
        'memory.personal.read', 'memory.private.read', 'memory.shared.read', 'memory.write',
        'admin.users', 'admin.devices', 'admin.permissions',
    ]),
    actions: Object.freeze(['read', 'write', 'execute', 'administer', 'external_action', 'automate']),
    scopes: Object.freeze(['own', 'private', 'shared', 'installation', 'account']),
    risks: Object.freeze(['normal', 'elevated', 'critical']),
});

const PERMISSION_ACTIONS = Object.freeze({
    'tool.execute': ['execute'], 'data.read': ['read'], 'data.write': ['write'],
    'external.action': ['external_action'], 'automation.manage': ['automate'],
    'memory.personal.read': ['read'], 'memory.private.read': ['read'], 'memory.shared.read': ['read'],
    'memory.write': ['write'], 'admin.users': ['administer'], 'admin.devices': ['administer'],
    'admin.permissions': ['administer'],
});
const PERMISSION_SCOPES = Object.freeze({
    'tool.execute': ['installation'],
    'data.read': ['own', 'private', 'shared', 'account'], 'data.write': ['own', 'shared', 'account'],
    'external.action': ['account', 'installation'], 'automation.manage': ['own', 'installation'],
    'memory.personal.read': ['own'], 'memory.private.read': ['private'], 'memory.shared.read': ['shared'],
    'memory.write': ['own', 'shared'], 'admin.users': ['installation'], 'admin.devices': ['installation'],
    'admin.permissions': ['installation'],
});
const PERMISSION_RESOURCE_PREFIXES = Object.freeze({
    'tool.execute': ['tool.'], 'data.read': ['email.', 'calendar.', 'file.', 'whatsapp.', 'spotify.', 'application.'],
    'data.write': ['email.', 'calendar.', 'file.', 'whatsapp.', 'spotify.', 'application.'],
    'external.action': ['external.', 'spotify.', 'whatsapp.', 'email.', 'calendar.'],
    'automation.manage': ['automation.'],
    'memory.personal.read': ['memory.'], 'memory.private.read': ['memory.'], 'memory.shared.read': ['memory.'],
    'memory.write': ['memory.'], 'admin.users': ['admin.'], 'admin.devices': ['admin.'],
    'admin.permissions': ['admin.'],
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PRINCIPAL_ID = /^principal_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RESOURCE = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/u;
const GRANT_KEYS = ['grantId', 'installationId', 'principalId', 'principalEpoch', 'permission', 'resourcePattern',
    'scope', 'issuedAt', 'expiresAt', 'revokedAt', 'grantedByPrincipalId'];

function exactRecord(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
    const own = Reflect.ownKeys(value);
    return own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key)
        && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
}

function resourceCategory(resource) {
    return typeof resource === 'string' ? resource.split('.', 1)[0] : null;
}

function deny(code, input = null, mode = 'execution', requirements = []) {
    return Object.freeze({
        decision: 'DENY',
        mode,
        executable: false,
        reasonCode: code,
        additionalRequirements: Object.freeze([...requirements]),
        audit: Object.freeze({ policyVersion: AUTHORIZATION_POLICY_VERSION,
            principalId: mode === 'hypothetical' && typeof input?.principalId === 'string' ? input.principalId : null,
            action: input?.request?.action ?? null, resource: resourceCategory(input?.request?.resource) }),
    });
}

function allowHypothetical(input) {
    return Object.freeze({
        decision: 'ALLOW',
        mode: 'hypothetical',
        executable: false,
        reasonCode: 'hypothetical_policy_requirements_satisfied',
        additionalRequirements: Object.freeze([]),
        audit: Object.freeze({ policyVersion: AUTHORIZATION_POLICY_VERSION,
            principalId: input.principalId, action: input.request.action,
            resource: resourceCategory(input.request.resource) }),
    });
}

function validGrant(grant) {
    return exactRecord(grant, GRANT_KEYS)
        && typeof grant.grantId === 'string' && UUID.test(grant.grantId)
        && typeof grant.installationId === 'string' && UUID.test(grant.installationId)
        && typeof grant.principalId === 'string' && PRINCIPAL_ID.test(grant.principalId)
        && Number.isSafeInteger(grant.principalEpoch) && grant.principalEpoch >= 0
        && AUTHORIZATION_CATEGORIES.permissions.includes(grant.permission)
        && typeof grant.resourcePattern === 'string'
        && (RESOURCE.test(grant.resourcePattern) || (/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*\.\*$/u.test(grant.resourcePattern)
            && grant.resourcePattern !== '*'))
        && PERMISSION_SCOPES[grant.permission]?.includes(grant.scope)
        && PERMISSION_RESOURCE_PREFIXES[grant.permission]?.some(prefix => grant.resourcePattern.startsWith(prefix))
        && typeof grant.issuedAt === 'string' && Number.isFinite(Date.parse(grant.issuedAt))
        && typeof grant.expiresAt === 'string' && Number.isFinite(Date.parse(grant.expiresAt))
        && (grant.revokedAt === null || (typeof grant.revokedAt === 'string' && Number.isFinite(Date.parse(grant.revokedAt))))
        && typeof grant.grantedByPrincipalId === 'string' && PRINCIPAL_ID.test(grant.grantedByPrincipalId)
        && Date.parse(grant.expiresAt) > Date.parse(grant.issuedAt);
}

function validConsent(consent, subjectId, principalId, at) {
    const keys = ['consentId', 'subjectPrincipalId', 'grantedToPrincipalId', 'grantedAt', 'expiresAt', 'revokedAt'];
    return exactRecord(consent, keys)
        && typeof consent.consentId === 'string' && UUID.test(consent.consentId)
        && consent.subjectPrincipalId === subjectId && consent.grantedToPrincipalId === principalId
        && typeof consent.grantedAt === 'string' && Number.isFinite(Date.parse(consent.grantedAt))
        && typeof consent.expiresAt === 'string' && Number.isFinite(Date.parse(consent.expiresAt))
        && Date.parse(consent.grantedAt) <= at && Date.parse(consent.expiresAt) > at
        && (consent.revokedAt === null || (typeof consent.revokedAt === 'string'
            && Number.isFinite(Date.parse(consent.revokedAt)) && Date.parse(consent.revokedAt) > at));
}

function validRequirement(value) {
    return exactRecord(value, ['permission', 'action', 'resource', 'scope'])
        && typeof value.permission === 'string' && AUTHORIZATION_CATEGORIES.permissions.includes(value.permission)
        && typeof value.action === 'string' && PERMISSION_ACTIONS[value.permission]?.includes(value.action)
        && typeof value.resource === 'string' && RESOURCE.test(value.resource)
        && PERMISSION_RESOURCE_PREFIXES[value.permission]?.some(prefix => value.resource.startsWith(prefix))
        && typeof value.scope === 'string' && PERMISSION_SCOPES[value.permission]?.includes(value.scope);
}

function matchesResource(pattern, resource) {
    if (pattern === resource) return true;
    if (!pattern.endsWith('.*')) return false;
    const prefix = pattern.slice(0, -1);
    return resource.startsWith(prefix) && resource.length > prefix.length;
}

function requestShape(request) {
    const keys = ['action', 'resource', 'scope', 'toolName', 'deviceRequired', 'subjectPrincipalId', 'subjectConsent',
        'requirements', 'independentConfirmation'];
    return exactRecord(request, keys)
        && AUTHORIZATION_CATEGORIES.actions.includes(request.action)
        && typeof request.resource === 'string' && RESOURCE.test(request.resource)
        && AUTHORIZATION_CATEGORIES.scopes.includes(request.scope)
        && (request.toolName === null || (typeof request.toolName === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(request.toolName)))
        && typeof request.deviceRequired === 'boolean'
        && (request.subjectPrincipalId === null || (typeof request.subjectPrincipalId === 'string' && PRINCIPAL_ID.test(request.subjectPrincipalId)))
        && (request.subjectConsent === null || typeof request.subjectConsent === 'object')
        && Array.isArray(request.requirements) && request.requirements.length > 0
        && request.requirements.every(validRequirement)
        && request.requirements.some(requirement => requirement.action === request.action
            && requirement.resource === request.resource && requirement.scope === request.scope)
        && (request.action === 'execute'
            ? request.requirements.every(requirement => requirement.permission !== 'tool.execute'
                || requirement.resource === `tool.${request.toolName}`)
            : request.requirements.every(requirement => requirement.action === request.action))
        && typeof request.independentConfirmation === 'boolean';
}

function inputShape(input) {
    const validGrants = Array.isArray(input?.grants) && input.grants.every(validGrant);
    if (!validGrants) return false;
    const ids = new Set();
    const bindings = new Set();
    for (const grant of input.grants) {
        const binding = JSON.stringify([grant.installationId, grant.principalId, grant.principalEpoch,
            grant.permission, grant.resourcePattern, grant.scope]);
        if (ids.has(grant.grantId) || bindings.has(binding)) return false;
        ids.add(grant.grantId);
        bindings.add(binding);
    }
    return exactRecord(input, ['mode', 'installation', 'principals', 'principalId', 'session', 'device',
        'grants', 'request', 'risk', 'evaluatedAt', 'expectedRevision', 'currentRevision'])
        && ['hypothetical', 'execution'].includes(input.mode)
        && Array.isArray(input.principals)
        && typeof input.principalId === 'string' && PRINCIPAL_ID.test(input.principalId)
        && (input.device === null || typeof input.device === 'object')
        && validGrants
        && requestShape(input.request)
        && AUTHORIZATION_CATEGORIES.risks.includes(input.risk)
        && typeof input.evaluatedAt === 'string' && Number.isFinite(Date.parse(input.evaluatedAt))
        && Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0
        && Number.isSafeInteger(input.currentRevision) && input.currentRevision >= 0;
}

/** Validate the strict data-only permission grant shape. */
export function validatePermissionGrantContract(value) {
    return validGrant(value);
}

/**
 * Evaluate policy over a data snapshot. Only `mode: hypothetical` may return
 * ALLOW, and it always carries `executable: false`. Execution mode is fail-closed
 * independent of all caller-supplied principal/session/role/permission claims.
 */
export function evaluateAuthorizationPolicy(input) {
    try {
        if (input?.mode === 'execution') return deny('trusted_authentication_unavailable', null, 'execution', [
            'native_authenticated_principal', 'trusted_session', 'trusted_grant_registry', 'request_bound_capability',
        ]);
        if (input?.mode !== 'hypothetical') return deny('evaluation_mode_invalid');
        if (!inputShape(input)) return deny('authorization_input_invalid', input, 'hypothetical');

        const at = Date.parse(input.evaluatedAt);
        const { installation, request } = input;
        if (!validateIdentityDirectory(installation, input.principals).valid)
            return deny('identity_snapshot_invalid', input, 'hypothetical');
        const principal = input.principals.find(item => item.principalId === input.principalId);
        if (!principal || !validatePrincipalContract(principal).valid || principal.accountStatus !== 'active')
            return deny('principal_inactive_or_missing', input, 'hypothetical');
        if (principal.authenticationState !== 'authenticated' || principal.assuranceLevel === 'none')
            return deny('principal_not_verified', input, 'hypothetical');
        const { session } = input;
        if (!validateSessionContract(session) || session.revokedAt !== null || Date.parse(session.expiresAt) <= at
            || session.installationId !== installation.installationId || session.principalId !== principal.principalId
            || session.accountEpoch !== principal.accountEpoch || session.authenticationMethod !== principal.authenticationMethod
            || session.assuranceLevel !== principal.assuranceLevel)
            return deny('session_invalid_or_stale', input, 'hypothetical');
        if (input.expectedRevision !== input.currentRevision)
            return deny('authorization_snapshot_stale', input, 'hypothetical');

        if (!request.requirements.some(requirement => requirement.action === request.action))
            return deny('permission_action_mismatch', input, 'hypothetical');

        if ((request.deviceRequired || session.deviceId !== null) && input.device === null)
            return deny('device_required', input, 'hypothetical', ['registered_active_device']);
        if (input.device !== null) {
            if (!validateDeviceContract(input.device) || input.device.status !== 'active'
                || input.device.installationId !== installation.installationId
                || input.device.principalId !== principal.principalId || session.deviceId !== input.device.deviceId)
                return deny('device_invalid_or_revoked', input, 'hypothetical');
        }
        if (input.request.toolName !== null) {
            if (request.action !== 'execute') return deny('tool_action_mismatch', input, 'hypothetical');
            const exactTool = `tool.${input.request.toolName}`;
            if (!input.request.requirements.some(requirement => requirement.permission === 'tool.execute'
                && requirement.action === 'execute' && requirement.resource === exactTool && requirement.scope === 'installation'))
                return deny('tool_execution_permission_missing', input, 'hypothetical');
        }
        if (request.action === 'execute' && request.toolName === null)
            return deny('tool_name_required', input, 'hypothetical');
        if (request.action !== 'execute' && request.requirements.some(item => item.permission === 'tool.execute'))
            return deny('tool_action_mismatch', input, 'hypothetical');
        const hasAdministrativeRequirement = request.requirements.some(item => item.action === 'administer');
        if (hasAdministrativeRequirement !== (request.action === 'administer'))
            return deny('administrative_action_mismatch', input, 'hypothetical');
        if (request.action === 'administer') {
            if (principal.role !== 'owner') return deny('owner_role_required', input, 'hypothetical');
            if (principal.assuranceLevel !== 'strong') return deny('strong_authentication_required', input, 'hypothetical', ['strong_authentication']);
            if (!request.requirements.some(item => ['admin.users', 'admin.devices', 'admin.permissions'].includes(item.permission)))
                return deny('administrative_permission_required', input, 'hypothetical');
        }
        if (input.risk === 'critical' && principal.assuranceLevel !== 'strong')
            return deny('strong_authentication_required', input, 'hypothetical', ['strong_authentication']);
        if (input.risk === 'critical' && !request.independentConfirmation)
            return deny('independent_confirmation_required', input, 'hypothetical', ['independent_confirmation']);

        for (const requirement of request.requirements) {
            if (requirement.scope === 'own' && request.subjectPrincipalId !== null
                && request.subjectPrincipalId !== principal.principalId)
                return deny('own_scope_subject_mismatch', input, 'hypothetical');
            const grant = input.grants.find(item => {
                const grantor = input.principals.find(candidate => candidate.principalId === item.grantedByPrincipalId);
                return item.principalId === principal.principalId
                    && item.installationId === installation.installationId
                    && item.principalEpoch === principal.accountEpoch
                    && item.permission === requirement.permission && item.scope === requirement.scope
                    && matchesResource(item.resourcePattern, requirement.resource)
                    && item.revokedAt === null && Date.parse(item.issuedAt) <= at && Date.parse(item.expiresAt) > at
                    && grantor?.role === 'owner' && grantor.accountStatus === 'active'
                    && grantor.authenticationState === 'authenticated' && grantor.assuranceLevel === 'strong';
            });
            if (!grant) return deny('explicit_permission_missing_or_out_of_scope', input, 'hypothetical');

            if (requirement.scope === 'private' && request.subjectPrincipalId !== principal.principalId) {
                const subject = input.principals.find(item => item.principalId === request.subjectPrincipalId);
                if (grant.permission !== 'memory.private.read' || !validConsent(request.subjectConsent,
                    request.subjectPrincipalId, principal.principalId, at) || !subject
                    || subject.accountStatus !== 'active' || subject.authenticationState !== 'authenticated')
                    return deny('private_subject_consent_required', input, 'hypothetical', ['subject_specific_consent']);
            }
        }

        return allowHypothetical(input);
    } catch {
        return deny('authorization_input_invalid');
    }
}
