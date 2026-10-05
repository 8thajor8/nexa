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

### Spotify

La integración de Spotify está en `src/integrations/spotify/` y usa la Web API con OAuth Authorization Code + PKCE. Es independiente de los controles multimedia globales de Windows: `media_play_pause` sigue enviando una tecla multimedia del sistema, mientras que `spotify_*` usa la cuenta y los dispositivos Spotify Connect autorizados. Spotify Desktop también se puede abrir o consultar por separado con `open_app`, `is_app_running` y `focus_window`.

Las herramientas disponibles son `spotify_get_current_track`, `spotify_get_devices`, `spotify_search`, `spotify_play`, `spotify_pause`, `spotify_next` y `spotify_previous`. Las lecturas y búsquedas usan `external_read`; las acciones de reproducción usan `action`. `spotify_play` acepta una búsqueda y un tipo (`track`, `artist` o `album`), consulta Spotify y solo inicia un resultado exacto y no ambiguo. Con una búsqueda vacía reanuda lo que ya está en reproducción. `spotify_search` devuelve como máximo cinco resultados y Nexa los presenta con un enlace al elemento correspondiente en Spotify.

Spotify requiere una aplicación creada manualmente en [Spotify Developer Dashboard](https://developer.spotify.com/dashboard). En **Edit Settings**, agregá exactamente `http://127.0.0.1:8888/callback` como Redirect URI. Copiá el Client ID a tu `.env`:

```env
SPOTIFY_CLIENT_ID=el_client_id_de_tu_app
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/callback
```

No se necesita Client Secret: PKCE permite la autorización sin guardar un secreto de aplicación. Podés partir de `.env.example`. Para la autorización inicial, ejecutá `npm run spotify:auth`, abrí el enlace que muestra la terminal, iniciá sesión y aceptá los permisos. El callback local intercambia el código y guarda los tokens en `data/spotify-token.json`; ese archivo está excluido de Git y los access tokens se renuevan automáticamente. Si Spotify revoca el refresh token, repetí la autorización.

La autorización solicita estos scopes: `user-read-currently-playing`, `user-read-playback-state` y `user-modify-playback-state`. La API necesita un dispositivo Spotify Connect disponible para reproducir y pausar; los endpoints de control de reproducción requieren Spotify Premium. En Development Mode, Spotify también requiere que la cuenta propietaria de la app tenga Premium y limita una app nueva a cinco usuarios. Ante un pedido explícito de reproducción, Nexa intenta recuperar Spotify Desktop si la API informa que no hay dispositivo; las consultas y búsquedas no abren la aplicación.

Los datos de Spotify se presentan directamente desde Nexa con atribución y enlaces a Spotify. Las [condiciones de Spotify](https://developer.spotify.com/policy) prohíben introducir Spotify Content en un modelo de IA, así que los resultados con nombres de pistas, artistas, álbumes o dispositivos se filtran antes de devolver el resultado de una tool al modelo; el modelo recibe únicamente un estado de control mínimo. Spotify Search no se convierte en una búsqueda web alternativa cuando falla.

### Ventanas de Windows

Nexa puede consultar procesos y ventanas visibles con `is_app_running`, `get_active_window` y `list_windows`. La consulta de una aplicación usa todos los procesos reportados por Windows, no solo los primeros 100 que devuelve `get_open_apps`. `list_windows` incluye título, proceso, PID e identificador interno; ese identificador solo se devuelve como información y ninguna herramienta de control acepta HWND o PID como argumento.

Para controlar una ventana, Nexa usa `focus_window`, `maximize_window`, `minimize_window`, `restore_window` o `close_window` con un nombre lógico de aplicación o criterio de título. Si el criterio coincide con más de una ventana, la acción se rechaza y devuelve las coincidencias para que se pueda precisar. `close_window` envía una solicitud normal de cierre a la ventana; no termina el proceso. Su resultado confirma que Windows aceptó el mensaje, no que la aplicación ya haya terminado. Windows puede rechazar el cambio de foco según su política de primer plano.

Ejemplos: “¿Está Spotify abierto?”, “¿Cuál es mi ventana activa?”, “¿Qué ventanas tengo abiertas?”, “Seleccioná Chrome”, “Maximizá Spotify”, “Minimizá Chrome”, “Restaurá Chrome” y “Cerrá Spotify”. Estas herramientas usan las categorías centrales `read` y `action` y una API Win32 fija mediante Koffi. No ejecutan shell, PowerShell, `taskkill` ni comandos externos elegidos por el modelo.

### Windows UI Automation

Window Management cambia o consulta la ventana completa (por ejemplo, enfocarla o maximizarla). UI Automation inspecciona los controles accesibles dentro de una ventana —botones, campos, listas y sus valores— mediante las APIs Microsoft UI Automation de Windows. El proveedor está en `src/windows/ui-automation/uia-provider.ps1` y se ejecuta como un archivo fijo de implementación con una solicitud JSON acotada por stdin; Nexa no acepta ni evalúa comandos PowerShell del modelo.

Las herramientas `inspect_ui`, `find_ui_element` y `get_ui_value` tienen permiso `read`. `focus_ui_element`, `invoke_ui_element` y `set_ui_value` tienen permiso `action`. La inspección y búsqueda usan la aplicación abierta resuelta por el catálogo existente. El árbol se limita por defecto a 4 niveles, 80 controles y 160 caracteres por nombre; el máximo permitido es 6 niveles, 150 controles y 300 caracteres. `get_ui_value` devuelve como máximo 1000 caracteres y `set_ui_value` acepta hasta 2000.

`inspect_ui` y `find_ui_element` entregan referencias `ui_*` generadas por Nexa. Duran dos minutos, quedan ligadas a la ventana inspeccionada y se vuelven a resolver por identidad UIA y contexto del árbol actual; runtime ID ayuda cuando sigue estable, pero no es la única identidad. Si el elemento desapareció, la ventana cambió o la resolución quedó ambigua, la acción devuelve un error estructurado y no actúa sobre otro control. Para un control conocido, `find_ui_element` hace la consulta y entrega la referencia; no hace falta llamar antes a `inspect_ui`. `invoke_ui_element` y `set_ui_value` actúan directamente, sin una llamada previa a `focus_ui_element`.

UI Automation y Window Management comparten `matchWindows` sobre el mismo snapshot de ventanas y catálogo. Las apps Win32 se vinculan por el proceso conocido; las apps AppX/MSIX también pueden vincularse por título exacto cuando la ventana pertenece a `ApplicationFrameHost.exe`. La UI Automation usa solo una ventana única y conserva la ambigüedad si hay varias candidatas; el HWND se mantiene interno hasta pasarlo al proveedor fijo de Windows.

`invoke_ui_element` solo usa el patrón Invoke y puede tener efectos sensibles. `set_ui_value` usa ValuePattern cuando está disponible y admite únicamente controles no marcados como solo lectura. TextPattern es de lectura; cuando el control solo expone ese patrón, Nexa devuelve `text_pattern_read_only` y no simula escritura con teclado o portapapeles. No envía formularios o mensajes. No hay clicks por coordenadas, clipboard, OCR ni screenshots.

Para depurar el ciclo de referencias durante el desarrollo, activar `NEXA_UI_AUTOMATION_DEBUG=true`. Los diagnósticos incluyen la herramienta, el tipo de operación, el resultado y el motivo de invalidación; al escribir texto registran solo su longitud, nunca el contenido.

### WhatsApp Desktop

La integración específica está en `src/integrations/whatsapp/`. `whatsapp_open_chat` abre o enfoca WhatsApp, busca el contacto, abre el resultado único y verifica el nombre accesible del encabezado. `whatsapp_prepare_message` repite esa verificación, localiza el composer, comprueba que esté vacío y deja el texto como borrador. Informa `sent: false` y el flujo no busca ni invoca el control Enviar.

El contacto y los controles se resuelven por metadatos UI Automation (tipo, nombre, AutomationId, patrón soportado y contexto accesible), con variantes en español e inglés. Si la búsqueda o identidad del chat es ambigua, no actúa. Los borradores existentes no se sobrescriben; la respuesta incluye su longitud, sin exponer el contenido. La app debe aparecer en el catálogo local de `discover_apps`. La interfaz de WhatsApp puede cambiar y los controles no accesibles producen un error seguro. La interacción requiere Windows y WhatsApp Desktop abierto o instalado.

**Sending messages is intentionally not implemented yet.** No existe una tool de envío; esta etapa solo prepara borradores. La integración usa el catálogo, Window Management y el proveedor fijo de UI Automation. No acepta HWND/PID del modelo y no usa coordenadas, OCR, shell, PowerShell arbitrario, teclado ni portapapeles.

El agente cuenta como máximo cinco rondas que solicitan herramientas (`maxToolIterations`). Si la quinta ronda usa herramientas, se permite un turno final del modelo con las herramientas deshabilitadas para redactar la respuesta; ese turno no puede ejecutar otra acción. `NEXA_AGENT_DEBUG=true` registra número de ronda, herramienta, resumen seguro de argumentos, resultado y tipo de respuesta del modelo sin imprimir valores de texto.

Las pruebas automatizadas usan un proveedor simulado y no requieren aplicaciones abiertas. Para validarlo localmente, ejecutá `npm start`, abrí Calculator o Notepad, pedile a Nexa `inspeccioná los controles de Notepad`, y probá después `buscá el campo de edición de Notepad` o `leé el valor de ui_1` usando la referencia que Nexa haya recibido. La inspección real requiere una sesión interactiva de Windows y una aplicación abierta.
