const DEFAULT_INTERVALS_MS = Object.freeze([100, 150, 250, 400, 600, 700, 600]);

/** Polls an observation within one bounded post-action budget. The caller bounds each read with remainingMs. */
export async function pollForConfirmation({ read, isConfirmed, waitImpl, nowImpl = () => performance.now(),
    budgetMs = 3000, intervalsMs = DEFAULT_INTERVALS_MS, stopOnError = () => false } = {}) {
    if (typeof read !== 'function' || typeof isConfirmed !== 'function' || typeof waitImpl !== 'function'
        || typeof nowImpl !== 'function' || typeof stopOnError !== 'function'
        || !Number.isSafeInteger(budgetMs) || budgetMs < 1 || !Array.isArray(intervalsMs)
        || intervalsMs.length === 0 || intervalsMs.some(value => !Number.isSafeInteger(value) || value < 1))
        throw new TypeError('home_assistant_confirmation_poll_invalid');

    const startedAt = nowImpl();
    let scheduledWaitMs = 0;
    let intervalIndex = 0;
    let state = null;
    let error = null;

    while (true) {
        const elapsedMs = Math.max(Math.max(0, nowImpl() - startedAt), scheduledWaitMs);
        const remainingMs = Math.floor(budgetMs - elapsedMs);
        if (remainingMs <= 0) return Object.freeze({ confirmed: false, state, error });

        try {
            state = await read(remainingMs);
            error = null;
            if (isConfirmed(state)) return Object.freeze({ confirmed: true, state, error: null });
        } catch (readError) {
            error = readError;
            if (stopOnError(readError)) return Object.freeze({ confirmed: false, state: null, error });
        }

        const afterReadElapsedMs = Math.max(Math.max(0, nowImpl() - startedAt), scheduledWaitMs);
        const delayMs = Math.min(intervalsMs[Math.min(intervalIndex, intervalsMs.length - 1)],
            Math.max(0, budgetMs - afterReadElapsedMs));
        if (delayMs <= 0) return Object.freeze({ confirmed: false, state, error });
        await waitImpl(delayMs);
        scheduledWaitMs += delayMs;
        intervalIndex += 1;
    }
}
