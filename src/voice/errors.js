const messages = Object.freeze({
    voice_audio_invalid: 'El audio no tiene un formato de entrada válido.',
    voice_audio_empty: 'El audio está vacío.',
    voice_audio_too_large: 'El audio supera el límite permitido de 25 MB.',
    voice_format_unsupported: 'El formato de audio no es compatible.',
    voice_language_invalid: 'El idioma debe ser un código ISO 639-1 de dos letras.',
    voice_model_invalid: 'El modelo de transcripción configurado no es válido.',
    voice_provider_invalid: 'El proveedor de transcripción no está disponible.',
    voice_provider_error: 'El proveedor no pudo completar la transcripción.',
    voice_response_invalid: 'El proveedor devolvió una respuesta de transcripción no válida.',
    voice_cancelled: 'La transcripción fue cancelada.',
    voice_session_invalid_state: 'La sesión de voz no está activa.',
    voice_speech_invalid_input: 'La solicitud de voz hablada no tiene un formato válido.',
    voice_speech_service_invalid: 'El servicio de síntesis de voz no está disponible.',
    voice_speech_generation_failed: 'No pude generar el audio hablado.',
    voice_speech_playback_failed: 'No pude reproducir el audio hablado.',
});

export class VoiceError extends Error {
    constructor(code) {
        super(messages[code] ?? messages.voice_provider_error);
        this.name = 'VoiceError';
        this.code = Object.hasOwn(messages, code) ? code : 'voice_provider_error';
    }
}

export function toVoiceError(error) {
    return error instanceof VoiceError ? error : new VoiceError('voice_provider_error');
}
