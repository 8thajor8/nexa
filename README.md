# Nexa

Asistente personal con Node.js, OpenAI Responses API y herramientas locales.

## Clima

`get_weather` usa Open-Meteo: primero resuelve el nombre de la ciudad con [Geocoding API](https://open-meteo.com/en/docs/geocoding-api) y luego solicita las condiciones actuales y el pronóstico de tres días con [Forecast API](https://open-meteo.com/en/docs). Usa `fetch` nativo de Node.js y no necesita una clave de clima para el uso gratuito de desarrollo. La herramienta devuelve un resumen estructurado en español, no el JSON de la API.

El acceso gratuito es para uso no comercial, tiene un límite publicado de 10.000 llamadas al día y no incluye garantía de disponibilidad. Los datos meteorológicos requieren atribución a Open-Meteo bajo CC BY 4.0; los nombres de lugar se basan en GeoNames. Consultá [los términos y límites actuales](https://open-meteo.com/en/pricing) antes de usarlo comercialmente.

Para iniciar Nexa, configurá `OPENAI_API_KEY` en el archivo local `.env` y ejecutá `npm start`. `.env` está excluido de Git. No se necesita una variable de entorno adicional para el clima.

Pedile a Nexa el clima de una ciudad, por ejemplo: “¿Qué tiempo hace en Barcelona?” o “Dame el pronóstico de Buenos Aires”. Para desambiguar, podés indicar también el país.

## Windows Tools

Nexa incluye herramientas controladas para interactuar con Windows:

- `open_app` abre una aplicación por nombre lógico, desde el catálogo local o la whitelist explícita.
- `discover_apps` actualiza el catálogo leyendo accesos directos `.lnk` del menú Inicio del usuario y del equipo. Solo inspecciona esas carpetas conocidas; no escanea el disco ni ejecuta aplicaciones o scripts.
- `open_url` abre solo URLs absolutas `http://` o `https://` en el navegador predeterminado.
- `get_open_apps` consulta `tasklist.exe` con formato CSV y parámetros fijos, y devuelve como máximo 100 procesos con nombre y PID.

El catálogo se guarda localmente en `data/apps.json` y está excluido de Git porque contiene rutas del equipo. `discover_apps` lo reconstruye; `open_app` normaliza nombres y aliases, busca coincidencias exactas o un prefijo que identifique una sola aplicación, y ejecuta el destino almacenado sin argumentos proporcionados por el modelo. Para aplicaciones descubiertas solo se aceptan ejecutables bajo ubicaciones normales de instalación (Program Files, LocalAppData/Programs o ProgramData); se descartan intérpretes y rutas fuera de esas ubicaciones. GPT recibe nombres lógicos, nunca las rutas ejecutables.

La whitelist de `src/tools/windows.js` sigue siendo un fallback para `chrome`, `edge`, `notepad`, `calculator`, `explorer`, `spotify` y `discord`. Para agregar otra aplicación explícita, agregá su nombre lógico y una ruta fija bajo `windowsAppWhitelist`; mantené sus argumentos fijos y escritos en el código.

### Archivos, volumen y multimedia

Las herramientas `list_directory` y `read_file` solo trabajan dentro de `Desktop`, `Documents` y `Downloads` del perfil de Windows, incluidas sus ubicaciones conocidas de OneDrive cuando están configuradas. Aceptan esas carpetas como rutas relativas (por ejemplo `Documents\notas.txt`) o rutas absolutas contenidas en ellas. Se resuelven enlaces simbólicos y se comprueba la ruta canónica para bloquear escapes; las entradas simbólicas no se muestran. Se devuelven como máximo 200 entradas por carpeta y `read_file` limita la lectura a 1 MiB de texto UTF-8.

`get_volume`, `set_volume`, `mute_volume` y `unmute_volume` controlan el volumen maestro. `set_volume` acepta únicamente enteros entre 0 y 100. `media_play_pause` envía únicamente la tecla multimedia global Play/Pause; no selecciona ni controla una aplicación o comando específico.

Estas tools también pasan por la permission policy central: `list_directory`, `read_file` y `get_volume` son `read`; los cambios de volumen y Play/Pause son `action`. La política predeterminada permite ambas categorías. El control de volumen usa la dependencia `loudness`; el envío de la tecla multimedia usa Koffi para llamar una sola API fija de Windows. Ambas acciones rechazan plataformas distintas de Windows.

No existe shell arbitrario ni PowerShell genérico. Tampoco existen `write_file`, `delete_file`, movimiento o renombrado de archivos, apagado ni reinicio. Las carpetas y operaciones están limitadas por código; el modelo no puede elegir un ejecutable o comando de sistema.
