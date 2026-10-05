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
- `discover_apps` actualiza el catálogo unificado leyendo accesos directos `.lnk` del menú Inicio y aplicaciones AppX/MSIX registradas. Solo inspecciona ubicaciones e identidades conocidas por Windows; no escanea el disco ni inicia aplicaciones durante el discovery.
- `open_url` abre solo URLs absolutas `http://` o `https://` en el navegador predeterminado.
- `get_open_apps` consulta el snapshot de procesos de Windows mediante Tool Help y devuelve como máximo 100 procesos con nombre y PID.

### Unified Windows App Discovery

`data/apps.json` es un catálogo generado/cacheado por `discover_apps`, no una lista mantenida manualmente. Mantiene el origen de cada entrada (`common_start_menu`, `user_start_menu` o `appx`) y los metadatos necesarios para localizarla y, cuando es posible, relacionarla con su proceso. Si la consulta AppX falla temporalmente, el catálogo conserva las entradas AppX ya conocidas y actualiza los accesos directos; una consulta exitosa sin resultados elimina las entradas modernas obsoletas.

`open_app` normaliza nombres, display names y aliases, resuelve coincidencias exactas o un prefijo inequívoco, y devuelve `ambiguous_app` con las opciones cuando hay varias coincidencias. Las aplicaciones tradicionales se inician solo si su ejecutable está bajo ubicaciones confiables. Las aplicaciones AppX/MSIX se inician a través de Explorer con un AppUserModelId validado. El inventario AppX usa una consulta fija y controlada de Windows, sin parámetros del modelo; el ejecutable de un manifiesto solo se usa como metadata para relacionar procesos y nunca como destino de lanzamiento.

GPT recibe únicamente el nombre lógico de la aplicación. No hay shell arbitrario, PowerShell genérico, rutas de lanzamiento ni argumentos libres proporcionados por el modelo.

La whitelist de `src/windows/app-whitelist.js` sigue siendo un fallback para `chrome`, `edge`, `notepad`, `calculator`, `explorer`, `spotify` y `discord`. Para agregar otra aplicación explícita, agregá su nombre lógico y una ruta fija bajo `windowsAppWhitelist`; mantené sus argumentos fijos y escritos en el código.

### Archivos, volumen y multimedia

Las herramientas `list_directory` y `read_file` solo trabajan dentro de `Desktop`, `Documents` y `Downloads` del perfil de Windows, incluidas sus ubicaciones conocidas de OneDrive cuando están configuradas. Aceptan esas carpetas como rutas relativas (por ejemplo `Documents\notas.txt`) o rutas absolutas contenidas en ellas. Se resuelven enlaces simbólicos y se comprueba la ruta canónica para bloquear escapes; las entradas simbólicas no se muestran. Se devuelven como máximo 200 entradas por carpeta y `read_file` limita la lectura a 1 MiB de texto UTF-8.

`get_volume`, `set_volume`, `mute_volume` y `unmute_volume` controlan el volumen maestro. `set_volume` acepta únicamente enteros entre 0 y 100. `media_play_pause` envía únicamente la tecla multimedia global Play/Pause; no selecciona ni controla una aplicación o comando específico.

Estas tools también pasan por la permission policy central: `list_directory`, `read_file` y `get_volume` son `read`; los cambios de volumen y Play/Pause son `action`. La política predeterminada permite ambas categorías. El control de volumen usa la dependencia `loudness`; el envío de la tecla multimedia usa Koffi para llamar una sola API fija de Windows. Ambas acciones rechazan plataformas distintas de Windows.

No existe shell arbitrario ni PowerShell genérico. Tampoco existen `write_file`, `delete_file`, movimiento o renombrado de archivos, apagado ni reinicio. Las carpetas y operaciones están limitadas por código; el modelo no puede elegir un ejecutable o comando de sistema.

### Ventanas de Windows

Nexa puede consultar procesos y ventanas visibles con `is_app_running`, `get_active_window` y `list_windows`. La consulta de una aplicación usa todos los procesos reportados por Windows, no solo los primeros 100 que devuelve `get_open_apps`. `list_windows` incluye título, proceso, PID e identificador interno; ese identificador solo se devuelve como información y ninguna herramienta de control acepta HWND o PID como argumento.

Para controlar una ventana, Nexa usa `focus_window`, `maximize_window`, `minimize_window`, `restore_window` o `close_window` con un nombre lógico de aplicación o criterio de título. Si el criterio coincide con más de una ventana, la acción se rechaza y devuelve las coincidencias para que se pueda precisar. `close_window` envía una solicitud normal de cierre a la ventana; no termina el proceso. Su resultado confirma que Windows aceptó el mensaje, no que la aplicación ya haya terminado. Windows puede rechazar el cambio de foco según su política de primer plano.

Ejemplos: “¿Está Spotify abierto?”, “¿Cuál es mi ventana activa?”, “¿Qué ventanas tengo abiertas?”, “Seleccioná Chrome”, “Maximizá Spotify”, “Minimizá Chrome”, “Restaurá Chrome” y “Cerrá Spotify”. Estas herramientas usan las categorías centrales `read` y `action` y una API Win32 fija mediante Koffi. No ejecutan shell, PowerShell, `taskkill` ni comandos externos elegidos por el modelo.
