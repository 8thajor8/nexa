import { randomBytes } from 'node:crypto';
import { getMicrosoftConfiguration } from './config.js';

const maxEvents = 50;
const maxRangeDays = 31;
const maxDescriptionLength = 3000;
const defaultEventDurationMinutes = 60;
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
function validLocalDateTime(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) return null;
    const [date, time] = value.split('T'), parts = parseDate(date);
    const [hour, minute] = time.split(':').map(Number);
    return parts && hour < 24 && minute < 60 ? { ...parts, hour, minute } : null;
}
function zoneOffsetAt(instant, timeZone) {
    const parts = localClockParts(instant, timeZone);
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - instant.getTime();
}
function utcForLocalDateTime(value, timeZone) {
    const local = validLocalDateTime(value);
    if (!local) return null;
    const target = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
    const offsets = new Set();
    for (const hours of [-36, -24, -12, 0, 12, 24, 36]) offsets.add(zoneOffsetAt(new Date(target + hours * 3600000), timeZone));
    const candidates = [...offsets].map(offset => new Date(target - offset)).filter(candidate => {
        const parts = localClockParts(candidate, timeZone);
        return parts.year === local.year && parts.month === local.month && parts.day === local.day && parts.hour === local.hour && parts.minute === local.minute && parts.second === 0;
    });
    return candidates.length === 1 ? candidates[0].toISOString() : null;
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
        isOrganizer: event.isOrganizer === true,
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
    function writableCalendar(reference) { return resolveCalendar(reference); }
    function validText(value, max, required = false) {
        if (value === undefined || value === null) return required ? null : '';
        if (typeof value !== 'string' || value.length > max || /[\0\r]/u.test(value) || (required && !value.trim())) return null;
        return value.trim();
    }
    function validAttendees(value) {
        if (value === undefined || value === null) return [];
        if (!Array.isArray(value) || value.length > 20) return null;
        const normalized = value.map(item => typeof item === 'string' ? item.trim().toLocaleLowerCase('en-US') : '');
        return normalized.every(item => /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/u.test(item) && item.length <= 254) ? [...new Set(normalized)] : null;
    }
    function timezoneFor(value) {
        const zone = typeof value === 'string' && value.trim() ? value.trim() : timeZone;
        return validTimeZone(zone) ? zone : null;
    }
    function localInput(value, zone) {
        const instant = utcForLocalDateTime(value, zone);
        return instant ? { instant } : null;
    }
    function previewTimes(title, start, end, zone) {
        const startValue = localDateTime(start, zone), endValue = localDateTime(end, zone);
        const startDate = new Date(start);
        const longDate = new Intl.DateTimeFormat('es-ES', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(startDate);
        const dateLabel = longDate.charAt(0).toLocaleUpperCase('es') + longDate.slice(1);
        const startClock = startValue?.slice(11) ?? start, endClock = endValue?.slice(11) ?? end;
        const endDate = endValue?.slice(0, 10) === startValue?.slice(0, 10) ? '' : '\n' + endValue?.slice(0, 10) + ' ';
        return `${title}\n${dateLabel}\n${startClock}–${endDate}${endClock}`;
    }
    function activeSession(context) { return currentSession(context); }
    function lookupEvent(id, context) {
        const reference = typeof id === 'string' ? references.get(id) : null;
        return reference && reference.sessionId === activeSession(context) && activeSession(context) ? reference : null;
    }
    async function prepareCalendarEvent(args = {}, context = {}) {
        try {
            const sessionId = activeSession(context);
            const title = validText(args.title, 255, true), location = validText(args.location, 300), descriptionInput = validText(args.description, maxDescriptionLength);
            const description = descriptionInput?.replace(/\s+/gu, ' ') ?? null;
            const attendees = validAttendees(args.attendees), zone = timezoneFor(args.timezone), calendar = writableCalendar(args.calendar);
            if (!sessionId || !title || /[\n\r]/u.test(title) || (location !== null && /[\n\r]/u.test(location)) || location === null || description === null || !attendees || !zone || !calendar.success) return { success: false, error: { code: 'calendar_event_invalid', message: 'Revisá el título, la zona horaria, los invitados y el calendario. No se creó ningún evento.' } };
            const start = localInput(args.start, zone);
            if (!start) return { success: false, error: { code: 'calendar_time_ambiguous', message: 'La hora no es válida, no existe por el cambio de horario o es ambigua. Indicá otra hora o zona horaria.' } };
            let end, duration;
            if (args.end !== undefined && args.end !== null && args.end !== '') {
                end = localInput(args.end, zone);
                if (!end) return { success: false, error: { code: 'calendar_time_ambiguous', message: 'La hora de fin no es válida o es ambigua por el cambio de horario.' } };
                duration = (Date.parse(end.instant) - Date.parse(start.instant)) / 60000;
            } else {
                const minutes = args.durationMinutes === undefined || args.durationMinutes === null ? defaultEventDurationMinutes : args.durationMinutes;
                if (!Number.isInteger(minutes) || minutes < 5 || minutes > 720) return { success: false, error: { code: 'calendar_duration_invalid', message: 'La duración debe estar entre 5 minutos y 12 horas.' } };
                duration = minutes;
                end = { instant: new Date(Date.parse(start.instant) + duration * 60000).toISOString() };
            }
            if (duration <= 0 || duration > 720) return { success: false, error: { code: 'calendar_duration_invalid', message: 'El horario de fin debe ser posterior al inicio y no superar 12 horas.' } };
            const payload = { calendarAddress: calendar.address, title, startDateTime: start.instant, endDateTime: end.instant, timeZone: zone, location, description, attendees };
            const lines = [previewTimes(title, start.instant, end.instant, zone), 'Zona horaria: ' + zone, ...(location ? ['Ubicación: ' + location] : []), ...(description ? ['Descripción: ' + description] : []), ...(attendees.length ? ['Invitados: ' + attendees.join(', '), 'Microsoft enviará invitaciones a los invitados.'] : []), 'Calendario: ' + (calendar.address ?? 'personal')];
            return { success: true, payload, preview: lines.join('\n') + '\n\n¿Lo creo?', notification: attendees.length > 0 };
        } catch { return failure; }
    }
    async function prepareCalendarEventUpdate(args = {}, context = {}) {
        try {
            const reference = lookupEvent(args.id, context);
            if (!reference || typeof provider?.getCalendarEvent !== 'function') return { success: false, error: { code: 'calendar_reference_invalid', message: 'No puedo identificar ese evento en esta sesión. Volvé a listar los eventos.' } };
            const zone = timezoneFor(args.timezone);
            if (!zone) return { success: false, error: { code: 'calendar_timezone_invalid', message: 'La zona horaria configurada no es válida.' } };
            const currentResult = await provider.getCalendarEvent(reference);
            if (!currentResult?.success) return currentResult ?? failure;
            const current = safeEvent(currentResult.event, reference.calendarAddress ?? 'personal', zone);
            if (!current) return { success: false, error: { code: 'calendar_event_invalid', message: 'No pude validar el evento actual.' } };
            const patch = {};
            const title = validText(args.title, 255), location = validText(args.location, 300);
            if (args.title !== undefined && args.title !== null) { if (!title || /[\n\r]/u.test(title)) return { success: false, error: { code: 'calendar_event_invalid', message: 'El título propuesto no es válido.' } }; patch.title = title; }
            if (args.location !== undefined && args.location !== null) { if (location === null || /[\n\r]/u.test(location)) return { success: false, error: { code: 'calendar_event_invalid', message: 'La ubicación propuesta no es válida.' } }; patch.location = location; }
            if (args.description !== undefined && args.description !== null) return { success: false, error: { code: 'calendar_update_unsupported', message: 'No puedo cambiar la descripción porque podría alterar datos de una reunión en línea. El resto del evento permanece intacto.' } };
            let startDateTime = current.startDateTime, endDateTime = current.endDateTime;
            if (args.start !== undefined && args.start !== null) {
                const start = localInput(args.start, zone);
                if (!start) return { success: false, error: { code: 'calendar_time_ambiguous', message: 'La nueva hora de inicio no es válida o es ambigua por el cambio de horario.' } };
                const durationMs = Date.parse(current.endDateTime) - Date.parse(current.startDateTime);
                startDateTime = start.instant;
                if (args.end === undefined || args.end === null) endDateTime = new Date(Date.parse(start.instant) + durationMs).toISOString();
            }
            if (args.end !== undefined && args.end !== null) {
                const end = localInput(args.end, zone);
                if (!end) return { success: false, error: { code: 'calendar_time_ambiguous', message: 'La nueva hora de fin no es válida o es ambigua por el cambio de horario.' } };
                endDateTime = end.instant;
            }
            if ((args.start !== undefined && args.start !== null) || (args.end !== undefined && args.end !== null)) {
                if (Date.parse(endDateTime) <= Date.parse(startDateTime) || Date.parse(endDateTime) - Date.parse(startDateTime) > 720 * 60000) return { success: false, error: { code: 'calendar_duration_invalid', message: 'El rango nuevo no es válido o supera 12 horas.' } };
                patch.startDateTime = startDateTime; patch.endDateTime = endDateTime;
            }
            if (!Object.keys(patch).length) return { success: false, error: { code: 'calendar_update_empty', message: 'Indicá al menos un cambio concreto para el evento.' } };
            const resultingTitle = patch.title ?? current.subject;
            const payload = { calendarAddress: reference.calendarAddress, providerEventId: reference.providerEventId, patch,
                current: { subject: current.subject, startDateTime: current.startDateTime, endDateTime: current.endDateTime, hasAttendees: current.attendees.length > 0 }, timeZone: zone };
            const currentLocation = current.location?.displayName;
            const lines = ['Voy a cambiar:', previewTimes(current.subject, current.startDateTime, current.endDateTime, zone), ...(currentLocation ? ['Ubicación actual: ' + currentLocation] : []), 'Después:', previewTimes(resultingTitle, startDateTime, endDateTime, zone), ...(patch.location !== undefined ? ['Ubicación nueva: ' + patch.location] : []), 'Zona horaria: ' + zone, ...(current.attendees.length ? ['Microsoft puede enviar una actualización a los participantes.'] : [])];
            return { success: true, payload, preview: lines.join('\n') + '\n\n¿Lo cambio?', notification: current.attendees.length > 0 };
        } catch { return failure; }
    }
    async function prepareCalendarEventCancel(args = {}, context = {}) {
        try {
            const reference = lookupEvent(args.id, context);
            if (!reference || typeof provider?.getCalendarEvent !== 'function') return { success: false, error: { code: 'calendar_reference_invalid', message: 'No puedo identificar ese evento en esta sesión. Volvé a listar los eventos.' } };
            const zone = timezoneFor(args.timezone);
            if (!zone) return { success: false, error: { code: 'calendar_timezone_invalid', message: 'La zona horaria configurada no es válida.' } };
            const currentResult = await provider.getCalendarEvent(reference);
            if (!currentResult?.success) return currentResult ?? failure;
            const current = safeEvent(currentResult.event, reference.calendarAddress ?? 'personal', zone);
            if (!current) return { success: false, error: { code: 'calendar_event_invalid', message: 'No pude validar el evento actual.' } };
            const hasAttendees = current.attendees.length > 0;
            if (hasAttendees && !current.isOrganizer) return { success: false, error: { code: 'calendar_cancel_not_organizer', message: 'Este evento tiene participantes y Nexa no es la organizadora. No puedo enviar una cancelación de reunión.' } };
            const payload = { calendarAddress: reference.calendarAddress, providerEventId: reference.providerEventId, sendMeetingCancellation: hasAttendees,
                event: { subject: current.subject, startDateTime: current.startDateTime, endDateTime: current.endDateTime }, timeZone: zone };
            const preview = ['Voy a cancelar:', previewTimes(current.subject, current.startDateTime, current.endDateTime, zone), 'Zona horaria: ' + zone,
                ...(hasAttendees ? ['Microsoft enviará una cancelación a los participantes.'] : ['No se enviará una notificación a participantes.']), '', '¿La cancelo?'].join('\n');
            return { success: true, payload, preview, notification: hasAttendees };
        } catch { return failure; }
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
            const { id: _opaque, providerEventId: _providerId, ...publicEvent } = event;
            return { success: true, event: { ...publicEvent, id: args.id } };
        } catch { return failure; }
    }
    async function createCalendarEvent(payload) {
        if (typeof provider?.createCalendarEvent !== 'function') return failure;
        const response = await provider.createCalendarEvent({ calendarAddress: payload.calendarAddress, event: payload });
        if (!response?.success) return response ?? failure;
        const event = safeEvent(response.event, payload.calendarAddress ?? 'personal', payload.timeZone);
        return { success: true, created: true, message: `Listo. Agendé ${payload.title}, ${event?.startLocal ?? ''}–${event?.endLocal?.slice(11) ?? ''}.`, event: event ? { subject: event.subject, startLocal: event.startLocal, endLocal: event.endLocal, timeZone: event.timeZone } : null };
    }
    async function updateCalendarEvent(payload) {
        if (typeof provider?.updateCalendarEvent !== 'function') return failure;
        const response = await provider.updateCalendarEvent(payload);
        if (!response?.success) return response ?? failure;
        const event = safeEvent(response.event, payload.calendarAddress ?? 'personal', payload.timeZone);
        const summary = event ? `${event.subject}, ${event.startLocal}–${event.endLocal?.slice(11) ?? ''}` : 'el evento';
        return { success: true, updated: true, message: `Listo. Actualicé ${summary}.`, event: event ? { subject: event.subject, startLocal: event.startLocal, endLocal: event.endLocal, timeZone: event.timeZone } : null };
    }
    async function cancelCalendarEvent(payload) {
        if (typeof provider?.cancelCalendarEvent !== 'function') return failure;
        const response = await provider.cancelCalendarEvent(payload);
        if (!response?.success) return response ?? failure;
        return { success: true, cancelled: true, notificationSent: payload.sendMeetingCancellation === true, message: `Listo. Cancelé ${payload.event.subject}.` };
    }
    return Object.freeze({ listCalendarEvents, getCalendarEvent, prepareCalendarEvent, prepareCalendarEventUpdate, prepareCalendarEventCancel,
        createCalendarEvent, updateCalendarEvent, cancelCalendarEvent,
        resolveDateRange: args => resolveDateRange(args, timeZone, now) });
}

export { resolveDateRange, utcForLocalMidnight, utcForLocalDateTime, localDateTime };
