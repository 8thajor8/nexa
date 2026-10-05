// Keep WhatsApp Web's accessible labels and structural selectors in one place.
export const whatsappWebUrl = 'https://web.whatsapp.com/';

export const whatsappSelectors = Object.freeze({
    searchLabels: ['Search', 'Search input textbox', 'Search or start a new chat', 'Buscar', 'Buscar contactos', 'Buscar o iniciar un chat'],
    searchFallback: ['[role="textbox"][contenteditable="true"]', 'input[aria-label]'],
    resultRoles: ['row', 'listitem', 'button'],
    headerRoles: ['heading', 'banner'],
    headerFallback: ['header [title]', 'header [aria-label]'],
    authenticatedSelectors: ['#pane-side'],
    loginText: /use whatsapp on your computer|usar whatsapp en tu computadora|link with phone number|vincular con el teléfono|scan the qr code|escanea el código qr/i,
    composerLabels: ['Type a message', 'Escribe un mensaje', 'Escribir un mensaje'],
    composerFallback: ['footer [contenteditable="true"][role="textbox"]', 'footer [contenteditable="true"]'],
});
