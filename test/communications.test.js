import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommunicationsService } from '../src/communications/service.js';
import { getMicrosoftConfiguration, microsoftGraphScopes } from '../src/communications/config.js';
import { createMicrosoftGraphProvider, normalizeMailbox } from '../src/communications/providers/microsoft-graph.js';
import { createMicrosoftAuth, microsoftTokenPath } from '../src/integrations/microsoft/auth.js';
import { communicationsRegistrations } from '../src/communications/tools.js';
import { checkToolPermission, defaultPermissionPolicy } from '../src/tools/permissions.js';
import { localToolRegistry } from '../src/tools/index.js';
import { DataProtectionScope } from '@azure/msal-node-extensions';

const environment = { MICROSOFT_CLIENT_ID: 'client-id', MICROSOFT_TENANT_ID: 'organizations', MICROSOFT_SHARED_MAILBOXES: 'sales@example.com, hr@example.com, SALES@example.com' };

test('Microsoft config validates client/tenant and normalizes configured shared addresses', () => {
    const config = getMicrosoftConfiguration(environment);
    assert.equal(config.success, true);
    assert.deepEqual(config.sharedMailboxes, ['sales@example.com', 'hr@example.com']);
    assert.equal(getMicrosoftConfiguration({ MICROSOFT_CLIENT_ID: '' }).success, false);
    assert.equal(getMicrosoftConfiguration({ ...environment, MICROSOFT_SHARED_MAILBOXES: 'not-an-address' }).success, false);
});

test('OAuth requests only delegated identity, mail, and calendar read/write scopes required by configured tools', () => {
    assert.deepEqual(microsoftGraphScopes, ['User.Read', 'Mail.Read', 'Mail.Read.Shared', 'Mail.Send', 'Mail.Send.Shared', 'Calendars.ReadWrite', 'Calendars.ReadWrite.Shared']);
    assert(microsoftGraphScopes.every(scope => !/\.all|contacts|offline_access/iu.test(scope)));
});

test('normalizes provider-independent personal/shared mailbox records', () => {
    assert.deepEqual(normalizeMailbox({ id: 'id-1', address: 'USER@Example.com', displayName: 'User', type: 'personal' }), {
        id: 'id-1', provider: 'microsoft', address: 'user@example.com', displayName: 'User', type: 'personal',
    });
    assert.equal(normalizeMailbox({ id: '', address: 'a@b.com', type: 'shared' }), null);
    assert.equal(normalizeMailbox({ id: 'id', address: 'a@b.com', type: 'unknown' }), null);
});

test('communications service delegates to an interchangeable email provider', async () => {
    const calls = [];
    const service = createCommunicationsService({ emailProvider: {
        async getConnectionStatus() { calls.push('status'); return { success: true, connected: false }; },
        async getMailboxes() { calls.push('mailboxes'); return { success: true, mailboxes: [] }; },
    } });
    assert.deepEqual(await service.getConnectionStatus(), { success: true, connected: false });
    assert.deepEqual(await service.getMailboxes(), { success: true, mailboxes: [] });
    assert.deepEqual(calls, ['status', 'mailboxes']);
    const unsafe = createCommunicationsService({ emailProvider: {
        async getConnectionStatus() { throw new Error('access token should never leak'); },
        async getMailboxes() { throw new Error('private Graph payload should never leak'); },
    } });
    assert.deepEqual(await unsafe.getConnectionStatus(), { success: false, error: { code: 'communications_unavailable', message: 'El servicio de correo no está disponible en este momento.' } });
    assert(!JSON.stringify(await unsafe.getMailboxes()).includes('private Graph payload'));
    assert.throws(() => createCommunicationsService({ emailProvider: {} }), /email_provider_invalid/u);
});

test('Microsoft Graph provider reports a disconnected state without making requests', async () => {
    let calls = 0;
    const provider = createMicrosoftGraphProvider({ environment, auth: { async getAccessToken() { return null; } }, fetchImpl: async () => { calls++; } });
    assert.deepEqual(await provider.getConnectionStatus(), { success: true, connected: false, provider: 'microsoft' });
    assert.equal((await provider.getMailboxes()).error.code, 'email_not_connected');
    assert.equal(calls, 0);
});

test('lists the personal mailbox and only configured shared mailboxes validated by Graph', async () => {
    const calls = [];
    const provider = createMicrosoftGraphProvider({ environment, auth: { async getAccessToken() { return 'secret-token'; } }, fetchImpl: async (url, options) => {
        calls.push({ url: url.href, options });
        if (url.pathname.endsWith('/me')) return { ok: true, async json() { return { id: 'me-id', mail: 'jor@example.com', displayName: 'Jor' }; } };
        if (url.pathname.includes('sales%40example.com')) return { ok: true, async json() { return { id: 'inbox-id' }; } };
        return { ok: false, status: 403, async json() { throw new Error('secret-token leaked'); } };
    } });
    const result = await provider.getMailboxes();
    assert.equal(result.success, true);
    assert.deepEqual(result.mailboxes.map(({ address, type }) => [address, type]), [['jor@example.com', 'personal'], ['sales@example.com', 'shared']]);
    assert.deepEqual(result.sharedMailboxIssues, [{ address: 'hr@example.com', code: 'microsoft_access_denied' }]);
    assert.equal(calls.length, 3);
    assert(calls.every(call => call.options.method === 'GET'));
    assert(calls.every(call => call.options.headers.authorization === 'Bearer secret-token'));
    assert(calls.some(call => call.url.includes('/users/sales%40example.com/mailFolders/inbox')));
    assert(!JSON.stringify(result).includes('secret-token'));
});

