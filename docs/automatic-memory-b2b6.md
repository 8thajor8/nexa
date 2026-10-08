# Automatic Memory B.2b.6 — Diseño de autorización confiable de un solo uso

## Estado y alcance

Esta entrega es únicamente un diseño basado en el repositorio en `8b36d96575fa50b0c955edf229c6f142b87cba13`. No añade código, rutas de escritura, grants, persistencia de autorizaciones ni integración con el agente. Memory 2 sigue sin activarse para uso personal; la migración v4→v5 sigue siendo explícita y no se ejecuta aquí.

La decisión central es usar un **coordinador confiable de dos etapas que emite capacidades opacas de corta vida**. El coordinador prepara una operación inmutable, la presenta directamente al usuario y solo emite una capacidad después de recibir la confirmación por una entrada confiable. Para REPLACE, el paso de confirmación debe ser distinto y ligado al destino exacto. Los recibos v5 registran resultados de operaciones; no son grants, tickets de autorización ni prueba de identidad.

## Estado real inspeccionado

- B.2a calcula una clave determinista de operación, pero la marca como no registrada y deja `executable`, `writeReady` y `committed` en `false`. El contrato no depende del repositorio ni del autorizador.
- B.2b.1 compara claims con la operación, pero trata esos claims como datos ordinarios: declara principal y turno no autenticados, no concede scopes y deja `authorization.granted`, `authorizationRequestEligible` y `executable` en `false`. No hay verificador de grant ni ledger durable de consumo.
- B.2b.1b tiene una frontera estrecha en `direct-user-input.js`: el módulo lee directamente de `process.stdin`; un `WeakMap` privado reconoce la capacidad; la prueba está ligada al destinatario, sesión runtime, turno, propósito y SHA-256 del texto original. Se consume en el primer intento de verificación, incluso si fallan texto o destinatario; el siguiente turno, EOF y cierre la invalidan. `principalKind` es `local_runtime_session`, y los scopes son vacíos. Esto prueba entrada local de un proceso, no quién es la persona frente al terminal ni quién controla el sistema operativo.
- El adapter B.2b.1b usa esa prueba solo para assessment. No convierte el origen en scope ni en permiso. El agente usa `readDirectUserTurn` para recibir turnos de entrada; no hay una vía de persistencia de Automatic Memory conectada al agente.
- B.2b.2 y B.2b.3 prueban writer, permisos, confirmaciones, recibos, reintentos y concurrencia exclusivamente en tests/simuladores temporales. No son permisos ni garantías ejecutables del producto.
- Schema v5 valida `automatic_operations` con clave/fingerprint, `authorization_request_id`, kind, estado, revisión/digest esperados y resultado. Los recibos son append-only en el repositorio. El schema verifica forma, unicidad, referencias y coherencia estructural; no puede demostrar que una autorización fue auténtica ni recomputar el fingerprint a partir del plan que deliberadamente no almacena.
- El repositorio JSON ya coordina escritores cooperantes mediante lock, valida revisión/digest, arma un store candidato completo y publica cambios mediante reemplazo del archivo. El recibo y las mutaciones futuras deben formar parte del mismo commit. El lock no protege frente a escritores externos que lo ignoren y el repositorio no promete durabilidad universal ante pérdida de energía.
- `MemoryService.remember()` está diseñado para el comando explícito existente y puede superseder por slot. No equivale al ADD append-only requerido por Automatic Memory. No debe reutilizarse como una vía automática sin una API transaccional separada y revisada.

Por lo tanto hoy faltan: confirmación confiable de una operación mostrada, emisión de autorización automática, autorización ligada a usuario autenticado (no disponible en CLI), consumo durable coordinado con el commit, y protocolo de reconciliación entre consumo y persistencia. Ningún valor del modelo, memoria, herramienta, importación o caller rellena esos vacíos.

## Modelo de confianza y actores

