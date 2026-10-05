const maxVolume = 100;
const mediaPlayPauseVirtualKey = 0xb3;
const keyEventKeyUp = 0x0002;

function failed(code, message) {
    return { success: false, error: { code, message } };
}

function getAudioTool(name, description, properties = {}) {
    const required = Object.keys(properties);
    return {
        type: 'function',
        name,
        description,
        parameters: {
            type: 'object',
            properties,
            required,
            additionalProperties: false,
        },
        strict: true,
    };
}

export const getVolumeTool = getAudioTool(
    'get_volume',
    'Consulta el volumen maestro y el estado de silencio de Windows.'
);

export const setVolumeTool = getAudioTool(
    'set_volume',
    'Establece el volumen maestro de Windows entre 0 y 100.',
    {
        volume: { type: 'integer', minimum: 0, maximum: maxVolume },
    }
);

export const muteVolumeTool = getAudioTool('mute_volume', 'Silencia el volumen maestro de Windows.');
export const unmuteVolumeTool = getAudioTool('unmute_volume', 'Quita el silencio del volumen maestro de Windows.');
export const mediaPlayPauseTool = getAudioTool(
    'media_play_pause',
    'Envía la tecla multimedia global Play/Pause de Windows.'
);

async function getDefaultVolumeController() {
    const module = await import('loudness');
    return module.default ?? module;
}

async function withVolumeController({ platform, volumeController }, action) {
    if (platform !== 'win32') {
        return failed('unsupported_platform', 'El control de volumen solo está disponible en Windows.');
    }

    try {
        const controller = volumeController ?? await getDefaultVolumeController();
        return await action(controller);
    } catch {
        return failed('volume_control_failed', 'No se pudo consultar o modificar el volumen de Windows.');
    }
}

export async function getVolume({ platform = process.platform, volumeController } = {}) {
    return withVolumeController({ platform, volumeController }, async controller => {
        const [volume, muted] = await Promise.all([
            controller.getVolume(),
            controller.getMuted(),
        ]);
        if (!Number.isInteger(volume) || volume < 0 || volume > maxVolume || typeof muted !== 'boolean') {
            return failed('invalid_volume_response', 'Windows devolvió un estado de volumen no válido.');
        }
        return { success: true, volume, muted };
    });
}

export async function setVolume({ args, platform = process.platform, volumeController } = {}) {
    const volume = args?.volume;
    if (!Number.isInteger(volume) || volume < 0 || volume > maxVolume) {
        return failed('invalid_volume', 'El volumen debe ser un número entero entre 0 y 100.');
    }

    return withVolumeController({ platform, volumeController }, async controller => {
        await controller.setVolume(volume);
        return { success: true, volume };
    });
}

export async function muteVolume({ platform = process.platform, volumeController } = {}) {
    return withVolumeController({ platform, volumeController }, async controller => {
        await controller.setMuted(true);
        return { success: true, muted: true };
    });
}

export async function unmuteVolume({ platform = process.platform, volumeController } = {}) {
    return withVolumeController({ platform, volumeController }, async controller => {
        await controller.setMuted(false);
        return { success: true, muted: false };
    });
}

async function sendMediaPlayPauseKey() {
    const { default: koffi } = await import('koffi');
    const user32 = koffi.load('user32.dll');
    const keybdEvent = user32.func(
        '__stdcall',
        'keybd_event',
        'void',
        ['uint8', 'uint8', 'uint32', 'uintptr_t']
    );

    keybdEvent(mediaPlayPauseVirtualKey, 0, 0, 0);
    keybdEvent(mediaPlayPauseVirtualKey, 0, keyEventKeyUp, 0);
}

export async function mediaPlayPause({
    platform = process.platform,
    sendMediaKey = sendMediaPlayPauseKey,
} = {}) {
    if (platform !== 'win32') {
        return failed('unsupported_platform', 'El control multimedia solo está disponible en Windows.');
    }

    try {
        await sendMediaKey();
        return { success: true, action: 'play_pause' };
    } catch {
        return failed('media_control_failed', 'No se pudo enviar la tecla multimedia Play/Pause.');
    }
}

export const getVolumeRegistration = { definition: getVolumeTool, execute: getVolume };
export const setVolumeRegistration = { definition: setVolumeTool, execute: setVolume };
export const muteVolumeRegistration = { definition: muteVolumeTool, execute: muteVolume };
export const unmuteVolumeRegistration = { definition: unmuteVolumeTool, execute: unmuteVolume };
export const mediaPlayPauseRegistration = { definition: mediaPlayPauseTool, execute: mediaPlayPause };
