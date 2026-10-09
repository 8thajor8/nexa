// Isolated lab broker. Launched only by tests over inherited anonymous stdio pipes.
import { createIdentityBrokerIpcTestHarness, IPC_MAX_MESSAGE_BYTES } from './identity-broker-ipc-contract.js';

const harness = createIdentityBrokerIpcTestHarness();
const MAX_OUTSTANDING_FRAME_BYTES = IPC_MAX_MESSAGE_BYTES;
let buffered = Buffer.alloc(0);
let closing = false;
let frameTimer = null;
const INCOMPLETE_FRAME_TIMEOUT_MS = 250;

function deniedError(code) {
    return { synthetic: true, status: 'rejected', code, authorization: 'DENY',
        executable: false, persistencePerformed: false };
}

function writeResponse(requestId, response) {
    const frame = Buffer.from(`${JSON.stringify({ protocolVersion: 1, requestId, response })}\n`, 'utf8');
    if (frame.length > MAX_OUTSTANDING_FRAME_BYTES) {
        process.stdout.write(`${JSON.stringify({ protocolVersion: 1, requestId: 'test_transport',
            response: deniedError('payload_too_large') })}\n`);
        process.stdin.pause();
        process.exitCode = 1;
        closing = true;
        return;
    }
    process.stdout.write(frame);
}

function processFrame(frame) {
    const bytes = frame.at(-1) === 13 ? frame.subarray(0, -1) : frame;
    if (bytes.length === 0) return;
    if (bytes.length > IPC_MAX_MESSAGE_BYTES) {
        writeResponse('test_transport', deniedError('payload_too_large'));
        process.stdin.pause();
        process.exitCode = 1;
        closing = true;
        return;
    }

    let message;
    try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch {
        writeResponse('test_transport', deniedError('request_invalid'));
        return;
    }
    const requestId = typeof message?.requestId === 'string' && /^test_[a-z0-9_-]{1,64}$/u.test(message.requestId)
        ? message.requestId : 'test_transport';
    writeResponse(requestId, harness.handle(message));
}

// Node's built-in test discovery executes every JS file under test/. Do not
// become a waiting child when discovered as a test module.
if (!process.env.NODE_TEST_CONTEXT) {
    process.stdin.on('data', chunk => {
        if (closing) return;
        buffered = Buffer.concat([buffered, chunk]);
        let newline;
        while (!closing && (newline = buffered.indexOf(10)) !== -1) {
            if (frameTimer) clearTimeout(frameTimer);
            frameTimer = null;
            const frame = buffered.subarray(0, newline);
            buffered = buffered.subarray(newline + 1);
            processFrame(frame);
        }
        if (!closing && buffered.length > IPC_MAX_MESSAGE_BYTES) {
            writeResponse('test_transport', deniedError('payload_too_large'));
            buffered = Buffer.alloc(0);
            process.stdin.pause();
            process.exitCode = 1;
            closing = true;
            return;
        }
        if (buffered.length > 0 && !frameTimer) {
            frameTimer = setTimeout(() => {
                if (closing) return;
                writeResponse('test_transport', deniedError('transport_failed'));
                process.stdin.pause();
                process.exitCode = 1;
                closing = true;
            }, INCOMPLETE_FRAME_TIMEOUT_MS);
        }
    });

    process.stdin.on('end', () => {
        if (closing) return;
        if (frameTimer) clearTimeout(frameTimer);
        frameTimer = null;
        if (buffered.length > 0) writeResponse('test_transport', deniedError('transport_failed'));
        buffered = Buffer.alloc(0);
    });

    process.stdin.on('error', () => {
        process.exitCode = 1;
    });
}
