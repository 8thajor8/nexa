import { validateTemporal } from './schema.js';

const precisionRank = Object.freeze({ year: 1, month: 2, day: 3, instant: 4 });

function interval(value) {
    if (value === null) return null;
    validateTemporal(value, 'validTime');
    if (value.precision === 'instant') {
        const point = Date.parse(value.value);
        return { low: point, high: point, precision: value.precision, value: value.value };
    }
    const suffix = { year: '-01-01', month: '-01', day: '' }[value.precision];
    const lowDate = new Date(value.value + suffix + 'T00:00:00.000Z');
    const highDate = new Date(lowDate);
    if (value.precision === 'year') highDate.setUTCFullYear(highDate.getUTCFullYear() + 1);
    else if (value.precision === 'month') highDate.setUTCMonth(highDate.getUTCMonth() + 1);
    else highDate.setUTCDate(highDate.getUTCDate() + 1);
    return { low: lowDate.getTime(), high: highDate.getTime() - 1,
        precision: value.precision, value: value.value };
}

function sameDeclaredPeriod(a, b) {
    return a.precision === b.precision && a.value === b.value
        && (a.precision === 'day' || a.precision === 'instant');
}

/** Classifies whether an assertion is valid throughout the requested temporal
 * unit. Coarser endpoint precision overlapping the query is indeterminate. */
export function classifyValidity(validFrom, validTo, validTime) {
    const from = interval(validFrom);
    const to = interval(validTo);
    const query = interval(validTime);
    if (!query) throw new TypeError('memory_valid_time_invalid');
    // Schema v4 has no marker that distinguishes two unrecorded endpoints
    // from an explicitly timeless interval. Preserve that missing knowledge.
    if (!from && !to) return 'indeterminate';

    let started = 'yes';
    if (from) {
        if (from.low > query.high) started = 'no';
        else if (from.high <= query.low
            || (from.low === query.low && precisionRank[from.precision] > precisionRank[query.precision])
            || sameDeclaredPeriod(from, query)) started = 'yes';
        else started = 'unknown';
    }

    let notEnded = 'yes';
    if (to) {
        if (to.high < query.low) notEnded = 'no';
        else if (to.low >= query.high
            || (to.high === query.high && precisionRank[to.precision] > precisionRank[query.precision])
            || sameDeclaredPeriod(to, query)) notEnded = 'yes';
        else notEnded = 'unknown';
    }

    if (started === 'no' || notEnded === 'no') return 'invalid';
    if (started === 'yes' && notEnded === 'yes') return 'valid';
    return 'indeterminate';
}

export function validateValidTime(value) {
    validateTemporal(value, 'validTime');
    if (value === null) throw new TypeError('memory_valid_time_invalid');
    return value;
}

export function validateNow(value) {
    const instant = { value, precision: 'instant' };
    validateTemporal(instant, 'now');
    return instant;
}
