export function createCommunicationsService({ emailProvider }) {
    if (!emailProvider || typeof emailProvider.getConnectionStatus !== 'function' || typeof emailProvider.getMailboxes !== 'function') throw new TypeError('email_provider_invalid');
    async function safelyCall(operation) {
        try { return await operation(); }
        catch { return { success: false, error: { code: 'communications_unavailable', message: 'El servicio de correo no está disponible en este momento.' } }; }
    }
    return {
        getConnectionStatus: () => safelyCall(() => emailProvider.getConnectionStatus()),
        getMailboxes: () => safelyCall(() => emailProvider.getMailboxes()),
    };
}
