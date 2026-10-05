export const toolPermissions = Object.freeze({
    get_current_time: 'read',
    recall: 'read',
    remember: 'write',
    forget: 'write',
    get_weather: 'external_read',
    web_search: 'external_read',
});

export const defaultPermissionPolicy = Object.freeze({
    read: true,
    external_read: true,
    write: true,
    destructive: false,
});

export function checkToolPermission(registration, policy = defaultPermissionPolicy) {
    const permission = registration?.permission;
    const allowed = typeof permission === 'string'
        && policy !== null
        && typeof policy === 'object'
        && Object.hasOwn(policy, permission)
        && policy[permission] === true;

    return {
        allowed,
        permission: permission ?? null,
        reason: allowed ? null : 'permission_denied',
    };
}
