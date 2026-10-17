import { createMemoryContextProvider } from './context-provider.js';

const ERROR_MESSAGES = Object.freeze({
    memory_read_failed: 'Memory 2 context could not be read.',
    memory_facade_closed: 'The Memory 2 read-only facade is closed.',
});

function safeError(code) {
    const error = new Error(ERROR_MESSAGES[code]);
    error.name = 'Memory2ReadOnlyError';
    error.code = code;
    Object.defineProperty(error, 'stack', { value: undefined, enumerable: false, writable: false });
    error.toJSON = () => ({ code, message: ERROR_MESSAGES[code] });
    return Object.freeze(error);
}

/**
 * Read-only view over an injected Memory2 repository.
 * The caller retains ownership of the repository and must close it separately.
 */
export function createMemory2ReadOnly({ repository, matchSpecificSelfQueries = false, embeddings = null,
    semanticIndex = null, indexPath = null, authorizeSubject = () => false,
    authorizeRelationships = () => false } = {}) {
    const contextProvider = createMemoryContextProvider({ repository, matchSpecificSelfQueries, embeddings,
        semanticIndex, indexPath, authorizeSubject, authorizeRelationships });
    let closed = false;

    const facade = Object.create(null);
    Object.defineProperties(facade, {
        searchContext: {
            enumerable: true,
            value: async function searchContext(options = {}) {
                if (closed) throw safeError('memory_facade_closed');
                try { return await contextProvider.search(options); }
                catch { throw safeError('memory_read_failed'); }
            },
        },
        readContext: {
            enumerable: true,
            value: async function readContext(options = {}) {
                if (closed) throw safeError('memory_facade_closed');
                try {
                    const { message = '', recentUserMessages = [] } = options;
                    return await contextProvider.read({ message, recentUserMessages });
                } catch {
                    throw safeError('memory_read_failed');
                }
            },
        },
        close: {
            enumerable: true,
            value: async function close() { closed = true; },
        },
    });
    return Object.freeze(facade);
}
