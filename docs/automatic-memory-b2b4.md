# Automatic Memory B.2b.4 — Schema v5 y persistencia transaccional

## Estado y límites de esta etapa

La revisión parte de `main` en `f87d07d650c712ae3593289410bf57da33ea17e4`, sincronizada con `origin/main` y limpia. Esta entrega es solo diseño. No cambia código, schema, repositorio, dependencias ni stores, y no habilita escrituras automáticas.

Memory1 conserva el SHA-256 esperado. `data/memory-v2.json` no existe; `NEXA_MEMORY_BACKEND` está sin definir y la configuración resuelve `memory1`.

## 1. Diagnóstico de la arquitectura actual

### Schema v4 y servicio

El schema valida un objeto de forma exacta, rechaza campos y colecciones desconocidos y admite cinco colecciones: `entities`, `assertions`, `sources`, `evidence` y `migrations`. Las aserciones contienen sujeto, predicate, objeto, estado, intervalo temporal y referencias a supersession. Cada aserción requiere evidencia enlazada a una fuente. Los recibos de `migrations` identifican conversiones de Memory1 por fingerprint de origen; sus campos y semántica no sirven como recibos de Automatic Memory.

`MemoryService` consume una autorización explícita y de un solo uso antes de mutar. Su `remember` busca aserciones activas en el mismo slot: si encuentra una equivalente devuelve `equivalent`, y si encuentra una distinta puede supersederla. Por ello, no es una implementación de ADD append-only para Automatic Memory. Un futuro ejecutor deberá conservar la semántica separada: ADD siempre añade sin superseder; REPLACE cambia solo el destino exacto aprobado.

### Repositorio JSON

`commit` acepta cambios tipados con `expectedRevision` y `expectedDigest`. El repositorio clona el store, aplica el lote entero, incrementa una revisión, valida todas las referencias y publica un snapshot inmutable. No rebasea ni reintenta silenciosamente.

El repositorio JSON usa una cola serial por instancia y un lock `wx` compartido por procesos que cooperan. Al abrir, lee el store, adquiere el lock y lo vuelve a leer. Al confirmar, comprueba el store y la revisión/digest, construye el estado nuevo, escribe y sincroniza un temporal en el mismo directorio, verifica de nuevo el lock y el store observado, y reemplaza el archivo por rename. Si ocurre un error después de intentar el rename, compara el contenido real con el anterior y con el candidato; si no puede establecer el resultado, marca esa instancia como incierta. Los errores no tienen reintento automático.

El lock no coordina editores ni procesos que lo ignoren. Entre la última comprobación y el rename aún existe una ventana frente a escritores externos. Los locks abandonados no se roban automáticamente. Un proceso terminado abruptamente puede dejar un temporal huérfano. El archivo temporal se sincroniza, pero no hay una garantía portable de sincronización del directorio ni de durabilidad ante cualquier corte de energía o filesystem.

Estas son tres garantías distintas y limitadas: **atomicidad lógica** significa publicar el snapshot completo (y, en el diseño v5, sus recibos) mediante un único reemplazo del archivo; **concurrencia** significa coordinación entre procesos que usan el repositorio oficial y respetan su lock; **durabilidad** depende del filesystem y del sistema operativo después de sincronizar el temporal y reemplazar el destino. Ninguna de ellas implica las otras. Un escritor externo que ignore el lock no queda protegido ni excluido por este protocolo.

### Automatic Memory y pruebas

B.2a calcula una clave SHA-256 determinista ligada al tipo de operación, candidato, texto de origen, snapshot y destino de REPLACE. `idempotency.recorded` sigue en `false`. B.2b.1 rechaza claims estructurados como prueba: `authorization.granted`, `authorizationRequestEligible` y `executable` permanecen en `false`. B.2b.1b aporta una prueba opaca de entrada local, ligada al turno y consumible una vez, pero representa el origen de stdin, no una persona autenticada ni una autorización de escritura; el adaptador no concede scopes.

B.2b.2 contiene un writer y permisos sintéticos únicamente dentro de tests que escriben en stores temporales. B.2b.3 agrega un simulador temporal de store más recibos. Ese envelope prueba el modelo del simulador, no la persistencia de recibos en el repositorio real. La única garantía entre procesos probada contra el repositorio real es el rechazo de una segunda instancia mientras otra conserva su lock; no demuestra exclusión contra escritores no cooperantes.

## 2. Alternativa recomendada: Schema v5 en el mismo archivo JSON

