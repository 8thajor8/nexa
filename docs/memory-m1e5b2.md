# M.1e.5b.2 — Contrato IPC del broker de identidad

## Alcance y estado

Este batch define y prueba un contrato IPC **sintético y test-only** para un broker de identidad futuro. No implementa transporte, broker, autenticación, sesión, autoridad, autorización, almacenamiento, servicio ni integración con el runtime. El harness vive bajo `test/support/`; ningún módulo de `src/` lo importa. Todos los resultados son `synthetic: true`, `authorization: DENY`, `executable: false` y `persistencePerformed: false`.

El harness mantiene solicitudes en mapas en memoria solo durante el test. No abre pipes ni sockets, no ejecuta comandos, no lee ni escribe archivos, no maneja credenciales, no invoca Windows Hello y no usa red. Sus `requestId` con prefijo `test_` son etiquetas de correlación, no secretos ni prueba de identidad. Una solicitud con forma válida solo significa que pasó una validación estructural.

## Contrato de mensajes

Cada mensaje de solicitud tiene versión fija y un conjunto cerrado de campos:

```json
{"protocolVersion":1,"requestId":"test_req_01","type":"authentication.start","payload":{"requestedTtlMs":30000}}
```

Tipos admitidos por el esquema:

| Tipo | Payload exacto | Efecto del simulador |
|---|---|---|
| `capabilities.query` | `{}` | Devuelve una lista informativa cerrada; no asegura que exista un broker real. |
| `authentication.start` | `{requestedTtlMs}` | Crea un estado efímero `pending`; no autentica a nadie. |
| `step_up.start` | `{requestedTtlMs, operation}` | Vincula el estado sintético al fingerprint de una operación permitida. |
| `request.status` | `{targetRequestId}` | Consulta estado sintético, con timeout aplicado. |
| `request.cancel` | `{targetRequestId}` | Consume una solicitud pendiente y la marca cancelada. |
| `session.status` | `{}` | Devuelve `unavailable` sin identificadores ni secretos. |

La lista cerrada de acciones para el **plan** de step-up es `memory.add`, `memory.replace`, `identity.bootstrap_owner`, `identity.bind_device`, `identity.revoke_device` y `session.revoke`. La forma del plan también es específica: `memory.add` y `identity.bootstrap_owner` exigen target nulo y revisión presente; reemplazo, vínculo/revocación de dispositivo y revocación de sesión exigen target y revisión presentes. El contrato no ejecuta ninguna. El fingerprint SHA-256 se calcula de forma determinista sobre la acción, target de fixture y revisión esperada; cambiar cualquiera cambia la huella. No lo acepta como claim del caller ni lo convierte en permiso.

No se aceptan campos adicionales. En particular, los mensajes no admiten `principalId`, `ownerId`, `installationId`, `verified`, `approved`, credenciales, rutas de archivo, comandos, firma genérica, grants o capacidades. Los registros se copian leyendo descriptores propios de datos; no se invocan getters ni se leen valores heredados. Solo se admiten objetos ordinarios o sin prototipo, y se rechazan keys inesperadas como `__proto__` y `constructor`. IDs y targets son ASCII acotado; se rechaza Unicode en estos campos en vez de normalizarlo. Revisiones deben ser enteros seguros no negativos y el TTL se limita a 120 000 ms; se comprueba que la suma temporal no desborde el rango entero seguro. El harness recibe objetos JavaScript directamente: puede atrapar excepciones de traps de un `Proxy`, pero no puede detectar genéricamente un proxy ni evitar que sus traps se ejecuten. La prueba cubre un trap que lanza error; no afirma aislar JavaScript hostil dentro del mismo proceso. Un broker IPC real debe decodificar bytes acotados como JSON antes de validar, sin aceptar objetos vivos suministrados por el cliente.

En el diseño futuro, la identidad del cliente IPC, la instalación local y el contexto autenticado deben obtenerse del broker/transporte confiable, nunca de argumentos del agente. Este harness no simula ni demuestra esa autenticación del cliente. En particular, un ID de solicitud no debe bastar para consultar o cancelar estado real: el broker tendrá que vincular cada solicitud a la conexión autenticada que la creó y autorizar cada consulta/cancelación bajo esa misma identidad.