1. **Límite de entrada confiable**: el adaptador que lee la entrada local directamente desde stdin. Atestigua únicamente que bytes concretos llegaron por ese canal a este proceso. No certifica identidad humana, autenticación del sistema operativo ni entrada remota.
2. **Detector/modelo**: propone estructura y evidencia. Todo campo que produzca es no confiable: persona, predicate, sujeto, IDs, confidence, intención, autorización, confirmación y provenance. No puede acuñar tokens ni alterar una solicitud pendiente.
3. **Planificador/validador**: normaliza de nuevo la propuesta, ejecuta policy/secret screening y resuelve entidad y target contra un snapshot. Emite un plan canónico inmutable o `ASK`/`IGNORE`; no emite autoridad.
4. **Coordinador confiable**: conserva el plan pendiente fuera del contexto del modelo, lo presenta en UI de confianza y relaciona la respuesta directa del usuario con ese plan. Es el único componente autorizado a pedir al issuer una capacidad de operación.
5. **Issuer/verificador privado**: emite una capacidad opaca en un `WeakMap` o mecanismo privado equivalente y verifica su propósito, destinatario, sesión/turno, plan, snapshot, vigencia y consumo. No exporta una función pública que permita a cualquier caller fabricar capabilities.
6. **Ejecutor/repositorio**: recomputa y valida el plan y el fingerprint; verifica y consume la capacidad bajo el protocolo definido, mantiene lock/revisión/digest, y persiste cambios y recibo en una única revisión.
7. **Store v5**: conserva hechos y recibos estructurales. El `authorization_request_id` es correlación opaca, no identidad, prueba, token ni permiso recuperable.

La sesión del CLI nunca se llama “usuario autenticado”. Si en el futuro se añade transporte remoto, hará falta una frontera independiente autenticada; no se debe reutilizar `local_cli` o un session ID como prueba remota.

## Opción arquitectónica

| Opción | Ventajas | Riesgos y trabajo faltante |
| --- | --- | --- |
| **A. Capability opaca del runtime** | Encaja con la capability de turno actual; no serializable; verificación exacta y consumo inmediato; el modelo no puede fabricar un objeto válido. | Por sí sola no confirma que el usuario vio el plan; se pierde al reiniciar; el fallo tras consumo requiere reautorización; no resuelve el desacople de commit y consumo. El stdin actual solo sirve para assessment y carece de grants. |
| **B. Autorización persistente verificable** | Sobrevive a reinicios; permite recuperar el estado de solicitudes pendientes y consumo; se puede auditar. | Requiere nueva colección/schema o semántica de recibos para estados `pending/consumed`; retención y limpieza; serialización firmada/MAC protegida; gestión de claves; replay, revocación y atomicidad distribuidos con el commit. El MAC en sí no prueba que hubo confirmación humana. Excesivo para el CLI local actual. |
| **C. Coordinador confiable en dos etapas** | Une el plan exacto, presentación al usuario, confirmación y emisión; mantiene al modelo fuera del flujo de aprobación; limita la autorización al mínimo. Puede usar capabilities A y dejar al repositorio como autoridad de resultado durable. | Requiere nueva UI/lector de confirmación no controlado por el modelo, issuer privado, máquina de estados y una política explícita de fallos. Si el proceso cae, se pierde la solicitud pendiente y se vuelve a confirmar; no hay identidad humana autenticada. |

**Recomendación: C implementada con capabilities opacas efímeras de A; no adoptar B en esta etapa.** Es el modelo más pequeño que satisface una aprobación por operación sin crear una segunda base durable de permisos. Una capacidad vale solo dentro del proceso/sesión, para una operación, snapshot, destinatario y propósito concretos. El receipt de v5 es el único registro durable del resultado confirmado. Una futura exigencia de recuperar aprobaciones pendientes tras reinicio justificaría diseñar B expresamente; no debe añadirse una autorización persistente improvisada a `automatic_operations`.

## Canonicalización y vínculo

