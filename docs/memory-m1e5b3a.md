# M.1e.5b.3a — Transporte IPC local aislado

## Alcance

Este prototipo demuestra intercambio de mensajes sintéticos entre un cliente Node.js y un proceso broker separado. Vive exclusivamente bajo `test/support/` y pruebas; no se importa desde `src/`, no se registra como tool y no se conecta al agente ni a Desktop. No autentica personas o procesos, no autoriza operaciones y no emite credenciales. Cada resultado conserva `synthetic: true`, `authorization: DENY`, `executable: false` y `persistencePerformed: false`.

## Transporte elegido

Se usan pipes anónimos creados por `child_process.spawn` sobre `stdin` y `stdout` del proceso hijo. Para este laboratorio son más acotados que un named pipe: no existe nombre global que pueda estar ocupado o ser registrado previamente, no se escucha en TCP y no se aceptan conexiones remotas. El test crea el hijo con `shell: false`, ejecutable Node conocido y script de broker concreto, y lo termina al cerrar cada caso.

La elección demuestra transporte local de proceso, no un canal autenticado. El cliente posee un handle al hijo que creó, pero no verifica firma del ejecutable ni protege contra modificación del script, compromiso del padre/hijo o malware bajo el mismo SID. El cliente valida cada frame como entrada no confiable y fija su propia salida a DENY; ni siquiera una respuesta con forma de éxito puede elevar autoridad. La prueba de sustitución demuestra que una respuesta maliciosa que no cumpla la forma segura no supera la validación.

## Protocolo de laboratorio

Se usa framing JSON Lines sobre bytes UTF-8, con máximo de 8 KiB por frame y versión 1. El broker espera el delimitador de línea antes de parsear, limita el buffer incompleto, rechaza JSON malformado y delega los objetos parseados al contrato M.1e.5b.2. Solo admite la lista cerrada del contrato; errores son códigos sintéticos tipados. Las respuestas incluyen la correlación del request ID y el resultado sintético completo. El cliente impone tamaño máximo, valida la forma y campos de seguridad, correlaciona la respuesta a un request pendiente y rechaza frames desconocidos, duplicados, cruzados o malformados. No reintenta solicitudes tras timeout.

Las operaciones de estado y cancelación son en memoria dentro de un único hijo. Al cerrarlo, todo estado desaparece; una nueva instancia no recupera solicitudes previas. Cancelar termina únicamente el estado de prueba indicado. Timeout local produce `transport_failed` y requiere que quien llama niegue y reconcilie; no significa que el broker no haya recibido el mensaje.

## Límites y amenazas

| Amenaza | Resultado en este laboratorio | Requisito para producción |
|---|---|---|
| Puerto remoto o escucha accidental | No hay socket de red ni puerto | Mantener un endpoint local acotado y revisar el empaquetado |
| Named pipe preexistente / nombre suplantado | No aplica: se usan handles de pipes anónimos heredados por el hijo creado | Si se migra a named pipe, ACL explícita, creación segura, validación de peer y carrera de nombre |
| Suplantación del broker | No se autentica el binario; el padre inicia una ruta fija de test y valida respuestas como datos no confiables | Firma/verificación del host o mecanismo equivalente, canal y protocolo vinculados; no confiar solo en SID |
| Suplantación del cliente | El pipe llega al hijo creado por el test; no se comprueba persona ni identidad del peer | Autenticación de cliente derivada del SO y política en broker |
| Otro usuario Windows | No hay endpoint compartido para conectar; no se prueba aislamiento entre cuentas | ACL/token/identidad de peer comprobados en Windows |
| Malware con el mismo SID | Fuera de las garantías; puede interferir con archivos o procesos del mismo usuario según sus permisos | Aislamiento de privilegios/proceso; aun así, malware con mismo usuario puede atacar UI/runtime |
| Replay y concurrencia | Deduplicación por instancia y correlación de respuestas; sin persistencia | Estado autoritativo, consumo atómico, límites por peer y protección de reinicio |
| Frames incompletos, grandes o malformados | Rechazo por límite, timeout y error tipado; JSON se parsea solo al completar línea | Límites también antes de asignaciones grandes y framing documentado/versionado |
| Caída, cierre y reinicio | Cliente falla cerrado; no se hacen reintentos; reinicio pierde estado | Reconciliación de resultados inciertos con estado autoritativo |

La prueba no puede medir ACL de named pipes, identidad del peer, acceso desde otra cuenta ni protección contra malware del mismo SID. Una ACL con SID limita cuentas, no demuestra qué aplicación se conecta. Los pipes anónimos eliminan el caso de un endpoint named pipe preexistente para esta prueba, pero el proceso que crea y mantiene los handles sigue siendo parte de la base de confianza.

El broker no invoca Windows Hello, no tiene RP ID ni origin configurados y no manipula passkeys. M.1e.5b.2 dejó pendiente demostrar un binding verificable de origin/RP ID para la API WebAuthn nativa de Windows; este transporte no resuelve esa dependencia.

## Relación con Desktop UI

En una futura integración, Desktop UI podría presentar una confirmación de operación canónica y solicitar una acción al broker mediante un API limitado. El modelo y sus tools no deben obtener handles del pipe, rutas de proceso, acciones administrativas ni acceso directo al broker. La UI no debe pasar a un renderer valores `verified` como si fueran autorización; el broker debe volver a validar contexto, identidad, operación, sesión y revisión. Esta etapa no implementa ni propone conectar la UI.

## Validación y siguiente etapa

Las pruebas sintéticas cubren conexión entre procesos, frames válidos/malformados, concurrencia, replay, timeout, cancelación, EOF incompleto, payload excesivo, cierre/reinicio, respuestas duplicadas/cruzadas y sustitución de broker. El child-process transport y el manejo de streams se ejercitan en procesos reales de laboratorio. No son pruebas de autenticación de peer, seguridad de Windows ACL, autenticidad binaria, WebAuthn criptográfico, durabilidad, aislamiento por usuario ni disponibilidad.

Antes de M.1e.5b.3b, decidir si el broker seguirá como hijo efímero de Desktop o será un servicio local con named pipe. Si se mantiene como hijo, definir verificación del artefacto, ciclo de vida y límites entre renderer/main/broker. Si se adopta named pipe, hacer primero una prueba separada de descriptor de seguridad, adquisición exclusiva del nombre y obtención de token/PID del peer; no tratar el SID por sí solo como identidad de aplicación. Resolver también el origen/RP ID WebAuthn nativo antes de permitir cualquier ceremonia real.