Los errores tienen códigos cerrados, como `request_invalid`, `protocol_unsupported`, `request_replayed`, `payload_too_large`, `request_unknown`, `request_expired`, `request_cancelled`, `request_not_pending`, `operation_invalid`, `broker_unavailable`, `transport_failed` y `state_ambiguous`. La pérdida de transporte o estado ambiguo nunca se interpreta como éxito.

La función `validateSyntheticBrokerResponse` solo verifica la forma de un resultado de prueba marcado como sintético. Aceptar una forma con estado `verified` no autentica al emisor ni al usuario; el resultado conserva `DENY`, `executable: false` y `persistencePerformed: false`. Claims extra como `verified: true` se rechazan.

## Replay, concurrencia y cancelación

Dentro de una instancia del simulador, cada ID de solicitud entrante se acepta una sola vez. Una operación de step-up queda ligada a su fingerprint calculado, target y revisión. IDs repetidos se rechazan; solicitudes simultáneas con IDs distintos conservan estados separados; las solicitudes vencidas pasan a `timed_out`; una cancelación terminal no se puede revivir mediante consultas posteriores. Mensajes estructuralmente inválidos no reservan el ID. Fallo del reloj produce estado ambiguo y consume el ID para evitar reintento dudoso. Los accessors se rechazan sin invocarlos; las excepciones de traps de Proxy quedan capturadas y fallan cerradas, aunque la evaluación de un objeto proxy puede ejecutar sus traps. La respuesta shape-only no tiene una ruta de entrada al simulador, no correlaciona ni transiciona una solicitud, aunque declare `verified`; por eso una respuesta tardía o fuera de orden solo puede comprobar su forma y permanece denegada.

Estas son comprobaciones locales de fixtures, no protección de replay entre procesos, reinicios o instancias. En un broker real se necesitarían identidad y autorización del cliente en el transporte, IDs correlacionados con estado autoritativo, límites de concurrencia por ceremonia, expiración monotónica y durable cuando corresponda, consumo atómico, revisión/época actual, política de cancelación tardía y reconciliación de respuesta perdida. Ante resultado incierto, el caller no debe repetir una operación sensible ni interpretarla como aprobada; debe consultar al broker por un identificador no bearer y, si el estado no puede reconciliarse, denegar y exigir una nueva autenticación explícita.

## Modelo de amenazas IPC

| Amenaza | Requisito para un broker real | Qué demuestra este batch |
|---|---|---|
| Cliente no autorizado u otro proceso bajo el mismo SID | ACL/descriptor del endpoint, comprobar identidad del peer a nivel de sistema operativo, comprobar instalación y aplicar política en el broker | Nada sobre autorización del peer; solo se rechazan claims de identidad incluidos en el mensaje |
| Renderer comprometido o modelo/tool malicioso | Sin acceso directo al pipe; IPC de Desktop validado por frame/origen; API de preload mínima, operaciones allowlist y decisión humana por UI confiable | El esquema rechaza operación genérica, campos desconocidos y comandos |
| Respuesta suplantada | Canal local autenticado y correlación con estado pendiente del broker; datos de respuesta validados | La respuesta shape-only se etiqueta no autenticada y siempre denegada |
| Replay, mensajes duplicados o solicitudes concurrentes | Registro autoritativo, consumo atómico y serialización/bloqueo en broker | Dedupe y estados en memoria dentro de una única instancia de test |
| Confusión de sesión, instalación u operación | El broker obtiene el principal/instalación por contexto confiable y canonicaliza la operación antes de mostrarla | El mensaje no puede declarar principal/instalación; step-up enlaza la operación sintética proporcionada |
| Cancelación tardía, reinicio o respuesta perdida | Máquina de estados durable o reconciliable; fallo cerrado ante resultado incierto | Cancelación/expiración in-memory; sin reinicio ni transporte real |
| Payload malformado o excesivo | Límites antes de parsear y después de decodificar, framing acotado, validación exacta | Esquemas cerrados, límite de 8 KiB, rechazos de tipos/accessors; excepciones de traps quedan capturadas, sin pretender aislar objetos Proxy |

