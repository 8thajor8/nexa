import { randomBytes } from 'node:crypto';
import { getMicrosoftConfiguration } from './config.js';

const maxEvents = 50;
const maxRangeDays = 31;
const maxDescriptionLength = 3000;
const failure = { success: false, error: { code: 'calendar_unavailable', message: 'El calendario no está disponible en este momento.' } };

function localDateParts(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    return Object.fromEntries(parts.filter(item => item.type !== 'literal').map(item => [item.type, Number(item.value)]));
}
function localClockParts(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
    return Object.fromEntries(parts.filter(item => item.type !== 'literal').map(item => [item.type, Number(item.value)]));
}
function dateString({ year, month, day }) { return [year, String(month).padStart(2, '0'), String(day).padStart(2, '0')].join('-'); }
function parseDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
    const [year, month, day] = value.split('-').map(Number);
    const check = new Date(Date.UTC(year, month - 1, day));
    return check.getUTCFullYear() === year && check.getUTCMonth() + 1 === month && check.getUTCDate() === day ? { year, month, day } : null;
}
function shiftDate(parts, days) {
    const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}
function utcForLocalMidnight(parts, timeZone) {
    const target = Date.UTC(parts.year, parts.month - 1, parts.day);
    let guess = target;
    for (let attempt = 0; attempt < 4; attempt++) {
        const local = localClockParts(new Date(guess), timeZone);
        const represented = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
        const delta = target - represented;
        if (delta === 0) return new Date(guess).toISOString();
        guess += delta;
    }
    return new Date(guess).toISOString();
}
function localDateTime(iso, timeZone) {
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
    const value = Object.fromEntries(parts.filter(item => item.type !== 'literal').map(item => [item.type, item.value]));
    return value.year + '-' + value.month + '-' + value.day + ' ' + value.hour + ':' + value.minute;
}
function resolveDateRange(args, timeZone, now) {
    let start;
    let end;
    const today = localDateParts(now(), timeZone);
    switch (args?.period) {
        case 'today': start = today; end = shiftDate(today, 1); break;
        case 'tomorrow': start = shiftDate(today, 1); end = shiftDate(today, 2); break;
        case 'this_week': {
            const weekday = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
            start = shiftDate(today, -((weekday + 6) % 7)); end = shiftDate(start, 7); break;
        }
        case 'date': start = parseDate(args.date); end = start && shiftDate(start, 1); break;
        case 'range': start = parseDate(args.startDate); end = parseDate(args.endDate); end = end && shiftDate(end, 1); break;
        default: return null;
    }
    if (!start || !end) return null;
    const startDay = Date.UTC(start.year, start.month - 1, start.day);
    const endDay = Date.UTC(end.year, end.month - 1, end.day);
    const spanDays = (endDay - startDay) / 86400000;
    if (spanDays < 1 || spanDays > maxRangeDays) return null;
    return { startDate: dateString(start), endDateExclusive: dateString(end), startDateTime: utcForLocalMidnight(start, timeZone), endDateTime: utcForLocalMidnight(end, timeZone) };
}
function safeEvent(event, calendar, timeZone) {
    if (!event || typeof event.providerEventId !== 'string' || !event.providerEventId || typeof event.startDateTime !== 'string' || typeof event.endDateTime !== 'string') return null;
    return {
        id: 'cal_' + randomBytes(12).toString('hex'),
        providerEventId: event.providerEventId,
        calendar,
        subject: typeof event.subject === 'string' ? event.subject.slice(0, 300) : '(Sin asunto)',
        startDateTime: event.startDateTime,
        endDateTime: event.endDateTime,
        startLocal: localDateTime(event.startDateTime, timeZone),
        endLocal: localDateTime(event.endDateTime, timeZone),
        timeZone,
        isAllDay: event.isAllDay === true,
        location: event.location ?? null,
        organizer: event.organizer ?? null,
        attendees: Array.isArray(event.attendees) ? event.attendees.slice(0, 50) : [],
        preview: String(event.preview ?? '').slice(0, 500),
        body: String(event.body ?? '').slice(0, maxDescriptionLength),
        untrustedContent: true,
    };
}
function currentSession(context) { return typeof context?.sessionId === 'string' && context.sessionId ? context.sessionId : null; }
function validTimeZone(value) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true; } catch { return false; }
}