Antes de pedir aprobación, código confiable debe producir un plan canónico cerrado, versionado e inmutable. El fingerprint se calcula con serialización canónica y SHA-256 e incluye, como mínimo:

- versión del contrato, schema y policy efectiva;
- kind `ADD` o `REPLACE`, contenido normalizado y sujeto/persona resuelta;
- hashes del texto de origen y evidencia exacta relevante, sin duplicar el texto en el receipt;
- identidad del source/provenance derivada por código, sin convertir inferencia en afirmación explícita;
- target exacto de REPLACE o `null` para ADD;
- revision y digest del snapshot esperado;
- destinatario runtime, identificador opaco de solicitud y turno de origen.

El modelo no elige operation key, fingerprint, IDs de entidad o assertion, request ID, scopes, principal ni provenance fiable. Cualquier modificación del plan, evidencia, target, política o snapshot crea otro fingerprint y obliga a volver a presentar y aprobar la operación. El hash no es autorización ni protección contra un atacante que controla el proceso; su finalidad es vinculación e integridad dentro del protocolo.

La capability no se representa como JSON, string, boolean, enum ni claims. La verificación busca identidad de objeto en estado privado del issuer y consume la capability ante cualquier intento, incluido destinatario incorrecto, fingerprint distinto, operación alterada o snapshot obsoleto. No se imprime, serializa, registra ni pasa al modelo/herramientas. El API de verificación no debe ser una utilidad genérica que acepte `trusted: true` o `sessionId` como sustitutos.

## Flujo de autorización de dos etapas

1. **Entrada y propuesta**: el usuario envía texto por el canal de entrada. El detector puede proponer un candidato, pero su salida no autoriza nada. El sistema conserva por separado el original confiable y el resultado no confiable.
2. **Plan**: el planificador normaliza, filtra secretos, resuelve Self/terceros conservadoramente, compara contra el snapshot y propone `ADD`, `REPLACE`, `ASK`, `DUPLICATE` o `IGNORE`. Conflicto, ambigüedad o evidencia insuficiente no producen capability.
3. **Vista previa**: el coordinador confiable renderiza directamente (no mediante una respuesta generada por modelo) qué se agregaría o reemplazaría, el sujeto, la fuente inferida y el resultado práctico. No muestra secretos ni más contenido previo del necesario. El plan queda pendiente en estado privado e inmutable.
4. **Confirmación directa**: el usuario confirma mediante una acción del canal confiable del coordinador, identificada por el pending request seleccionado. Una respuesta del modelo como “sí”, una cita, un tool result, texto recuperado de memoria o una cadena de confirmación dentro del turno original no cuenta. La confirmación no se interpreta desde el chat del modelo; el runtime la captura como evento distinto, enlazado al request activo. Un simple `sessionId` o mensaje que repite un token visible no basta.
5. **REPLACE**: se presenta el assertion exacto que se marcará como superseded y el nuevo valor. El usuario realiza una acción de confirmación explícita separada, que referencia el fingerprint y target exactos. Si el target cambia, el UI no puede enseñar el target anterior, o la entrada no queda ligada inequívocamente a la confirmación pendiente, se cancela y se solicita aprobación nueva. Esta separación evita que un “sí” dirigido a una pregunta anterior autorice un reemplazo distinto.
6. **Emisión**: después de confirmar, el coordinador pide al issuer privado una capability limitada a `memory.automatic.add` o `memory.automatic.replace`, una operación, un fingerprint, un snapshot, un destinatario, la solicitud/turno pendiente y una expiración corta. REPLACE también requiere la capability de confirmación exacta. La emisión y almacenamiento del pending plan son código confiable, no campos del modelo.
7. **Commit**: el ejecutor vuelve a validar secret screening, elegibilidad, entidades, target y fingerprint; adquiere el lock; comprueba el snapshot actual; busca primero un receipt coincidente; verifica/consume la capability y confirma el reemplazo exacto; construye assertion/source/evidence y receipt en el mismo candidato y revisión. No hace rebase. Éxito solo después de releer/validar el resultado.
8. **Respuesta**: se informa resultado confirmado, conflicto, rechazo o estado incierto. El texto del modelo no puede cambiar el resultado que devolvió el repositorio.

