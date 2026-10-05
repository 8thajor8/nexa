# Nexa

Asistente personal con Node.js, OpenAI Responses API y herramientas locales.

## Clima

`get_weather` usa Open-Meteo: primero resuelve el nombre de la ciudad con [Geocoding API](https://open-meteo.com/en/docs/geocoding-api) y luego solicita las condiciones actuales y el pronóstico de tres días con [Forecast API](https://open-meteo.com/en/docs). Usa `fetch` nativo de Node.js y no necesita una clave de clima para el uso gratuito de desarrollo. La herramienta devuelve un resumen estructurado en español, no el JSON de la API.

El acceso gratuito es para uso no comercial, tiene un límite publicado de 10.000 llamadas al día y no incluye garantía de disponibilidad. Los datos meteorológicos requieren atribución a Open-Meteo bajo CC BY 4.0; los nombres de lugar se basan en GeoNames. Consultá [los términos y límites actuales](https://open-meteo.com/en/pricing) antes de usarlo comercialmente.

Para iniciar Nexa, configurá `OPENAI_API_KEY` en el archivo local `.env` e iniciá `node src/index.js`. `.env` está excluido de Git. No se necesita una variable de entorno adicional para el clima.

Pedile a Nexa el clima de una ciudad, por ejemplo: “¿Qué tiempo hace en Barcelona?” o “Dame el pronóstico de Buenos Aires”. Para desambiguar, podés indicar también el país.