export function createCalendarService({ provider, environment = process.env, timeZone = environment.NEXA_TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone, now = () => new Date() } = {}) {
    const references = new Map();
    const configuration = getMicrosoftConfiguration(environment);
    const sharedCalendars = configuration.success ? configuration.sharedCalendars : [];
    function resolveCalendar(reference) {
        if (reference === undefined || reference === null || !String(reference).trim()) return { success: true, address: null, type: 'personal' };
        const value = String(reference).trim().toLocaleLowerCase('en-US');
        if (['personal', 'mi calendario', 'mi calendario personal'].includes(value)) return { success: true, address: null, type: 'personal' };
        const matches = sharedCalendars.filter(address => address === value || address.split('@')[0] === value);
        return matches.length === 1 ? { success: true, address: matches[0], type: 'shared' } : { success: false, error: { code: matches.length ? 'calendar_ambiguous' : 'calendar_not_configured', message: 'Indicá mi calendario personal o una dirección/nombre de calendario compartido configurado.' } };
    }
    async function listCalendarEvents(args = {}, context = {}) {
        try {
            if (!provider || typeof provider.listCalendarEvents !== 'function') return failure;
            if (!validTimeZone(timeZone)) return { success: false, error: { code: 'calendar_timezone_invalid', message: 'La zona horaria configurada no es válida.' } };
            const range = resolveDateRange(args, timeZone, now);
            if (!range) return { success: false, error: { code: 'calendar_date_range_invalid', message: 'Indicá un período válido de hasta 31 días.' } };
            const calendar = resolveCalendar(args.calendar);
            if (!calendar.success) return calendar;
            const limit = Number.isInteger(args.limit) ? Math.max(1, Math.min(args.limit, maxEvents)) : 25;
            const response = await provider.listCalendarEvents({ calendarAddress: calendar.address, ...range, limit: args.query ? maxEvents : limit });
            if (!response?.success) return response ?? failure;
            if (!Array.isArray(response.events)) return { success: false, error: { code: 'calendar_response_invalid', message: 'El proveedor devolvió una lista de eventos no válida.' } };
            const sessionId = currentSession(context) ?? 'direct';
            let events = (response.events ?? []).map(event => safeEvent(event, calendar.address ?? 'personal', timeZone)).filter(Boolean)
                .sort((left, right) => Date.parse(left.startDateTime) - Date.parse(right.startDateTime));
            if (typeof args.query === 'string' && args.query.trim()) {
                const query = args.query.trim().toLocaleLowerCase('es');
                events = events.filter(event => [event.subject, event.preview, event.location?.displayName, event.organizer?.name, ...event.attendees.map(person => person.name)].some(value => String(value ?? '').toLocaleLowerCase('es').includes(query)));
            }
            const output = events.slice(0, limit).map(event => {
                const { providerEventId, ...publicEvent } = event;
                references.set(event.id, { providerEventId, calendarAddress: calendar.address, sessionId });
                return publicEvent;
            });
            return { success: true, events: output, range, timeZone, truncated: response.truncated === true || events.length > limit };
        } catch { return failure; }
    }
    async function getCalendarEvent(args = {}, context = {}) {
        try {
            const reference = typeof args.id === 'string' ? references.get(args.id) : null;
            if (!reference || reference.sessionId !== (currentSession(context) ?? 'direct') || typeof provider?.getCalendarEvent !== 'function') return { success: false, error: { code: 'calendar_reference_invalid', message: 'La referencia del evento no existe o no pertenece a esta sesión. Volvé a listar los eventos.' } };
            const response = await provider.getCalendarEvent(reference);
            if (!response?.success) return response ?? failure;
            const event = safeEvent(response.event, reference.calendarAddress ?? 'personal', timeZone);
            if (!event) return { success: false, error: { code: 'calendar_event_invalid', message: 'Microsoft Graph devolvió un evento no válido.' } };
            const { id: _opaque, ...publicEvent } = event;
            return { success: true, event: { ...publicEvent, id: args.id } };
        } catch { return failure; }
    }
    return Object.freeze({ listCalendarEvents, getCalendarEvent, resolveDateRange: args => resolveDateRange(args, timeZone, now) });
}

export { resolveDateRange, utcForLocalMidnight, localDateTime };