Un contrato de mensajes no es una frontera de seguridad por sí solo. Un named pipe de Windows futuro deberá restringir quién puede conectarse y validar el PID/token/SID del peer mediante APIs del sistema, vinculándolo a una instalación registrada. Comparar un SID por texto no autentica al Owner y no distingue procesos maliciosos con el mismo usuario. El broker debe ser autoridad independiente del modelo y minimizar la superficie IPC; no debe exponer firmar datos arbitrarios, ejecutar comandos, leer archivos, devolver claves ni aceptar `HWND`, RP ID, principal o propósito elegidos por un mensaje no confiable.

## Investigación de RP ID y origen nativo

La documentación de Microsoft confirma que una aplicación nativa puede actuar directamente como cliente WebAuthn y que `WebAuthNAuthenticatorGetAssertion` recibe `HWND`, RP ID, `WEBAUTHN_CLIENT_DATA` y opciones. La estructura de client data contiene bytes JSON aportados por el cliente. Por tanto, un verificador local debe validar estrictamente el challenge, tipo, origen permitido, RP ID hash, credencial, firma y contexto de operación; el autenticador no convierte automáticamente un string `origin` en una prueba del ejecutable que llamó a la API. [API Win32](https://learn.microsoft.com/en-us/windows/security/identity-protection/hello-for-business/webauthn-apis), [`GetAssertion`](https://learn.microsoft.com/en-us/windows/win32/api/webauthn/nf-webauthn-webauthnauthenticatorgetassertion), [`WEBAUTHN_CLIENT_DATA`](https://learn.microsoft.com/en-us/windows/win32/api/webauthn/ns-webauthn-webauthn_client_data).

WebAuthn web exige que el RP valide el `origin`; su ejemplo admite que una aplicación acompañante nativa use un identificador dependiente del sistema operativo en una allowlist. La especificación también permite a protocolos no web definir reglas diferentes. Esas cláusulas **no prueban que Windows vincule un identificador nativo a un binario firmado**, ni especifican cuál sería el identificador adecuado para Nexa. [W3C WebAuthn Level 3, validación de origin](https://www.w3.org/TR/webauthn-3/#sctn-rp-origin-validation) y [API Win32 de assertion](https://learn.microsoft.com/en-us/windows/win32/api/webauthn/nf-webauthnauthenticatorgetassertion).

El origen de aplicación nativa y el campo `pwszRemoteWebOrigin` presente en la estructura de opciones no deben tratarse como equivalentes: la documentación pública consultada muestra el campo, pero no fundamenta con ello un vínculo entre el origen y un ejecutable local. No se ha identificado evidencia suficiente para escoger un RP ID/origen nativo que pruebe identidad del host. `localhost` no se propone como RP ID de producción por defecto: es un espacio compartido localmente y el puerto no delimita el ámbito de la credencial. Un dominio HTTPS dedicado ofrece reglas de origen web estándar, aunque su encaje con uso offline y empaquetado aún debe diseñarse. En consecuencia, **la decisión de origen nativo continúa bloqueada**.

## Siguiente etapa propuesta: M.1e.5b.3

1. Elegir, con evidencia de Microsoft y una prueba aislada autorizada, si el broker invocará la API Win32 directamente o si se usará WebAuthn del navegador/WebView bajo un origen HTTPS dedicado.
2. Precisar autenticación de peer y permisos de un named pipe Windows, incluyendo el modelo frente a procesos del mismo SID; no construir todavía un servicio auto-elevado.
3. Definir el contexto confiable que fija instalación, principal, origen y HWND, y cómo se canonicaliza una operación para step-up.
4. Definir reconciliación tras caída/respuesta perdida, consumo durable, revocación y continuidad del store.
5. Solo después de aprobar origen, transporte, política de recuperación y modelo de amenazas, proponer un spike nativo con credenciales ficticias/de prueba y consentimiento separado. No conectar resultados a Owner, sesiones productivas, Memory2 ni Automatic Memory.

## Validación y límites

El test focalizado comprueba formas válidas e inválidas, versión, allowlist, fingerprint de operación, claims falsos, replay de IDs, solicitudes concurrentes, timeout, cancelación tardía, respuesta no autenticada, errores, payload grande y aislamiento estático del harness. Son pruebas sintéticas, no una evaluación del sistema operativo ni de un transporte.

No se eligió tecnología de transporte, host nativo, RP ID ni origen. No se instalaron dependencias y no se modificó Nexa Desktop, Voice, runtime productivo, tools, Memory1 o Memory2. El harness no está disponible al modelo y no concede autenticación, permiso, sesión o capacidad ejecutable.