Recomiendo extender el store actual con una colección dedicada y estrictamente validada, por ejemplo `automatic_operations`, y subir la versión a 5. Cada commit de ADD/REPLACE incluiría el recibo y todos los cambios de assertion/source/evidence en el mismo estado candidato, una sola revisión y un solo rename.

Esta opción conserva el patrón actual de Nexa —un store local por usuario, repositorio JSON, validación completa y cambios de tamaño moderado— y evita coordinar dos fuentes de verdad. Los recibos deben estar separados de `migrations` y de las assertions: son metadatos operativos, no hechos sobre el usuario.

El incremento de versión es necesario: v4 valida una forma exacta y no permite agregar una colección de forma compatible sin cambiar el schema. No se propone modificación en esta etapa.

## 3. Modelo mínimo de recibo

Forma conceptual propuesta:

```json
{
  "operation_key": "<sha256>",
  "operation_fingerprint_sha256": "<sha256>",
  "operation_kind": "ADD",
  "status": "applied",
  "authorization_request_id": "req_<opaque-id>",
  "expected_revision": 12,
  "expected_digest": "<sha256>",
  "result_revision": 13,
  "result_assertion_id": "mem_<uuid>",
  "target_assertion_id": null,
  "result_code": null,
  "recorded_at": "2037-05-06T07:08:09.000Z"
}
```

Campos e invariantes sugeridos:

- `operation_key`: hash determinista, único en la colección y derivado por código confiable de la operación exacta. No es autorización.
- `operation_fingerprint_sha256`: fingerprint canónico independiente para detectar que una clave existente se presenta con otro contenido.
- `operation_kind`: únicamente `ADD` o `REPLACE`.
- `status`: `applied` o `rejected_terminal`. Una respuesta incierta no se escribe como si fuera un hecho conocido; ver la sección de reconciliación.
- `authorization_request_id`: correlación opaca generada por el runtime confiable. No es un token ni permite reautorizar.
- `expected_revision` y `expected_digest`: snapshot contra el que se validó la operación.
- `result_revision`: revisión confirmada; para `applied` debe ser la nueva revisión del mismo commit.
- `result_assertion_id`: ID persistido de resultado; `null` para un rechazo terminal.
- `target_assertion_id`: `null` en ADD; en REPLACE, el ID exacto supersedido y autorizado.
- `result_code`: solo códigos de una lista segura, sin mensajes de error del sistema, paths ni texto del usuario.
- `recorded_at`: timestamp validado.

La validación v5 debe imponer unicidad por `operation_key`, formato de digests/IDs, combinación permitida de campos por status, referencias al resultado y coherencia de revisión. Un recibo `applied` de REPLACE debe referir exactamente al target y al assertion resultante; la validación del store debe seguir garantizando la cadena de supersession.

No almacenar texto de conversación, evidence quote completa, valores candidatos duplicados, secretos, contenido rechazado, stack traces, tokens de autorización, capacidades, MACs, claves secretas ni claims del modelo como provenance verificada. Los digests no son cifrado y pueden ser adivinados si el contenido tiene poca entropía; solo deben guardarse los mínimos necesarios y no exponerse en logs. El archivo completo ya contiene aserciones persistidas; un recibo no debe replicar esos valores.

El store es por propietario local. No hace falta copiar nombres de Self ni declarar que el ID de Self autentica a una persona. El ID del intento solo correlaciona auditoría; no debe incluir la capacidad opaca ni usarse como identidad.

## 4. Semántica de idempotencia y estados

La clave B.2a debe verificarse y recomputarse; no se acepta la clave enviada por un modelo o caller como autoridad. El fingerprint canónico debe incluir como mínimo tipo de operación, versión de contrato/policy, candidato normalizado, hashes de origen/evidencia necesarios, sujeto resuelto, target exacto para REPLACE y revisión/digest del snapshot. Si se modifica cualquiera de esos elementos, la operación es distinta.

