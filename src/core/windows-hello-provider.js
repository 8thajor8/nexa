/** Windows Hello verification adapter.
 * The current Node CLI has no trusted HWND/native WinRT host. This provider is
 * intentionally fail-closed; no callback or structured result can impersonate
 * a native Windows Hello verification.
 */
export function createWindowsHelloProvider() {
    return Object.freeze({
        async verifyUser({ purpose } = {}) {
            void purpose;
            return Object.freeze({ status: 'unavailable', method: null });
        },
    });
}