En el CLI disponible, la entrada directa por stdin demuestra origen de la línea, pero no existe hoy un evento de confirmación separado ni una UI de aprobación. Un prompt nuevo leído de stdin sería una futura extensión explícita del runtime, no algo que se deduce de los turnos actuales ni de una capability de assessment. El coordinador debe impedir que el modelo genere el texto que el lector interpreta como autorización.

## Reglas de ADD y REPLACE

**ADD** solo añade una assertion nueva y evidencia derivada; no supersede ninguna existente. Requiere decisión `ADD` del planificador y una confirmación ligada al fingerprint/snapshot antes de recibir `memory.automatic.add`. Si ya es duplicado, no escribe. Si aparece un conflicto en el snapshot actual, se detiene y vuelve a `ASK` o planificación nueva.

**REPLACE** exige un target único, activo, del sujeto y predicate esperados y referenciado por el plan; conserva historial y solo marca ese target como superseded. Siempre requiere confirmación directa separada que indique claramente el cambio. No basta la aprobación genérica de Automatic Memory, una autorización ADD ni una confirmación a nivel de turno. Una corrección en el texto original puede aportar evidencia, pero no sustituye la confirmación exacta del efecto.

Terceros, Self no resuelto, proyecto `textual_only`, candidato ambiguo, dato sensible no confirmado y contenido citado/importado no ganan una capability por ser candidatos válidos. Los cambios de entidad canónica quedan fuera de estas operaciones.

## Estados y transiciones

El estado de aprobación vive en el coordinador privado y no se añade al schema v5 en esta propuesta:

| Estado | Significado | Transiciones permitidas |
| --- | --- | --- |
| `proposed` | Candidato no confiable aún no validado | `planned`, `ask`, `ignored` |
| `planned` | Operación canónica, no mutable, con snapshot y fingerprint | `awaiting_confirmation`, `stale`, `cancelled` |
| `awaiting_confirmation` | Vista previa presentada por coordinador confiable; no hay permiso aún | `confirmed`, `denied`, `expired`, `cancelled`, `stale` |
| `confirmed` | Evento de entrada confiable confirmó el fingerprint exacto | `capability_issued` o `cancelled` |
| `capability_issued` | Existe permiso opaco limitado y no consumido | `consumed`, `expired`, `cancelled` |
| `consumed` | Primer intento de verificación lo quemó; no puede repetirse | `applied`, `not_applied`, `unknown`, `rejected` |
| `applied` | Receipt v5 y operación se verificaron en la misma revisión | Estado terminal; respuesta/replay sin segunda mutación |
| `not_applied` | Verificación concluye que el store previo sigue intacto y no hay receipt | Nueva aprobación y capability necesarias para reintentar |
| `unknown` | No puede determinarse el resultado tras fallo/rename incierto | Bloquear escritura; reconciliar offline/mediante reapertura bajo lock |
| `denied` / `expired` / `cancelled` / `stale` / `rejected` | No se ejecuta la operación aprobada | Terminal para ese request; una propuesta nueva vuelve a planificar |

No se persiste un estado `unknown` por afirmar un hecho que no se sabe. La tabla es una máquina de estados de diseño, no una afirmación de que esos estados existan en código.

## Consumo, reintentos e idempotencia