| Situación | Resultado | Recibo persistente | Reintento |
| --- | --- | --- | --- |
| Primera operación admitida y commit válido | `applied` | Sí, junto a los cambios de memoria | — |
| Repetición con misma clave y mismo fingerprint | Devuelve resultado previo, sin segunda mutación | Ya existe | Requiere la misma clave/fingerprint y una solicitud confiable vigente para consultar/recuperar el resultado; nunca reutiliza un grant consumido |
| Misma clave con fingerprint distinto | `idempotency_key_reused`, fail closed | No se altera el recibo previo | No se ejecuta |
| Rechazo antes de entrar al ejecutor (policy, contenido no elegible, autorización ausente, confirmación faltante) | Rechazo terminal de esa solicitud | No; no se escribe por una solicitud no autorizada | Puede reevaluarse como solicitud nueva; para ejecutar se requiere una autorización nueva y válida. La autorización por sí sola no cambia la policy |
| Conflicto de lock, revisión o digest | `conflict` recuperable | No | Obtener snapshot nuevo, recalcular el plan y pedir autorización/confirmación nueva |
| Fallo comprobado antes del rename | `not_applied`/error recuperable | No | Solo con una autorización vigente nueva y después de verificar el estado |
| Rechazo terminal después de una operación admitida y autorizada | `rejected_terminal` | Solo si el resultado y su recibo pueden persistirse atómicamente y el intento estaba autorizado para esa operación | La misma clave no se reabre; corregir datos/policy produce otra fingerprint |
| Respuesta perdida pero recibo `applied` visible tras reabrir | `applied`/duplicado | Sí | Devuelve resultado, no muta |
| No puede determinarse qué bytes quedaron | `unknown` | No se inventa ni se escribe un recibo `unknown` | Cerrar, reabrir y reconciliar; nada de reintentos ciegos |

La última fila es deliberada: con un rename de un único archivo, el programa que perdió el acceso no puede saber si el nombre apunta al estado anterior o al candidato. Si el archivo reabierto valida y contiene el recibo `applied` con fingerprint coincidente, la operación se confirmó. Si valida exactamente el estado anterior y no hay recibo, no se aplicó; hace falta una autorización actual antes de intentar de nuevo. Si aparece otro estado, una referencia rota, corrupción o un recibo contradictorio, se detiene para intervención manual.

La recuperación automática después de reiniciar solo es posible si el caller conserva la clave, fingerprint y binding originales (sin conservar la capacidad) y vuelve a presentar una solicitud confiable vigente. Si esa correlación no sobrevivió al proceso, no se debe fabricar a partir de datos del modelo: se procesa la nueva entrada como solicitud nueva y el planificador comprueba duplicados contra el snapshot actual. B.2b.1b no ofrece un request ID persistente ni un coordinador de reintentos; esa pieza todavía debe diseñarse para cualquier cliente que necesite reintentos transparentes entre procesos.

El simulador B.2b.3 también ejercita un estado `unknown` persistido artificialmente. Eso es un caso de modelo, no una regla del repositorio real ni una propuesta de v5: el sistema real no debe afirmar que persistió `unknown` cuando no pudo verificar el commit.

### Nueva autorización después de un rechazo

Un rechazo por autorización ausente, inválida o denegada no concede permiso para reintentar ni genera recibo. La misma operación solo puede volver a intentarse después de obtener y verificar una autorización nueva, auténtica y válida para ese efecto; una solicitud nueva no hereda la autorización anterior. Si una autorización se consumió y el commit falló antes de confirmarse, no se reutiliza: se requiere una autorización nueva, sujeta a la revisión/digest actuales. Un conflicto de snapshot obliga a planificar de nuevo, lo que normalmente genera otra clave.

Esto es distinto de repetir una operación ya aplicada: si coinciden la clave y el fingerprint de un recibo `applied`, el repositorio devuelve el resultado previo y no ejecuta otra mutación. Una autorización nueva no reabre ni vuelve a ejecutar ese efecto aplicado. Si la clave coincide pero el fingerprint difiere, el intento se rechaza cerrado.

Un rechazo terminal duradero bloquea esa clave. Una autorización posterior no lo borra ni lo convierte en `applied`; debe cambiar la operación o el estado de policy, lo que cambia el fingerprint. Si el producto necesita corregir un rechazo sin cambiar el efecto, hay que definir un modelo explícito de intentos/versiones antes de implementar. No se propone un flag para reabrir recibos.

## 5. Protocolo transaccional v5

```text
validar entrada y plan exactos
  → verificar autorización auténtica, de un solo uso, y confirmación exacta si REPLACE
  → abrir repositorio y adquirir lock exclusivo
  → validar estado actual y buscar operation_key
  → comprobar fingerprint y revisión/digest reales
  → recalcular policy, duplicados y target sobre el snapshot actual
  → construir clone completo: assertions + sources + evidence + receipt
  → incrementar una sola revisión y validar todas las invariantes v5
  → escribir temporal exclusivo en el mismo directorio y sincronizarlo
  → verificar ownership y estado observado antes del reemplazo
  → rename del único archivo y sincronizar directorio donde sea portable
  → releer y validar receipt + resultado; solo entonces devolver éxito
```

