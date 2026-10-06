import { readFileSync } from 'node:fs';

export const nexaEmailIdentity = Object.freeze({
    displayName: 'Nexa',
    title: 'Digital Intelligence | Assistant to Jorge Marcos',
    phone: '+506 4001 – 9867',
    phoneLink: '+50640019867',
    emergencyPhone: '+506 8512 - 9111',
    emergencyPhoneLink: '+50685129111',
    website: 'www.lifeguardcostarica.com',
    websiteUrl: 'https://www.lifeguardcostarica.com',
    logo: Object.freeze({
        name: 'lifeguard-costa-rica.jpg',
        contentId: 'nexa-lifeguard-logo',
        contentType: 'image/jpeg',
        contentBytes: readFileSync(new URL('./assets/lifeguard-costa-rica.jpg', import.meta.url)).toString('base64'),
        alt: 'Lifeguard Costa Rica',
        width: 288,
        height: 65,
    }),
});
