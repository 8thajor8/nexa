# M.2a — Contrato UI–Identity–Memory v0.1

## Estado y alcance

M.2a agrega un contrato cerrado y versionado para probar la frontera futura entre Nexa Memory2 y un broker de identidad. Es código puro y aislado: no está importado por Electron, UI, Voice, Runtime, tools, `MemoryService` ni un repositorio. No crea broker, permisos, credenciales, sesiones, Owner ni almacenamiento. No activa Memory2 ni Automatic Memory.

El módulo está en `src/memory/broker-authorization-contract.js`. Sus respuestas llevan `syntheticOnly: true`, `authorization: DENY`, `permission: null` y `executable: false`, también cuando una referencia coincide estructuralmente o una decisión de política es `ALLOW` hipotético. Un objeto `approved` o una etiqueta de origen no autentica a quien lo presentó. El contrato no verifica firmas, MAC, peer IPC, identidad humana o autoridad del emisor.

## Actores y frontera de confianza futura

```text
Runtime ── intención y solicitud canónica ──▶ Electron Main ── IPC ──▶ Identity Broker
    ▲                                               │                    │
    │                                               │ presenta UI        │ autentica,
    │                                               ▼                    │ decide y emite
    └──────── resultado acotado ◀──────── Renderer ◀────────────────────┘ referencia verificable
    │
    └──▶ Memory2 valida por sí misma referencia, operación, recurso,
         snapshot, expiración y epoch antes de cualquier operación
```

El diagrama es una dirección arquitectónica, no una integración existente. Electron Main administra el ciclo del broker y media el IPC. El Renderer solo presenta y recoge interacción; sus mensajes no son aprobaciones. El broker mantiene la autoridad de identidad y política. Memory2 debe verificar la autorización de nuevo y denegar ante error, ausencia de autoridad o inconsistencia. Runtime integrará las herramientas posteriormente y no debe poder sustituir la verificación de Memory2. Desktop, Voice, Mobile y Wearable son metadatos de canal: ninguno concede permisos ni assurance.

## Datos separados

`validateMemoryIntent()` representa una intención sin confiar en su fuente. Distingue `direct_user`, `model`, `tool`, `retrieved_memory` y `system`, y enlaza un fingerprint de candidato y el tipo de operación propuesto. No conserva texto original ni autoridad.

`validateMemoryAuthorizationRequest()` representa la operación canónica solicitada. El request v0.1 contiene:

- Versión, `requestId` de correlación, referencia fingerprintada a la intención que declara el mismo tipo de operación, y canal.
- Principal, instalación, sesión, época de sesión y epoch de revocación, todos como identificadores declarados que esta capa no autentica.
- Operación cerrada, recurso, ámbito, fingerprint del target, fingerprint del payload y destinatarios explícitos cuando corresponden.
- Snapshot con revisión y digest, hora de solicitud y vencimiento UTC.

Las operaciones son `read`, `query`, `add`, `replace`, `correct`, `forget`, `delete`, `share` y `administer`. Las operaciones sobre un target requieren el ID y fingerprint exactos; ADD requiere fingerprint del payload; SHARE requiere target exacto, ámbito `shared` y destinatarios no repetidos en orden canónico; ADMINISTER exige un tipo de recurso y acción administrativa de listas cerradas. QUERY enlaza sus parámetros mediante fingerprint, sin incluir el texto de consulta. Los fingerprints son enlaces de integridad, nunca secretos ni permisos. El validador puro comprueba la consistencia declarada entre el tipo de intención y operación; el futuro broker deberá resolver la intención autoritativa por ID y recalcular su fingerprint. El contrato no puede autenticar esa procedencia.

`validateConfirmationInteraction()` representa presentación y respuesta estructurada, ligada al request y canal. Una respuesta `approve` solo describe la interacción; no modifica la autorización.

La hora de una interacción debe estar dentro de la ventana del request: no puede preceder `requestedAt`, empezar en o después de `expiresAt`, ni extender su propia expiración más allá del request. La validación es estructural; no aporta un reloj confiable.

`validateAuthenticationEvidence()` permite `none` o una etiqueta de evidencia WebAuthn sintética, y exige `verified: false`. Una alegación `verified: true` se rechaza. Ni la prueba ni su fingerprint verifican autenticidad.

`validateMemoryPolicyDecision()` mantiene por separado `ALLOW`, `DENY` o `ASK` y códigos de motivo cerrados. `ALLOW` se marca `hypotheticalAllow`; no crea permiso.

La referencia de autorización contiene ID, request, principal, instalación, sesión, fingerprint de request y operación, recurso, snapshot, vencimiento, epochs y una cadena `opaqueReference`. En esta versión la cadena solo valida forma: no la emite ni verifica un broker, y no es una capability. `matchSyntheticAuthorizationReference()` compara todos los enlaces con el request y un contexto actual sintético; devuelve solo una coincidencia hipotética, con autorización final DENY.

La única representación de un permiso ejecutable en esta etapa es `permission: null`. `verifyExecutableMemoryPermission()` deniega siempre con `real_permission_verifier_unavailable`.

## Ciclo de vida

`createSyntheticAuthorizationLifecycle()` inicia en `pending`. `applySyntheticAuthorizationEvent()` exige eventos versionados, ligados al request, con canal coincidente, `source: synthetic_fixture`, revisión esperada, timestamps monotónicos, ID de evento no repetido y transiciones permitidas:

```text
pending → presented | denied | cancelled | expired | revoked
presented → approved | denied | cancelled | expired | revoked
approved → consumed | expired | revoked
```