La entrada al repositorio debe ser un conjunto de cambios tipados que incluya `automatic_operations`. La unicidad y el fingerprint se comprueban dentro del lock usando el estado actual, no solo en el planner. Si ya existe un recibo, la decisión de duplicado/rechazo ocurre antes de construir un segundo efecto. Si cambia el snapshot, el plan anterior no se rebasea.

Todo cambio de assertion, supersession, source, evidence y recibo aplicado debe formar un solo candidato y una sola revisión. No se debe escribir primero la memoria y después el recibo. Para un rechazo terminal persistido, el recibo por sí solo sería un commit nuevo validado; no se mezcla con un efecto que se haya rechazado.

El modelo operativo requerido es un escritor a través del repositorio oficial, con su protocolo de lock. El lock coordina instancias que respetan ese protocolo. Los escritores externos que lo ignoran no se pueden excluir de forma portable con JSON y rename: la relectura justo antes de rename reduce la ventana, pero no constituye compare-and-swap del sistema de archivos y no los protege. El diseño operativo debe impedir que tales escritores modifiquen el store mientras Nexa lo mantiene abierto. Si se requiere concurrencia frente a cualquier escritor externo, esta arquitectura no cumple ese requisito; considerar SQLite o un servicio transaccional.

Para durabilidad, mantener temporal y destino en el mismo filesystem, modo de creación exclusivo y permisos restrictivos, sincronizar el temporal antes del rename y sincronizar el directorio si la plataforma lo admite. Si el sync de directorio no está soportado, registrar que la durabilidad ante pérdida abrupta de energía depende del filesystem/OS. No prometer durabilidad universal.

## 6. Recuperación y reconciliación

Cuando el repositorio devuelve `memory_commit_uncertain`:

1. Bloquear nuevos writes y cerrar esa instancia; no conservar su snapshot en memoria.
2. Reabrir con lock exclusivo y validar sintaxis, versión, schema, enlaces de evidencia, IDs, revisions y supersession.
3. Buscar la clave y comparar fingerprint y target exactos.
4. Si existe `applied` y el resultado coincide, devolver el resultado existente sin mutar.
5. Si no existe recibo y el archivo coincide exactamente con el digest/revisión previos, declarar `not_applied`; una nueva autorización puede iniciar otro intento.
6. Si el estado es distinto, corrupto o semánticamente incoherente, detener escrituras y solicitar inspección/backup. No reparar por inferencia ni volver a Memory1 como fallback.

Un archivo temporal abandonado nunca se promueve automáticamente: no hay prueba de que fuera el último candidato confirmado. La primera versión puede dejarlo en cuarentena e informar de manera segura; la limpieza requiere lock exclusivo, validación del destino y una regla de nombre/edad que no borre archivos ajenos. La corrupción del store o del recibo es fail-closed. La restauración de backup debe ser una operación offline revisada, no un fallback silencioso.

## 7. Diseño del ejecutor interno

El ejecutor debe ser privado al subsistema de memoria y solo aparecer después de que la autorización real esté aprobada. Interfaces conceptuales, no APIs implementadas:

- **Planificador**: propone `ADD`, `REPLACE`, `ASK`, `DUPLICATE` o `IGNORE`; no concede permiso ni elige IDs confiables.
- **Validador**: vuelve a validar candidato, source/evidence, secret screening, Self/entidad, policy vigente, target exacto y snapshot.
- **Autorizador**: verifica una capacidad auténtica emitida por una frontera confiable, con propósito, destinatario, operación, fingerprint, scope, turno y snapshot ligados; consume en todo intento de uso.
- **Confirmador de REPLACE**: comprueba una segunda confirmación confiable, ligada al mismo operation key y al assertion ID exacto. Una confirmación genérica no basta.
- **Controlador de idempotencia**: calcula key/fingerprint con código confiable y decide resultado solo desde recibos persistidos bajo el lock.
- **Repositorio transaccional**: valida el lote completo y persiste aserción más recibo en una sola revisión.

No usar argumentos `force`, `skipAuthorization`, `trusted: true`, IDs de usuario del modelo ni `provenance` de caller. Los recibos registran correlación, no autentican.

