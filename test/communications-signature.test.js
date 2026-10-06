import assert from 'node:assert/strict';
import test from 'node:test';
import { nexaEmailIdentity } from '../src/communications/signature/identity.js';
import { createEmailSignatureRenderer } from '../src/communications/signature/renderer.js';
import { htmlToSafeText } from '../src/communications/providers/microsoft-graph.js';

test('signature renderer creates a text-friendly, email-safe HTML signature and CID logo', () => {
    const renderer = createEmailSignatureRenderer();
    const result = renderer.render('Hola Jor,\n\nEsto es <b>importante</b> & privado.');
    assert.match(result.htmlBody, /Hola Jor,/u);
    assert.match(result.htmlBody, /Esto es &lt;b&gt;importante&lt;\/b&gt; &amp; privado\./u);
    assert.doesNotMatch(result.htmlBody, /<b>importante<\/b>/u);
    assert.match(result.htmlBody, /Digital Intelligence \| Assistant to Jorge Marcos/u);
    assert.match(result.htmlBody, /href="https:\/\/www\.lifeguardcostarica\.com"/u);
    assert.match(result.htmlBody, /href="tel:\+50640019867"/u);
    assert.match(result.htmlBody, /href="tel:\+50685129111"/u);
    assert.match(result.htmlBody, /src="cid:nexa-lifeguard-logo"/u);
    assert.match(result.htmlBody, /font-family:Aptos,'Arial Narrow',Arial,sans-serif/u);
    assert.match(result.htmlBody, /font-size:18\.67px;line-height:20px;font-weight:bold;color:#5e5e5e/u);
    assert.match(result.htmlBody, /font-size:17\.33px;line-height:19px;font-weight:bold;color:#154fa0/u);
    assert.match(result.htmlBody, /font-size:14px;line-height:16px/u);
    assert.match(result.htmlBody, /color:#467886;text-decoration:underline/u);
    assert.match(result.htmlBody, /width="288" height="65" style="display:block;width:288px;height:auto/u);
    assert.equal(nexaEmailIdentity.logo.width / nexaEmailIdentity.logo.height, 288 / 65);
    assert.equal(result.inlineAttachments.length, 1);
    assert.deepEqual({ type: result.inlineAttachments[0].contentType, inline: result.inlineAttachments[0].isInline, cid: result.inlineAttachments[0].contentId },
        { type: 'image/jpeg', inline: true, cid: 'nexa-lifeguard-logo' });
    assert.equal(Buffer.from(result.inlineAttachments[0].contentBytes, 'base64').subarray(0, 3).toString('hex'), 'ffd8ff');
});

test('signature renderer is idempotent when passed its already processed result', () => {
    const renderer = createEmailSignatureRenderer();
    const first = renderer.render('Hola');
    const second = renderer.render(first);
    assert.strictEqual(second, first);
    assert.equal((second.htmlBody.match(/<!-- nexa-email-signature-v1 -->/gu) ?? []).length, 1);
    assert.equal((second.htmlBody.match(/cid:nexa-lifeguard-logo/gu) ?? []).length, 1);
});

test('approved preview text corresponds to the delivered HTML text and explicitly marks the signature', () => {
    const renderer = createEmailSignatureRenderer();
    const result = renderer.render('Primera línea\nsegunda línea\n\nPárrafo final.');
    assert.match(result.previewBody, /Primera línea\nsegunda línea\n\nPárrafo final\.[\s\S]*— Firma Nexa —/u);
    const deliveredText = htmlToSafeText(result.htmlBody).replace(/\n{3,}/gu, '\n\n');
    for (const expected of ['Primera línea', 'segunda línea', 'Párrafo final.', nexaEmailIdentity.displayName,
        nexaEmailIdentity.title, nexaEmailIdentity.phone, nexaEmailIdentity.emergencyPhone, nexaEmailIdentity.website]) {
        assert(deliveredText.includes(expected), 'sent HTML is missing preview item: ' + expected);
    }
    assert.equal(result.previewBody.includes('<img'), false);
    assert.match(result.previewBody, /Logo Lifeguard Costa Rica \(integrado\)/u);
});
