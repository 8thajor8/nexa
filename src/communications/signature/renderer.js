import { nexaEmailIdentity } from './identity.js';

const rendererId = 'nexa-email-signature-v1';

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/gu, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
}

function paragraphHtml(text) {
    return text.split(/\n{2,}/u).map(paragraph =>
        '<p style="margin:0 0 12px 0;">' + paragraph.split('\n').map(escapeHtml).join('<br>') + '</p>'
    ).join('');
}

function signatureHtml(identity) {
    const logo = identity.logo;
    return '<!-- ' + rendererId + ' -->'
        + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-family:Aptos,\'Arial Narrow\',Arial,sans-serif;color:#333333;">'
        + '<tr><td style="padding:8px 0 1px 0;font-size:18.67px;line-height:20px;font-weight:bold;color:#5e5e5e;">' + escapeHtml(identity.displayName) + '</td></tr>'
        + '<tr><td style="padding:0 0 4px 0;font-size:17.33px;line-height:19px;font-weight:bold;color:#154fa0;">' + escapeHtml(identity.title) + '</td></tr>'
        + '<tr><td style="padding:0;font-size:14px;line-height:16px;color:#333333;"><span style="font-weight:bold;color:#5e5e5e;">Tel:</span> <a href="tel:' + escapeHtml(identity.phoneLink) + '" style="color:#333333;text-decoration:none;">' + escapeHtml(identity.phone) + '</a></td></tr>'
        + '<tr><td style="padding:0;font-size:14px;line-height:16px;color:#333333;"><span style="font-weight:bold;color:#5e5e5e;">24/7:</span> <a href="tel:' + escapeHtml(identity.emergencyPhoneLink) + '" style="color:#333333;text-decoration:none;">' + escapeHtml(identity.emergencyPhone) + '</a></td></tr>'
        + '<tr><td style="padding:0 0 5px 0;font-size:14px;line-height:16px;color:#333333;"><span style="font-weight:bold;color:#5e5e5e;">Web:</span> <a href="' + escapeHtml(identity.websiteUrl) + '" style="color:#467886;text-decoration:underline;">' + escapeHtml(identity.website) + '</a></td></tr>'
        + '<tr><td style="padding:0;"><img src="cid:' + escapeHtml(logo.contentId) + '" alt="' + escapeHtml(logo.alt) + '" width="' + logo.width + '" height="' + logo.height + '" style="display:block;width:' + logo.width + 'px;height:auto;border:0;outline:none;text-decoration:none;"></td></tr>'
        + '</table>';
}

export function createEmailSignatureRenderer({ identity = nexaEmailIdentity } = {}) {
    function render(body) {
        if (body?.rendererId === rendererId) return body;
        if (typeof body !== 'string' || !body.trim()) throw new TypeError('email_body_invalid');

        const signatureText = [
            identity.displayName,
            identity.title,
            'Tel: ' + identity.phone,
            '24/7: ' + identity.emergencyPhone,
            'Web: ' + identity.website,
            'Logo Lifeguard Costa Rica (integrado)',
        ].join('\n');
        return {
            rendererId,
            bodyText: body,
            previewBody: body + '\n\n— Firma Nexa —\n\n' + signatureText,
            htmlBody: '<!doctype html><html><body style="margin:0;padding:0;font-family:Aptos,\'Arial Narrow\',Arial,sans-serif;font-size:14px;line-height:1.35;color:#222222;">'
                + paragraphHtml(body) + '<br>' + signatureHtml(identity) + '</body></html>',
            inlineAttachments: [{
                name: identity.logo.name,
                contentId: identity.logo.contentId,
                contentType: identity.logo.contentType,
                contentBytes: identity.logo.contentBytes,
                isInline: true,
            }],
        };
    }
    return Object.freeze({ render });
}

export const emailSignatureRenderer = createEmailSignatureRenderer();
