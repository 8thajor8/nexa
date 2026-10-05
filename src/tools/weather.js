const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const REQUEST_TIMEOUT_MS = 10_000;

const weatherConditions = {
    0: 'Despejado',
    1: 'Mayormente despejado',
    2: 'Parcialmente nublado',
    3: 'Nublado',
    45: 'Niebla',
    48: 'Niebla con escarcha',
    51: 'Llovizna ligera',
    53: 'Llovizna moderada',
    55: 'Llovizna intensa',
    56: 'Llovizna helada ligera',
    57: 'Llovizna helada intensa',
    61: 'Lluvia ligera',
    63: 'Lluvia moderada',
    65: 'Lluvia intensa',
    66: 'Lluvia helada ligera',
    67: 'Lluvia helada intensa',
    71: 'Nevada ligera',
    73: 'Nevada moderada',
    75: 'Nevada intensa',
    77: 'Granizo pequeño',
    80: 'Chubascos ligeros',
    81: 'Chubascos moderados',
    82: 'Chubascos intensos',
    85: 'Chubascos de nieve ligeros',
    86: 'Chubascos de nieve intensos',
    95: 'Tormenta',
    96: 'Tormenta con granizo ligero',
    99: 'Tormenta con granizo intenso',
};

export const getWeatherTool = {
    type: 'function',
    name: 'get_weather',
    description: 'Consulta el tiempo actual y el pronóstico de los próximos tres días para una ciudad indicada por el usuario.',
    parameters: {
        type: 'object',
        properties: {
            location: {
                type: 'string',
                description: 'Ciudad y, si hace falta, país o región para identificarla sin ambigüedad.',
            },
        },
        required: ['location'],
        additionalProperties: false,
    },
    strict: true,
};

async function getJson(url, requestName) {
    let response;

    try {
        response = await fetch(url, {
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch (error) {
        if (error.name === 'TimeoutError' || error.name === 'AbortError') {
            throw new Error(`Se agotó el tiempo de espera al consultar ${requestName}.`);
        }

        throw new Error(`No se pudo conectar con ${requestName}: ${error.message}`);
    }

    if (!response.ok) {
        throw new Error(`${requestName} respondió con HTTP ${response.status}.`);
    }

    try {
        return await response.json();
    } catch {
        throw new Error(`${requestName} devolvió una respuesta JSON inválida.`);
    }
}

function hasNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function getCondition(code) {
    const condition = weatherConditions[code];

    if (!condition) {
        throw new Error(`Open-Meteo devolvió un código meteorológico inesperado: ${code}.`);
    }

    return condition;
}

async function getWeather({ args }) {
    const locationQuery = typeof args.location === 'string'
        ? args.location.trim()
        : '';

    if (!locationQuery) {
        throw new Error('Indicá una ciudad para consultar el clima.');
    }

    const geocodingUrl = new URL(GEOCODING_URL);
    geocodingUrl.searchParams.set('name', locationQuery);
    geocodingUrl.searchParams.set('count', '1');
    geocodingUrl.searchParams.set('language', 'es');
    geocodingUrl.searchParams.set('format', 'json');

    const geocoding = await getJson(geocodingUrl, 'la búsqueda de ciudades');

    if (geocoding.results === undefined) {
        throw new Error(`No encontré la ubicación "${locationQuery}".`);
    }

    if (!Array.isArray(geocoding.results)) {
        throw new Error('La búsqueda de ciudades devolvió una respuesta inesperada.');
    }

    const place = geocoding.results[0];

    if (!place) {
        throw new Error(`No encontré la ubicación "${locationQuery}".`);
    }

    if (!hasNumber(place.latitude) || !hasNumber(place.longitude)) {
        throw new Error('La búsqueda de ciudades devolvió coordenadas inválidas.');
    }

    const forecastUrl = new URL(FORECAST_URL);
    forecastUrl.searchParams.set('latitude', String(place.latitude));
    forecastUrl.searchParams.set('longitude', String(place.longitude));
    forecastUrl.searchParams.set('timezone', 'auto');
    forecastUrl.searchParams.set('forecast_days', '3');
    forecastUrl.searchParams.set(
        'current',
        'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m'
    );
    forecastUrl.searchParams.set(
        'daily',
        'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code'
    );

    const forecast = await getJson(forecastUrl, 'el pronóstico meteorológico');
    const current = forecast.current;
    const daily = forecast.daily;

    if (
        !current ||
        typeof current.time !== 'string' ||
        !hasNumber(current.temperature_2m) ||
        !hasNumber(current.apparent_temperature) ||
        !hasNumber(current.relative_humidity_2m) ||
        !hasNumber(current.precipitation) ||
        !hasNumber(current.weather_code) ||
        !hasNumber(current.wind_speed_10m) ||
        !daily ||
        !Array.isArray(daily.time) ||
        !Array.isArray(daily.temperature_2m_min) ||
        !Array.isArray(daily.temperature_2m_max) ||
        !Array.isArray(daily.precipitation_probability_max) ||
        !Array.isArray(daily.weather_code) ||
        daily.time.length === 0 ||
        daily.time.length !== daily.temperature_2m_min.length ||
        daily.time.length !== daily.temperature_2m_max.length ||
        daily.time.length !== daily.precipitation_probability_max.length ||
        daily.time.length !== daily.weather_code.length
    ) {
        throw new Error('El servicio meteorológico devolvió datos incompletos o inesperados.');
    }

    if (
        !daily.time.every(date => typeof date === 'string') ||
        !daily.temperature_2m_min.every(hasNumber) ||
        !daily.temperature_2m_max.every(hasNumber) ||
        !daily.precipitation_probability_max.every(
            probability => probability === null || hasNumber(probability)
        ) ||
        !daily.weather_code.every(hasNumber)
    ) {
        throw new Error('El servicio meteorológico devolvió valores de pronóstico inválidos.');
    }

    return {
        success: true,
        location: {
            name: place.name,
            region: place.admin1 ?? null,
            country: place.country ?? null,
            timezone: place.timezone ?? forecast.timezone ?? null,
        },
        current: {
            time: current.time,
            temperatureC: current.temperature_2m,
            feelsLikeC: current.apparent_temperature,
            humidityPercent: current.relative_humidity_2m,
            precipitationMm: current.precipitation,
            condition: getCondition(current.weather_code),
            windSpeedKmh: current.wind_speed_10m,
        },
        forecast: daily.time.map((date, index) => ({
            date,
            minimumTemperatureC: daily.temperature_2m_min[index],
            maximumTemperatureC: daily.temperature_2m_max[index],
            precipitationProbabilityPercent: hasNumber(daily.precipitation_probability_max[index])
                ? daily.precipitation_probability_max[index]
                : null,
            condition: getCondition(daily.weather_code[index]),
        })),
        source: 'Open-Meteo (clima) y GeoNames (ubicación)',
    };
}

export const getWeatherRegistration = {
    definition: getWeatherTool,
    execute: getWeather,
};
