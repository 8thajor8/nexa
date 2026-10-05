export const toolPermissions = Object.freeze({
    get_current_time: 'read',
    recall: 'read',
    remember: 'write',
    forget: 'write',
    get_weather: 'external_read',
    web_search: 'external_read',
    open_app: 'action',
    open_url: 'action',
    get_open_apps: 'read',
    discover_apps: 'read',
    list_directory: 'read',
    read_file: 'read',
    get_volume: 'read',
    set_volume: 'action',
    mute_volume: 'action',
    unmute_volume: 'action',
    media_play_pause: 'action',
    is_app_running: 'read',
    get_active_window: 'read',
    list_windows: 'read',
    focus_window: 'action',
    maximize_window: 'action',
    minimize_window: 'action',
    restore_window: 'action',
    close_window: 'action',
    inspect_ui: 'read',
    find_ui_element: 'read',
    focus_ui_element: 'action',
    invoke_ui_element: 'action',
    set_ui_value: 'action',
    get_ui_value: 'read',
    whatsapp_open_chat: 'action',
    whatsapp_prepare_message: 'action',
    whatsapp_get_status: 'read',
    generate_speech: 'external_read',
    play_audio: 'action',
    spotify_get_current_track: 'external_read',
    spotify_search: 'external_read',
    spotify_get_devices: 'external_read',
    spotify_play: 'action',
    spotify_pause: 'action',
    spotify_next: 'action',
    spotify_previous: 'action',
});

export const defaultPermissionPolicy = Object.freeze({
    read: true,
    external_read: true,
    write: true,
    action: true,
    destructive: false,
});

export function checkToolPermission(registration, policy = defaultPermissionPolicy) {
    const permission = registration?.permission;
    const allowed = typeof permission === 'string'
        && policy !== null
        && typeof policy === 'object'
        && Object.hasOwn(policy, permission)
        && policy[permission] === true;

    return {
        allowed,
        permission: permission ?? null,
        reason: allowed ? null : 'permission_denied',
    };
}