Los demás estados son terminales. `approved` y `consumed` requieren una referencia identificable, pero la máquina solo conserva esa referencia sintética: no valida una ceremonia de confirmación, una decisión de política, una firma o el uso real de un permiso. La revisión detecta replay dentro del estado suministrado y rechaza revisiones obsoletas. Al ser pura, una llamada independiente puede volver a presentar un snapshot viejo; la exclusión entre procesos y consumo único requieren almacenamiento autoritativo y una transacción atómica futura.

## Validación y fallos cerrados

Los esquemas rechazan propiedades extra, prototipos no ordinarios, accessors, arrays dispersos, enums desconocidos, fingerprints malformados, fechas no canónicas, epochs/revisiones fuera de rango, duplicados, operation/resource contradictorios y referencias cruzadas. La entrada se copia desde descriptores propios de datos para que un getter del caller no se ejecute durante la validación. Los fallos devuelven códigos limitados, sin reflejar texto de usuario ni datos arbitrarios.

Los estados de ciclo de vida también deben ser internamente coherentes: la revisión coincide con el número de IDs de evento, `pending` solo puede ser el estado inicial, y `approved`/`consumed` requieren un ID de autorización sintético. Un evento no puede introducir un ID de autorización antes de `approved`; eventos posteriores deben conservar exactamente el ID ya fijado. Esto detecta snapshots estructuralmente imposibles, pero no demuestra que el historial o la transición hayan ocurrido realmente. El contrato recibe objetos JavaScript ya construidos; no analiza JSON wire. Un futuro parser IPC debe rechazar nombres de miembro duplicados antes de materializar el objeto, porque `JSON.parse` normalmente descarta esa distinción.

La coincidencia de referencia comprueba principal, instalación, sesión, estado, dispositivo, revisión/digest, epochs, caducidad y revocación sintética. Estos valores son fixtures provistas al evaluador; pasar la comparación no autentica ni protege contra un caller que falsifique todo el contexto. Tampoco se consulta reloj confiable, estado persistente ni lista durable de revocación.

## Matriz de amenazas y decisiones

| Amenaza | Control en v0.1 | Garantía actual | Pendiente para producción |
|---|---|---|---|
| Renderer/modelo falsifica `approved` o `verified` | Datos separados; evidencia exige `verified: false`; solo fixture en eventos | No produce permiso; outputs siempre DENY | Autenticación del peer broker y validación de firma por Memory2 |
| Cambian operación, target, destinatario o payload | Operación cerrada y fingerprints exactos | Cambios estructurales no coinciden con referencia | Canonicalización y fingerprint compartidos y versionados entre procesos |
| Replay o referencia vieja | Vencimiento, epochs y revisión CAS en el evaluador | Detección contra contexto sintético actual y estado local suministrado | Emisión de nonce/challenge, persistencia, consumo atómico y protección multi-proceso |
| Sesión/principal/instalación cruzados | Enlaces exactos en request, referencia y contexto | Rechazo de discrepancia declarada | Sesiones auténticas, estado de cuenta y revocación duradera del broker |
| Snapshot Memory2 obsoleto | Revisión y digest comparados | Rechazo en el contrato puro | Memory2 vuelve a leer bajo su lock y vincula el commit a la revisión |
| Canal Voice/Mobile/Wearable eleva permisos | Canal enum solo descriptivo | Cambiar canal no cambia fingerprint de operación ni autoridad | Política común por operación; autenticación específica del dispositivo si se necesita |
| Ámbito compartido revela datos | Receptores explícitos; scope y target fingerprintados | Contrato enlaza la solicitud, no filtra recuerdos | Aislamiento Memory2 y autorización de cada destinatario |
| Referencia opaca se falsifica | Formato acotado y estado sintético | Ninguna propiedad criptográfica | MAC/firma, rotación de clave, revocación y verificación independiente |

## Pruebas

`test/memory-m2a-broker-contract.test.js` usa identidades, fingerprints, snapshots y referencias sintéticos. Cubre las nueve operaciones, campos desconocidos y contradictorios, inputs con accessors/Proxy, independencia del canal, alteración de identidad/operación/recurso/snapshot/epochs, caducidad, revocación, estados suspendidos, separación de confirmación/evidencia/política, transiciones y replay del mismo estado, y denegación de permiso ejecutable.

Estas pruebas validan contratos de datos y transiciones puras, no IPC, autenticación, autorización real, aislamiento de almacenamiento, concurrencia entre procesos ni persistencia durable. No llaman a OpenAI, no escriben recuerdos y no ejecutan el broker.

## Cuestiones abiertas antes de integración real

1. Elegir el mecanismo verificable de referencia (firma/MAC y formato interoperable), custodia de claves y rotación; la cadena opaca actual no tiene semántica criptográfica.
2. Acordar TTL máximo, tolerancia de reloj y autoridad temporal.
3. Definir fingerprints canónicos compartidos, especialmente consultas, ADD, REPLACE, correcciones y administración.
4. Definir evidencia y política de autenticación step-up por operación, sin convertir interacción del Renderer en autoridad.
5. Diseñar revocación, replay y consumo atómico con reinicios y procesos concurrentes.
6. Definir cómo Memory2 obtiene el contexto autenticado de sesión sin confiar en claims de Runtime o Renderer.
7. Fijar autorización por ámbito, destinatario y privacidad, incluida administración Owner sin acceso implícito a recuerdos privados.
8. Establecer auditoría mínima, recuperación ante resultados inciertos y compatibilidad/versionado IPC.

La transición a implementación requiere revisión conjunta de UI e Ingeniería Memory y pruebas de integración en un store temporal. Esta etapa no activa ninguna capacidad real.