B.2b.1b demuestra solo que una línea vino del `stdin` local de la sesión runtime y está ligada a un turno. Su `principalKind` no es una identidad humana autenticada y sus scopes son vacíos. El adapter consume la capacidad para assessment pero entrega claims que B.2b.1 todavía deniega. Una futura política podría usar la prueba como evidencia de origen para una solicitud explícita, pero el grant de escritura debe ser emitido por una capa confiable separada y vinculado a la operación; sesión local, Self/owner y autorización son conceptos distintos. Tools, modelo, Memory, imports y texto externo nunca pueden crear esa capacidad. REPLACE necesita además una confirmación confiable exacta.

## 8. Migración Schema v4 → v5

La migración de esquema es distinta de la migración de Memory1 a Memory2. No debe ejecutarse durante esta etapa ni sobre un store personal sin autorización futura.

Flujo propuesto para una futura actualización explícita:

1. Detener la aplicación y todos los escritores; obtener el lock del store.
2. Leer bytes v4, guardar digest y validar el store completo antes de tocarlo.
3. Crear backup byte a byte con creación exclusiva y permisos restrictivos; sincronizarlo y comprobar que su hash coincide con el origen.
4. Construir el store v5 copiando sin reinterpretar todas las colecciones existentes, IDs, Self, valores, temporalidad, provenance, relaciones, supersession y `revision`; añadir `automatic_operations: []`.
5. Incrementar `revision` una vez por el cambio de formato y actualizar `updated_at`, invalidadando snapshots anteriores.
6. Validar el candidato v5 completo; escribir a temporal exclusivo, sincronizar, verificar lock y digest origen, renombrar y releer.
7. Si el fallo ocurre antes del rename, conservar v4 intacto. Si el resultado del rename es incierto, reabrir y clasificar por versión, revision, digest y validez. No migrar ni inicializar Memory1 como fallback.

La operación es idempotente: un store v5 válido no recibe otra colección ni otra revisión al reabrirse. Una versión antigua que no entiende v5 debe fallar de forma explícita; no pueden operar simultáneamente versiones v4 y v5 contra el mismo archivo. La app debe aplicar una migración versionada antes de abrir el repositorio v5, no hacer auto-upgrade en un getter o startup implícito.

El backup v4 permite rollback offline únicamente antes de que v5 acepte writes. Después de cualquier write v5, restaurar bytes v4 perdería esos cambios; en ese punto la preferencia es reparar/roll-forward. La revisión v5 debe documentar que una restauración de backup revierte el estado completo y solo se acepta con procesos detenidos y verificación explícita. Fixtures sintéticos deben cubrir v4 vacío y poblado, v4 con relaciones/historial, repetición, fallo de backup, fallo antes/después del rename, v5 corrupto y restauración sin writes v5.

## 9. Comparación de alternativas

| Alternativa | Ventajas | Costes y riesgos | Evaluación para Nexa ahora |
| --- | --- | --- | --- |
| **A. JSON único con Schema v5** | Una fuente de verdad; assertion y recibo en un solo rename; reutiliza el repositorio, schema y patrón de snapshots existentes; sin dependencia nueva | Reescribe el archivo completo; lock solo para participantes cooperantes; temporales/locks requieren recuperación; durabilidad varía por filesystem; colección crece | **Recomendada** para store local pequeño y un proceso escritor coordinado |
| **B. Sidecar de recibos** | Mantiene intacto el formato principal a corto plazo; registro separado puede ser compacto/append-only | Dos archivos no comparten rename atómico; exige WAL/protocolo prepare/commit, replay, reconciliación y compaction; puede quedar memoria y recibo desincronizados; más superficie de fallos | **No recomendada** salvo que exista un WAL probado; dos archivos recrean justo el problema de consistencia |
| **C. SQLite** | Transacciones y constraints únicas para memoria+recibos; locking y recuperación del motor; consultas indexadas al crecer | Nueva capa/dependencia o runtime; migración/importación y backup propios; cambia repositorio y diagnóstico; concurrencia sigue limitada por modo/FS; no integra mágicamente writers externos | **No elegir ahora** por escala actual; reevaluar con múltiples escritores, crecimiento o necesidad de consultas/transacciones más ricas |

La opción C es técnicamente válida, pero introducirla ahora para una sola colección de recibos ampliaría el cambio y la migración sin evidencia de que JSON haya alcanzado su límite. Si el requerimiento real incluye procesos externos no cooperantes, debe revisarse la arquitectura completa: SQLite puede ayudar si todos usan la DB y no editan sus bytes directamente.

