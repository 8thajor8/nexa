# Nexa

Asistente personal con Node.js, OpenAI Responses API y herramientas locales.

## Clima

`get_weather` usa Open-Meteo: primero resuelve el nombre de la ciudad con [Geocoding API](https://open-meteo.com/en/docs/geocoding-api) y luego solicita las condiciones actuales y el pronóstico de tres días con [Forecast API](https://open-meteo.com/en/docs). Usa `fetch` nativo de Node.js y no necesita una clave de clima para el uso gratuito de desarrollo. La herramienta devuelve un resumen estructurado en español, no el JSON de la API.

El acceso gratuito es para uso no comercial, tiene un límite publicado de 10.000 llamadas al día y no incluye garantía de disponibilidad. Los datos meteorológicos requieren atribución a Open-Meteo bajo CC BY 4.0; los nombres de lugar se basan en GeoNames. Consultá [los términos y límites actuales](https://open-meteo.com/en/pricing) antes de usarlo comercialmente.

Para iniciar Nexa, configurá `OPENAI_API_KEY` en el archivo local `.env` y ejecutá `npm start`. `.env` está excluido de Git. No se necesita una variable de entorno adicional para el clima.

Pedile a Nexa el clima de una ciudad, por ejemplo: “¿Qué tiempo hace en Barcelona?” o “Dame el pronóstico de Buenos Aires”. Para desambiguar, podés indicar también el país.

## Windows Tools

Nexa incluye tres herramientas controladas para interactuar con Windows:

- `open_app` inicia aplicaciones por nombre lógico usando una whitelist definida en `src/tools/windows.js` (`chrome`, `edge`, `notepad`, `calculator`, `explorer`, `spotify` y `discord`). Para ampliarla, agregá una clave y destinos ejecutables fijos a `windowsAppWhitelist`; no agregues argumentos provenientes del modelo.
- `open_url` abre solo URLs absolutas `http://` o `https://` en el navegador predeterminado.
- `get_open_apps` consulta `tasklist.exe` con formato CSV y parámetros fijos, y devuelve como máximo 100 procesos con nombre y PID.

Las acciones pasan por la permission policy antes de ejecutarse. No hay shell arbitrario, PowerShell genérico, escritura/borrado de archivos ni apagado o reinicio.
