export const microsoftGraphScopes = Object.freeze(['User.Read', 'Mail.Read', 'Mail.Read.Shared', 'Mail.Send', 'Mail.Send.Shared']);

export function getMicrosoftConfiguration(environment = process.env) {
    const clientId = typeof environment.MICROSOFT_CLIENT_ID === 'string' ? environment.MICROSOFT_CLIENT_ID.trim() : '';
    const tenantId = typeof environment.MICROSOFT_TENANT_ID === 'string' ? environment.MICROSOFT_TENANT_ID.trim() : '';
    const entries = typeof environment.MICROSOFT_SHARED_MAILBOXES === 'string'
        ? environment.MICROSOFT_SHARED_MAILBOXES.split(',').map(value => value.trim()).filter(Boolean)
        : [];
    const sharedMailboxes = [...new Set(entries.map(value => value.toLocaleLowerCase('en-US')))];
    const validTenant = tenantId === 'organizations' || tenantId === 'common'
        || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(tenantId);
    const validAddresses = sharedMailboxes.every(value => value.length <= 254 && /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/u.test(value));
    if (!clientId || clientId.length > 128 || !tenantId || !validTenant || !validAddresses) {
        return { success: false, error: { code: 'microsoft_configuration_invalid', message: 'Configurá MICROSOFT_CLIENT_ID, MICROSOFT_TENANT_ID y las direcciones de MICROSOFT_SHARED_MAILBOXES en .env.' } };
    }
    return { success: true, clientId, tenantId, authority: `https://login.microsoftonline.com/${tenantId}`, sharedMailboxes };
}