- La capability se consume en el primer intento de verificación del ejecutor, antes de ramificar por mismatch. Así no se permite tantear fingerprints, destinatarios, scopes ni snapshots con el mismo token.
- Una capability consumida no se recupera, incluso si falla la validación, el lock, el snapshot, la serialización o la persistencia. Si se demuestra `not_applied`, el coordinador vuelve a planificar con snapshot actual y exige nueva aprobación/capability. Esto puede pedir confirmación otra vez; es el costo simple y seguro de capabilities no persistentes.
- Un receipt `applied` con operation key y fingerprint idénticos prueba que el efecto ya se confirmó, no que una capability pueda usarse de nuevo. Una reconsulta/reintento de respuesta debe ser solo lectura y nunca volver a mutar. El resultado solo se devuelve dentro de una sesión/destinatario autorizado a leer ese store; la autorización de lectura del producto es una decisión separada.
- Misma key con fingerprint distinto: fail closed y no modificar receipt. Mismo fingerprint aplicado: devolver/reconciliar resultado anterior, no ejecutar ADD/REPLACE otra vez. La clave determinista nunca crea autoridad.
- Rechazo de autorización no genera receipt de operación ni permite reintentar con la misma capacidad. Un intento posterior necesita una nueva confirmación confiable. Si existe un receipt terminal, no se borra ni se “reabre”: un nuevo plan/intent debe tener identidad definida por la política y no eludir la unicidad/fingerprint.
- Snapshot obsoleto, revision/digest distintos o target de REPLACE cambiado: quemar capacidad, no rebasear. Recargar, volver a planificar y mostrar de nuevo la vista previa antes de pedir una autorización nueva.
- Dos operaciones concurrentes: ambas pueden llegar a confirmación, pero solo una que conserve el snapshot esperado puede pasar la comprobación bajo lock. La segunda falla por conflicto, consume su permiso y debe volver a planificar. Nunca se autorizan los bytes/resultados de una operación antes de conocer el plan que se presentará.
- Reinicio antes del commit: se pierden capabilities y requests pendientes; no se restauran de texto/logs. Nueva entrada y confirmación. Reinicio después del commit y antes de responder: reabrir bajo lock y buscar receipt exacto; si está aplicado, informar el resultado sin volver a aplicar. Si no puede probarse, tratar como `unknown` y no reintentar automáticamente.

## Recuperación ante fallos

El repositorio ya tiene manejo de errores antes/después del rename y puede marcar su instancia incierta. El futuro coordinador debe usarlo así:

1. **Fallo antes de iniciar escritura** (policy, autorización ausente, target inválido): ninguna mutación; capability consumida si ya comenzó la verificación; no receipt de ADD/REPLACE. Cualquier nuevo intento requiere un plan vigente y una nueva confirmación.
2. **Fallo confirmado antes del rename**: verificar que revision/digest/bytes previos siguen iguales y que no hay receipt. Devolver `not_applied`; nunca restaurar ni reusar capability. Reautorizar un intento nuevo.
3. **Fallo tras rename o respuesta perdida**: cerrar la instancia incierta, reabrir con lock, validar el store y comparar operation key, fingerprint, revisión, assertion resultante y target. Receipt aplicado coherente significa `applied`; estado anterior exacto sin receipt significa `not_applied`; cualquier divergencia/corrupción significa `unknown`, bloquear escrituras e inspección. El receipt y el efecto deben estar en el mismo commit, por lo que no debe existir un estado válido con solo uno de ellos.
4. **Capacidad consumida y persistencia no confirmada**: no reponer ni serializar la capacidad. Solo una reconciliación que prueba `not_applied` puede iniciar una nueva autorización; si el resultado es incierto, no hay reintento hasta resolverlo.
5. **Caída del proceso**: una capability en `WeakMap` desaparece. La aprobación pendiente tampoco se reconstruye a partir de memoria conversacional. La operación confirmada se recupera por receipt; una no confirmada exige comenzar de nuevo.

Atomicidad del archivo, coordinación entre writers que respetan el lock y durabilidad frente a fallos físicos son garantías distintas. El protocolo no protege frente a writers externos que ignoran el lock y no promete persistencia universal ante corte de energía.

## Riesgos y decisiones pendientes

