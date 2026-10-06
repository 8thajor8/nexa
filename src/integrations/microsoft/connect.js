import 'dotenv/config';
import { microsoftAuth } from './auth.js';
import { createMicrosoftGraphProvider } from '../../communications/providers/microsoft-graph.js';
const connected = await microsoftAuth.connect();
if (!connected.success) {
    console.error(`${connected.error.code}: ${connected.error.message}`);
    process.exitCode = 1;
} else {
    const status = await createMicrosoftGraphProvider({ auth: microsoftAuth }).getConnectionStatus();
    if (!status.success || !status.connected) {
        console.error(status.error?.message ?? 'La autorización terminó, pero Nexa no pudo validar el mailbox personal.');
        process.exitCode = 1;
    } else console.log(`Nexa quedó conectada con Microsoft (${status.account}). La caché de sesión está protegida localmente.`);
}
