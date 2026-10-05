import { getWhatsAppBrowser, closeWhatsAppBrowser } from './bridge/session.js';

const browser = getWhatsAppBrowser();
console.log('Abriendo WhatsApp Web. Escaneá el QR o completá el login oficial en la ventana que aparece.');
console.log('Nexa no leerá ni automatizará el QR, credenciales ni verificación en dos pasos.');
const result = await browser.waitForAuthentication();
if (result.success) console.log('WhatsApp Web quedó autenticado. El perfil local se conservará para Nexa.');
else console.error(`No se pudo completar la autenticación: ${result.error.code}`);
await closeWhatsAppBrowser();
if (!result.success) process.exitCode = 1;