## 10. Riesgos y decisiones pendientes

- **Retención**: borrar un recibo aplicado por antigüedad puede hacer que una repetición parezca nueva. La primera versión conserva recibos aplicados sin TTL. No se eliminarán por edad hasta definir e implementar un mecanismo que preserve la detección de reintentos antiguos (por ejemplo, tombstones o una regla de expiración verificable que falle cerrada); revision/digest por sí solos no sustituyen esa garantía.
- **Rechazo terminal**: definir qué rechazos, si alguno, justifican persistir un receipt-only commit y bajo qué scope. Un rechazo por falta de autorización o policy antes del executor no debe generar escritura ni recibo.
- **Reautorización**: definir cómo una nueva petición confiable tras fallo precommit se liga a la misma operación y consume un grant nuevo. No reutilizar capability; conservar key solo si fingerprint y snapshot siguen idénticos.
- **Unknown**: receipt `applied` prueba commit; la respuesta `unknown` vive fuera del store hasta reconciliar. Si el estado no permite prueba, la decisión es intervención manual.
- **Hash y privacidad**: SHA-256 es integridad/correlación, no secreto. No guardar material fuente; valorar HMAC solo si se aprueba cómo gestionar clave por store, backup y restauración.
- **Escritores externos**: no existe CAS universal del archivo JSON entre la última lectura y rename. La regla operativa requiere que las escrituras pasen por el repositorio oficial y su lock; escritores externos que ignoren el lock no están protegidos.
- **Durabilidad y backups**: definir OS/filesystems soportados y política de backup antes de afirmar protección frente a cortes de energía.
- **Borrado**: decidir qué pasa con recibos al hacer forget de una assertion. No deberían retener texto ya olvidado; puede conservarse el recibo mínimo/hashes durante su periodo de idempotencia, o una tombstone compacta.
- **Compatibilidad**: v4 no entiende v5. Actualización y downgrade deben ser explícitos y mutuamente excluyentes.
- **Autorización**: el contrato actual nunca concede permisos. El schema v5 por sí solo no habilita ejecutar.

## 11. Plan de implementación futuro

1. Aprobar campos de recibo, estados, expiración/retención, reglas para rechazos y reautorización.
2. Añadir Schema v5 y validadores puros con fixtures sintéticos; seguir sin writer automático.
3. Diseñar y probar el migrador v4→v5 offline, backup y fallo/reconciliación; mantener Memory2 personal desactivada.
4. Extender el repositorio con operación tipada que incluya recibo y cambios en una transacción; añadir pruebas de lock, stale snapshot, crash points y re-open.
5. Aprobar por separado el emisor/verificador de autorización y confirmación de REPLACE; no cambiar B.2b.1 de forma implícita.
6. Implementar un ejecutor interno inaccesible al modelo, inicialmente bajo tests y feature gate cerrado; probar ausencia de rutas alternativas.
7. Revisar seguridad, recuperación y rollback con stores ficticios antes de considerar cualquier activación. La activación personal requiere una aprobación futura independiente.

Complejidad estimada: **moderada-alta**, dividida en varios cambios pequeños. El schema y migrador son acotados; el núcleo delicado es alinear autenticidad de autorización, replay, commit atómico y resultado incierto sin crear bypass ni degradar la frontera de runtime.

## 12. Recomendación y aprobación solicitada

Recomiendo **Schema v5 con una colección dedicada de operation receipts dentro del mismo archivo JSON**, transaccionada con cada cambio de memoria mediante el repositorio actual. Mantener los recibos compactos, aplicar un solo commit/revision, bloquear escritores externos mientras el repositorio está abierto y fallar cerrado ante estado incierto. No usar un sidecar sin WAL y no migrar a SQLite hasta que el crecimiento o la concurrencia real lo justifique.

Antes de implementar, solicito revisar y decidir:

1. Nombre de colección y campos exactos del recibo.
2. Si se acepta guardar rechazos terminales autorizados o solo operaciones aplicadas.
3. Retención inicial sin TTL y política de borrado/forget.
4. Comportamiento de reautorización para una misma fingerprint después de fallo o rechazo.
5. Requisito operativo de único writer cooperante y filesystems soportados.
6. Política de backup/rollback y momento de actualización v4→v5.

Esta fase termina en el diseño. No se ejecutó ninguna migración ni se cambió schema, repositorio, agente, dependencia o memoria personal. No se hizo commit ni push.