- **Identidad humana**: el CLI no autentica a una persona. La aprobación solo puede describirse como acción directa del dueño/controlador del canal local confiable, no como identidad verificada. Si el producto requiere atribución personal, se necesita autenticación del OS/cuenta o un servicio de identidad independiente.
- **Interfaz de confirmación**: debe decidirse si habrá un diálogo de terminal separado del chat/modelo, un UI nativo u otro canal. La API actual solo lee turnos normales de stdin y su capability tiene propósito `automatic_memory_assessment`; no debe reutilizarse sin cambio aprobado.
- **Qué se confirma en ADD**: definir si cada candidato requiere confirmación vista previa o si habrá una política de consentimiento persistente de mayor nivel. Este diseño recomienda aprobación por operación mientras no exista tal decisión; una preferencia general no debe convertirse implícitamente en grant ilimitado.
- **Confirmación REPLACE**: especificar el formato/gesto exacto, accesibilidad, cancelación, timeout y cómo se comprueba que el target presentado coincide byte a byte con el plan confirmado.
- **Secretos y datos sensibles**: la vista previa y los errores no deben repetir credenciales ni material de secretos. Decidir qué campos sensibles siempre requieren revisión adicional o se rechazan.
- **Identidad por intento**: B.2b.4/B.2b.5 definen receipts aplicados/rechazados, pero no completamente la distinción entre operación, intento autorizado, rechazo y nueva autorización para el mismo efecto. Definirlo antes de escribir receipts de rechazo o permitir nueva tentativa sin romper unicidad.
- **Replay entre procesos**: capabilities en memoria no sobreviven reinicio y el consumo no es una transacción con el archivo. El diseño evita reuso ciego con reautorización y receipt; no promete un ledger de autorizaciones durable. Si se exige “exactamente una ejecución” a través de caída, reexaminar opción B o un almacenamiento transaccional dedicado.
- **No cooperación del filesystem**: un editor externo puede modificar JSON ignorando lock. Operativamente debe impedirse, o se debe migrar a una base con control de concurrencia apropiado.
- **Abuso de código dentro del proceso**: WeakMap/capabilities protegen contra datos estructurados ordinarios, no contra ejecución arbitraria de JS en el mismo proceso ni control del OS. La frontera de proceso debe considerarse parte del perímetro.

## Plan de implementación por etapas

1. **B.2b.6 aprobación de diseño**: acordar el canal de confirmación, semántica de ADD, REPLACE exacto, estados/attempt IDs y límites de identidad local. No se implementa en este documento.
2. **Runtime boundary**: añadir una entrada de confirmación distinta, leída solo desde el canal confiable, enlazada a un pending request privado. Pruebas adversariales: modelo/tool/cita/importación, request equivocado, texto cambiado, turno vencido, reinicio, replay y sustitución de target. No grants de escritura todavía.
3. **Autorizador de una operación**: issuer/verificador privado que emite scopes ADD/REPLACE y confirmación REPLACE; capability opaca, vinculada a fingerprint+snapshot+turno+destinatario, un uso incluso ante errores. Mantener contratos existentes denegados hasta revisión de compatibilidad.
4. **Integración transaccional interna**: API privada no invocable por modelo/herramientas; recomputa el plan, consumes la capability bajo el lock, aplica ADD append-only o REPLACE exacto, y persiste operación+receipt en la misma revisión. Reconciliación explícita para resultado incierto. Sin integración con agente inicialmente.
5. **Validación aislada**: directorios temporales, fallos inyectados antes/después de rename, carreras con dos repositorios cooperantes, pérdida de respuesta, reinicios, receipts inconsistentes, snapshot stale, keys/fingerprints alterados, controles de no-escritura personal. Release review adversarial antes de exponer flujo alguno.
6. **Integración de producto por separado**: solo tras aprobar revisión, conectar una UI/coordinador a la frontera confiable. No activar Memory2 personal ni migrar datos como consecuencia implícita del desarrollo.

No se recomienda empezar el ejecutor hasta resolver las decisiones de canal de confirmación, alcance de ADD, identidad local, reintentos tras autorización consumida y semántica de attempt/receipt. Ninguna etapa convierte el modelo en autoridad.