test('Graph error responses are sanitized and do not expose response bodies or tokens', async () => {
    const provider = createMicrosoftGraphProvider({ environment, auth: { async getAccessToken() { return 'hidden-token'; } }, fetchImpl: async () => ({ ok: false, status: 403, async json() { return { error: 'hidden-token and private body' }; } }) });
    const result = await provider.getConnectionStatus();
    assert.equal(result.error.code, 'microsoft_access_denied');
    assert(!JSON.stringify(result).includes('hidden-token'));
    assert(!JSON.stringify(result).includes('private body'));
});

test('MSAL uses current-user protected cache and never exposes tokens to callers', async () => {
    let persistenceConfig;
    let msalConfig;
    const auth = createMicrosoftAuth({ environment, tokenPath: 'test-cache.json',
        persistenceFactory: async config => { persistenceConfig = config; return { fake: true }; },
        cachePluginFactory: persistence => ({ persistence }),
        clientFactory: config => { msalConfig = config; return {
            getTokenCache: () => ({ async getAllAccounts() { return [{ username: 'jor@example.com' }]; } }),
            async acquireTokenSilent(request) { assert.deepEqual(request.scopes, [...microsoftGraphScopes]); return { accessToken: 'never-return-this-to-the-agent' }; },
        }; },
    });
    assert.equal(await auth.getAccessToken(), 'never-return-this-to-the-agent');
    assert.equal(persistenceConfig.dataProtectionScope, DataProtectionScope.CurrentUser);
    assert.equal(persistenceConfig.cachePath, 'test-cache.json');
    assert.equal(msalConfig.auth.authority, 'https://login.microsoftonline.com/organizations');
    assert.match(microsoftTokenPath, /data[\\/]microsoft-token\.json$/u);
});

test('explicit OAuth connection uses the minimal scopes and sanitizes tenant consent failures', async () => {
    let request;
    const auth = createMicrosoftAuth({ environment,
        persistenceFactory: async () => ({}), cachePluginFactory: () => ({}), browserOpener: async url => assert(url.startsWith('https://login.microsoftonline.com/')),
        clientFactory: () => ({ async acquireTokenInteractive(options) { request = options; return { account: { username: 'jor@example.com' }, accessToken: 'secret' }; } }),
    });
    const connected = await auth.connect();
    assert.deepEqual(connected, { success: true, account: { username: 'jor@example.com' } });
    assert.deepEqual(request.scopes, [...microsoftGraphScopes]);
    assert.equal(request.prompt, 'select_account');

    const denied = createMicrosoftAuth({ environment, persistenceFactory: async () => ({}), cachePluginFactory: () => ({}),
        clientFactory: () => ({ async acquireTokenInteractive() { const error = new Error('secret diagnostic'); error.errorCode = 'consent_required'; throw error; } }),
    });
    const result = await denied.connect();
    assert.equal(result.error.code, 'microsoft_admin_consent_required');
    assert(!JSON.stringify(result).includes('secret diagnostic'));
});

test('communications tools register calendar writes as preparation actions, not direct write tools', () => {
    assert.deepEqual(communicationsRegistrations.map(registration => registration.definition.name), ['get_email_connection_status', 'list_email_mailboxes', 'list_recent_emails', 'search_emails', 'get_email', 'prepare_email', 'prepare_email_reply', 'confirm_pending_action', 'cancel_pending_action', 'resolve_pending_action', 'list_calendar_events', 'get_calendar_event', 'prepare_calendar_event', 'prepare_calendar_event_update', 'prepare_calendar_event_cancel']);
    for (const name of ['get_email_connection_status', 'list_email_mailboxes', 'list_recent_emails', 'search_emails', 'get_email', 'prepare_email', 'prepare_email_reply']) {
        assert.equal(localToolRegistry.get(name)?.permission, 'read');
        assert.equal(checkToolPermission(localToolRegistry.get(name), defaultPermissionPolicy).allowed, true);
        if (['get_email_connection_status', 'list_email_mailboxes'].includes(name)) assert.deepEqual(localToolRegistry.get(name).definition.parameters.properties, {});
    }
    for (const name of ['confirm_pending_action', 'cancel_pending_action', 'resolve_pending_action']) {
        assert.equal(localToolRegistry.get(name)?.permission, 'action');
        assert.equal(checkToolPermission(localToolRegistry.get(name), defaultPermissionPolicy).allowed, true);
    }
    assert.equal(localToolRegistry.has('send_email'), false);
    for (const name of ['list_calendar_events', 'get_calendar_event']) {
        assert.equal(localToolRegistry.get(name)?.permission, 'read');
        assert.equal(checkToolPermission(localToolRegistry.get(name), defaultPermissionPolicy).allowed, true);
    }
    for (const name of ['prepare_calendar_event', 'prepare_calendar_event_update', 'prepare_calendar_event_cancel']) {
        assert.equal(localToolRegistry.get(name)?.permission, 'action');
        assert.equal(checkToolPermission(localToolRegistry.get(name), defaultPermissionPolicy).allowed, true);
    }
    for (const name of ['create_calendar_event', 'update_calendar_event', 'cancel_calendar_event']) assert.equal(localToolRegistry.has(name), false);
});
