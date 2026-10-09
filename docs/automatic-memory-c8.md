# NEXA — C.8: auditoría integral y preparación

## Alcance y estado de partida

Esta auditoría cubre Automatic Memory A, B y C.1–C.7, además de los contratos de identidad, consentimiento, autorización y aislamiento relacionados. Inspecciona el código y las pruebas del repositorio en `da448d751dfdda1231e7e48b30ffe3c172dd299e` (C.7.3). No habilita aprendizaje ni escritura, no autentica a una persona y no afirma que los contratos hipotéticos sean controles de producción.

La precondición de publicación se verificó antes de editar: `HEAD`, `main` y `origin/main` estaban en `da448d751dfdda1231e7e48b30ffe3c172dd299e` y el árbol estaba limpio. La auditoría no modifica código de producción.

## Resumen ejecutivo

El repositorio contiene un extractor de candidatos real para OpenAI, filtros y política deterministas, integración de evaluación detrás de un interruptor apagado, contratos de planificación y confirmación, un coordinador B.2b y una transacción v5 que se prueban con almacenamiento temporal. También contiene pruebas integrales sintéticas de C.6 y C.7.

Estos elementos no forman hoy una ruta conversacional ejecutable de aprendizaje. `src/index.js` compone el detector, pero pasa `enableAutomaticMemoryAssessment: false`; el agente además rechaza habilitar el detector registrado como real. La opción de guardado automático siempre está desactivada. La evaluación no encola propuestas ni llama al writer. B.2b tiene un coordinador y un writer aislados, pero no existe conexión desde el resultado conversacional hacia ese escritor. Memory1 sigue siendo el backend efectivo.

Por tanto, C.8 no recomienda activar Automatic Memory ni Memory2. Antes de cualquier activación personal hacen falta autenticación y vínculo de Self verificables, consentimiento atribuible a una persona autenticada, una política de tratamiento/retención aprobada, estado autoritativo de propuestas y confirmaciones, y un flujo de autorización y persistencia integrado que revalide todo bajo revisión vigente.

## Mapa de componentes

| Etapa | Implementación observada | Garantías respaldadas por código/pruebas | Conexión y efectos actuales | Estado |
|---|---|---|---|---|
| A — detección y policy | `src/memory/automatic/detector.js`, `schema.js`, `policy.js`, `evaluation.js`; pruebas A y harness | El extractor devuelve candidatos estructurados, no autoridad; normalización valida campos y evidencia; policy usa vocabulario controlado, filtra secretos, citas, hipótesis, durabilidad, sensibilidad, Self y duplicados/conflictos con snapshot cuando se le proporciona. Pruebas mock no miden precisión del modelo real. | El adaptador OpenAI existe. El CLI no activa evaluación; una evaluación real solo ocurriría si alguien invoca deliberadamente el flujo habilitado. No se hizo ninguna llamada durante C.8. | Implementado; extracción real disponible, desactivada en runtime. La calidad del modelo no está demostrada por fixtures. |
| B.1–B.2a — plan y contrato | `planner.js`, `persistence-contract.js` y contratos asociados | ADD es aditivo; REPLACE requiere target y confirmación; operación, provenance y fingerprint se validan. Los contratos iniciales eran dry-run. | No los consume el agente para guardar automáticamente. | Contratos implementados; parte dry-run. |
| B.2b.1–B.2b.7 — confianza y autorización | `direct-user-input.js`, `authorization-coordinator.js`, contratos B.2b | Pruebas de stdin real en procesos hijos cubren capacidades opacas ligadas a sesión/turno/texto/destinatario; el coordinador consume una confirmación independiente y grant de un uso. La identidad de hablante y la autorización de escritura son pruebas distintas. | El proveedor de identidad de producción falla cerrado; el coordinador no está conectado al agente/tools. Las sesiones locales no prueban qué persona está ante el teclado. | Código real de frontera local y coordinador; autenticación humana y Self real pendientes; salida de escritura sigue cerrada. |
| B.2b.8–8c — writer y recuperación | `repository.js`, `json-repository.js`, Schema v5, pruebas de transacción | `commitAutomaticOperation()` verifica autorización, snapshot/recibo bajo lock cooperativo y publica assertion, evidencia, provenance y recibo en una revisión lógica. `commit()` genérico protege recibos automáticos. Tests con repositorios temporales prueban replay, fallos inyectados y carreras cooperativas. | No hay caller desde el agente ni tools; no se usa el store personal. La atomicidad es lógica por reemplazo de archivo; no prueba durabilidad física universal ni protege escritores que ignoren lock. | Writer real aislado y probado con fixtures; integración de producto pendiente. |
| C.1–C.2 — arquitectura y evaluación posterior al turno | `agent.js`, `index.js`, `direct-user-input.js` | Hook consume el turno directo original una sola vez, corre tras presentar respuesta, filtra texto de tool/model/retrieval y falla aislado. `run(text)` no equivale al límite confiable. | El hook está compuesto pero apagado en CLI; no añade llamada mientras está apagado. | Integración presente con interruptor apagado. |
| C.3–C.4 — consentimiento, privacidad y retención | `privacy.js`, `consent-store.js`, `local-json-ledger.js`, controles de agente | Consentimiento para analizar es distinto de permiso para guardar (`grantsMemoryWrite: false`). Revocación/exclusión invalida llamadas activas y controles; el boundary revalida consentimiento, exclusión y bandera tras la espera del extractor. Hay screening antes del envío y timeout/cancelación. | El consentimiento se guarda en un ledger JSON local entre sesiones; el esquema actual no fija expiración temporal. Es una elección local del CLI, no consentimiento autenticado de un principal verificado. La superficie real de consentimiento y su tratamiento operativo requieren revisión de privacidad. | Persistencia local y controles implementados; atribución humana, expiración/renovación aprobadas, privacidad multiusuario y política de retención pendientes. |
| C.5a–C.5e — extractor, calibración y privacidad | `detector.js`, `openai.js`, schema, screening, evaluación/documentación | Solicitud dedicada usa Structured Outputs, `tools: []`, `store: false`, límite de tokens y señal abortable; no copia secretos detectados al error. La policy determinista puede degradar resultados del modelo. Las métricas mock no son precisión real. | Si se habilitara el boundary, el texto directo elegible se enviaría a OpenAI; `store: false` no equivale a retención cero del proveedor. En C.8 no se llamó a OpenAI. | Adaptador real implementado; habilitación, gobernanza y evaluación de producción pendientes. |
| C.5f — procedencia e identidad hablante | `trusted-speaker-identity.js`, adaptador Windows y `direct-user-input.js` | El proof de stdin no puede fabricarse con objeto/string; vincula texto original, turno, sesión y destinatario. Windows SID se trata como cuenta no verificada; proveedor Windows Hello es unavailable y fail-closed. Voz no autentica por sí sola. | Sin autenticación nativa verificada no hay identidad personal ni vínculo Self de producción. | Frontera local real; verificación del humano y binding durable pendientes. |
| C.5g.1–5g.4 — Owner, permisos, aislamiento, dispositivos/sesiones | `identity-contracts.js`, `authorization-engine.js`, `isolation-contract.js`, `device-session-lifecycle.js` | Validadores y motores estructurales hipotéticos comparan entidades/épocas/ámbitos; requests de ejecución se deniegan; Owner no tiene bypass de memorias privadas. | No son base de datos autoritativa, autenticación, control de acceso de producción, revocación transaccional ni emparejamiento real. Fixtures solo sirven a tests. | Simulado/estructural; Owner bootstrap, sesiones, dispositivos, grants y aislamiento operativo pendientes. |
| C.6 — evaluación selectiva | `selective-simulation.js`, `authorization-gate.js` | Composición sintética A→planner→gate; `ELIGIBLE_HYPOTHETICAL` nunca es autorización, todas las salidas no ejecutables, gate deniega modo de ejecución. | Función de simulación aislada; no toca memoria, identidad ni consentimiento real. | Simulación. |
| C.7 — confirmaciones conversacionales | `conversation-confirmation.js` | Propuestas y respuestas estructuradas vinculadas por IDs/fingerprint/target y contexto simulado; lotes independientes; correcciones generan nueva propuesta; outputs no ejecutables. | No hay almacén autoritativo de propuestas/respuestas ni integración al agente. Un snapshot antiguo puede repetir un resultado hipotético, no una escritura. | Simulación. |

## Recorrido actual y efectos

En la CLI, `src/index.js` construye el detector real pero fija `enableAutomaticMemoryAssessment: false`. El agente tiene el mismo valor por defecto y rechaza el detector real si se intenta habilitar por esa interfaz. Tras entregar la respuesta llama al hook de finalización, que no evalúa cuando el flag está apagado. La composición no significa que se ejecute una solicitud adicional.

Cuando las pruebas habilitan un detector simulado, el assessment boundary exige proof opaco del turno confiable, consentimiento de análisis vigente, conversación no excluida y preflight. Marca la sesión como expuesta antes de invocar el detector, aplica timeout/cancelación, descarta resultados tardíos y revalida controles después del `await`. Si se expone contexto externo, el límite bloquea evaluación posterior en esa sesión. `run(text)` no puede producir el mismo proof.

El resultado del assessment incluye explícitamente `authorizationGranted: false`, `writeReady: false` y `persisted: false`. El agente puede presentar diagnósticos/candidatos al flujo de revisión, pero el código inspeccionado no llama `proposalQueue.enqueue()` desde esa ruta. La cola local de C.5c sí persiste resúmenes cuando se invoca directamente; su existencia no demuestra que los candidatos conversacionales se encolen. No debe conectarse sin política revisada de minimización, control de acceso, retención, borrado y atribución por usuario.

El coordinador y writer B.2b son capacidades separadas. El writer puede cambiar un repositorio v5 entregado por su caller cuando recibe autorización válida, pero no está conectado a la CLI ni a tools. El comando manual de Memory1 y las herramientas/operaciones manuales existentes son rutas independientes; no constituyen Automatic Memory.

## Auditoría transversal: hallazgos y severidad

La severidad clasifica la preparación para activar, no afirma que hoy exista una ruta de exposición o escritura automática.

### Bloqueantes para activación personal

1. **Identidad y Self no verificados (bloqueante).** El proceso local, stdin y SID no prueban identidad humana. Windows Hello falla cerrado; no existe binding Self personal autenticado y durable. Un nombre o la etiqueta `user` no lo suplen.
2. **Consentimiento no atribuible a un principal autenticado (bloqueante).** El ledger persistente permite recordar la elección local de analizar, pero la instalación no tiene autenticación multiusuario que pruebe quién otorgó o revocó ese consentimiento. El registro actual tampoco tiene vencimiento. Además, consentimiento de análisis no cubre almacenamiento.
3. **Propuestas y confirmaciones no autoritativas (bloqueante).** C.7 es puro y recibe snapshots sintéticos. No hay registro durable integrado de revisión, vencimiento, revocación y consumo atómico. Repetir un snapshot antiguo repite una decisión hipotética; producción debe impedirlo con estado autoritativo.
4. **Flujo de escritura no integrado (bloqueante para funcionalidad, no defecto actual).** El writer B.2b existe y tiene pruebas, pero no está enlazado con una propuesta real de runtime. No existe una ruta activa del assessment a autorización consumible y transacción. No se debe improvisar un cableado durante la activación.
5. **Gobernanza de datos externos pendiente (bloqueante antes de envío real).** El adaptador usa `store: false`, sin tools y con límites, pero el texto elegible se transmite al proveedor si se invoca. Deben aprobarse explícitamente tratamiento, retención, costos, categorías y experiencia de consentimiento; `store: false` no promete retención cero.

### Riesgos importantes

- **Persistencia local con límites de confianza del host (importante).** Consentimiento y cola usan archivos JSON locales y lock cooperativo. Su seguridad depende de cuenta/ACL del sistema operativo y del filesystem. El ledger intenta permisos restrictivos y reemplazo atómico, pero no resiste administradores del host, malware, backups o escritores que ignoren el lock.
- **Una sola identidad Self estructural (importante).** Memory2 ofrece `self_person_id`; no existe todavía partición operativa multiusuario con roles, privacidad, recuperación y permisos efectivos. Owner administrativo no debe implicar lectura de memoria privada.
- **Screening no es garantía semántica completa (importante).** El screening determinista y el modelo son defensa en profundidad, pero patrones no detectan todas las credenciales/datos sensibles o paráfrasis. Las pruebas sintéticas no certifican ausencia de falsos negativos.
- **Exposición externa conservadora (importante).** La sesión queda bloqueada tras exposición o intento de evaluación porque el texto pudo salir del proceso. Es seguro pero limita cobertura; cualquier recuperación entre contextos requiere diseño y validación separados.
- **Concurrencia física y filesystem (importante).** B.2b.8c valida escenarios de repositorios/locks cooperativos y fallos inyectados; no demuestra cortes eléctricos, todos los filesystems ni escritor externo no cooperante.
- **Auditoría operativa insuficiente para producto (importante).** Diagnósticos en memoria/códigos no constituyen un registro de seguridad multiusuario. Antes de administración real se requiere definir qué auditar sin almacenar contenido innecesario y protegerlo contra alteración.

### Riesgos menores y mejoras

- La precisión del extractor depende del modelo, idioma y distribución real; el corpus sintético y pruebas mock no son una evaluación representativa.
- La cola de propuestas conserva resúmenes localmente si se usa; aunque tiene TTL y limpieza de campos al rechazar, necesita revisión de retención, backup, borrado y privacidad antes de producción.
- El estado de bloqueos por exposición es de sesión/proceso. La conducta tras reinicio o múltiples procesos debe quedar cubierta por el coordinador de producción, no inferirse de la simulación.

### Defectos demostrados en esta auditoría

No se identificó un bypass que convierta C.6/C.7 hipotéticos en escritura ejecutable desde la ruta conversacional inspeccionada. La extracción real permanece detrás del flag apagado; el agente rechaza el detector real al intentar activar assessment por la configuración actual; no se encontró llamada de evaluación a `proposalQueue.enqueue()` ni conexión del agente a `commitAutomaticOperation()`. Estos hallazgos describen el código auditado, no una garantía contra cambios futuros o módulos externos.

## Matriz de requisitos para una activación futura

| Requisito | Estado | Evidencia/pendiente verificable |
|---|---|---|
| Autenticación real del hablante | **Pendiente** | Proveedor fail-closed; implementar y revisar un mecanismo de autenticación nativo con verificación de usuario, no solo SID/voz. |
| Bootstrap seguro y recuperación de Owner | **Simulado / pendiente** | Contratos Owner-first, sin cuenta real, autenticación reforzada, recuperación ni auditoría durable. |
| Identidad estable y Self por usuario | **Parcial/simulado** | `self_person_id` y validadores estructurales existen; falta binding autenticado, almacenamiento autoritativo y transición multiusuario. |
| Consentimiento individual de análisis | **Parcial** | Ledger local persistente y revocación/exclusión; falta atribución a usuario autenticado, gestión multiusuario y aprobación de política de datos del proveedor. |
| Consentimiento para guardar | **Pendiente** | El consentimiento actual declara `grantsMemoryWrite: false`; diseñar consentimiento/confirmación específico por operación y alcance. |
| Filtros, fuentes y secretos | **Parcial** | Screening, allowlists y política probados; revisar cobertura, falsos negativos, abuso adversarial y política de fuentes. |
| Extracción y validación | **Implementado con límites** | Structured Outputs y validación determinista; evaluación real amplia, reproducible y representativa pendiente. |
| Propuestas persistentes autoritativas | **Pendiente** | C.5c queue persiste localmente si se invoca; no se alimenta desde el assessment. Falta revisar esquema, acceso por usuario, revisión vigente, caducidad y consumo atómico. |
| Confirmación independiente | **Simulado/parcial** | B.2b usa entrada directa confiable y capabilities en proceso; C.7 modela respuestas estructuradas, no UX conversacional integrada ni estado durable. |
| Política de permisos y ámbito | **Simulado** | C.5g valida snapshots hipotéticos; falta enforcement real para herramientas, personal/private/shared y administración. |
| Dispositivos y sesiones | **Simulado** | Contratos/lifecycle puros; faltan autenticación, almacenamiento transaccional y revocación efectiva. |
| Writer protegido y recibos | **Implementado aislado; integración pendiente** | B.2b.8 revisa capability/snapshot/receipt bajo lock y prueba transacciones temporales; no hay ruta desde UI/agente y no es durabilidad universal. |
| Idempotencia y concurrencia | **Parcial** | Pruebas contra repositorios temporales/locks; faltan garantías operativas del entorno, recuperación multi-proceso y política de resultado incierto de producto. |
| Aislamiento por usuario e instalación | **Simulado/parcial** | Contratos y selección sintética; falta almacenamiento particionado y enforcement en cada lectura/escritura/backup. |
| Revocación | **Parcial** | Revoca análisis en el runtime actual y invalidaciones simuladas; falta revocación autoritativa de usuario, permisos, sesiones, propuestas y grants en almacenamiento. |
| Auditoría y observabilidad segura | **Pendiente** | Hay códigos diagnósticos; definir auditoría protegida, minimizada y sin cuerpos sensibles. |
| Pruebas de seguridad de activación | **Parcial** | Suites sintéticas amplias, incluidas transacción temporal; falta prueba operativa autenticada, recuperación, permisos del host y revisión independiente previa a habilitar. |
| Interruptor y reversión | **Parcial** | Evaluación apagada por defecto, consentimiento revocable y separación de backend; falta procedimiento de despliegue/rollback y comprobar que la desactivación cancela todo trabajo durable activo. |

## Recomendaciones priorizadas

1. **Mantener todo apagado.** No cambiar `enableAutomaticMemoryAssessment`, `automaticSavingEnabled`, ni `NEXA_MEMORY_BACKEND` como parte de una etapa de arquitectura.
2. **Resolver identidad/Owner antes de datos reales.** Especificar autenticación humana, bootstrap/recovery de Owner, binding por persona, sesiones/dispositivos, y cómo se protege Self en uso local y multiusuario.
3. **Aprobar privacidad antes de cualquier extracción real.** Decidir qué turnos/categorías pueden enviarse al extractor, retención/proveedor, opt-in por usuario, costos, borrado y comportamiento al cambiar de sesión o exponerse contexto externo.
4. **Diseñar persistencia autoritativa de propuestas.** Enlazar candidate fingerprint y target exacto con revisión, usuario, sesión, consentimiento, expiración y revocación; consumo atómico, replay seguro y aislamiento por usuario.
5. **Integrar una única ruta revisable.** Presentación de plan fuera del modelo; confirmación independiente; revalidación de identidad, consentimiento y snapshot dentro del coordinador/writer; no permitir API genérica ni tools públicas.
6. **Ejecutar una activación controlada, no automática.** Primero harness temporal autenticado de extremo a extremo, luego piloto explícito de alcance limitado y mecanismo de apagado/reconciliación, tras revisión de seguridad y privacidad.
7. **Auditar operación.** Definir qué eventos se registran, quién puede inspeccionarlos, retención y protección, con contenido minimizado y sin copiar texto original salvo justificación aprobada.

## Criterios comprobables antes de pedir autorización de activación

- Un usuario autenticado en un host/UI verificados puede emitir identidad y consentimiento atribuibles; los tests prueban que texto/modelo/tool/SID no los falsifican.
- Owner se inicializa y recupera mediante un proceso revisado; incorporar/revocar usuarios y dispositivos cambia revisiones autoritativas y no concede acceso a recuerdos privados.
- El consentimiento diferencia análisis, almacenamiento, categorías, ámbito y destinatarios, tiene expiración/revocación durable y se verifica de nuevo al confirmar y escribir.
- La propuesta presentada coincide criptográficamente con candidato, evidencia, operación, target de REPLACE, ámbito y snapshot; respuestas cruzadas, replay, expiración y revocación fallan cerradas.
- Cualquier lectura/escritura pasa por permisos por usuario/instalación y partición; Owner no puede saltar privacidad de otros.
- El writer solo acepta una capability real de un uso, consume bajo lock/estado autoritativo y publica records y receipt atómicamente; fallos inciertos se reconcilian sin reejecución ciega.
- La activación no puede producir escritura desde `run(text)`, salida del modelo, tools, fuentes externas, simulación, comandos públicos ni `auto_save` por sí solos.
- Pruebas temporales cubren integración, concurrencia, persistencia, revocación, restauración/backup, corrupción y recuperación; límites del OS/filesystem quedan documentados y probados en plataformas objetivo.
- La revisión de privacidad aprueba envío de texto a proveedor, retención, borrado, telemetría, exclusiones, control de costos y manejo de incidentes.
- Hay interruptor operativo verificable que detiene nuevas extracciones/escrituras, cancela trabajos y permite volver a Memory1 sin migración o pérdida de estado.
- Las métricas de extractor son medidas con corpus autorizado y evaluado, con falsos auto-save reportados; mock tests no se cuentan como precisión real.

## Preparación para Memory D

Los módulos de Memory D deberían depender de interfaces de lectura/escritura canónicas de Memory2, no de Automatic Memory ni del agente:

- **D.1 — temporalidad:** reutilizar assertion temporal e historial/supersession de Schema v4/v5 y el planner; probar fechas relativas, validez y correcciones sin asumir que la extracción está autorizada.
- **D.2 — relaciones:** reutilizar Entity/Person y `relations` ya presentes en Memory2; mantener resolución conservadora y no convertir nombres textuales o contactos en entidades canónicas automáticamente.
- **D.3 — contradicciones y cambios:** reutilizar estado de assertions, target exacto de REPLACE y el historial; exigir conflicto explícito y revisión en vez de elegir un valor por recencia sin contrato.
- **D.4 — consolidación:** añadir un servicio de consolidación separado con recibos/revisiones y pruebas de idempotencia; no borrar historial ni fusionar entidades automáticamente.
- **D.5 — olvido, privacidad y corrección:** separar olvidar una assertion, revocar una referencia compartida y borrar datos personales; definir efectos en evidencia, provenance, backups, recibos y retención antes de implementación.
- **D.6 — recuperación contextual:** reutilizar consultas estructuradas, relaciones y ensamblador selectivo C.3 como interfaz de contexto; exigir autorización por usuario/ámbito antes de consultar y minimizar el contenido devuelto al modelo.

Memory D puede avanzar primero sobre fixtures v5 y APIs puras. Debe permanecer independiente de aprendizaje automático, del extractor real y de la activación personal. Sus lecturas no deben depender de que Automatic Memory esté habilitada, y su escritura debe seguir atravesando la frontera de MemoryService/repositorio y los permisos correspondientes. La integración multiusuario, el consentimiento y el almacenamiento autoritativo siguen siendo dependencias transversales, no trabajo que D pueda resolver implícitamente.

## Validación C.8

En la ejecución C.8: Automatic Memory, 209/209; Memory, 440/440; suite completa, 662/662. Las suites son sintéticas salvo los tests de procesos/archivos temporales señalados por sus suites; no se invoca OpenAI ni se usa la memoria personal. El primer intento dentro del sandbox tuvo `EPERM` al resolver directorios temporales y no se contó como resultado válido; al ejecutar las suites con acceso normal a esos fixtures temporales, las tres pasaron. `git diff --check` y whitespace del documento pasan. No se agregan dependencias ni se modifican stores.

Estado verificado al inicio: Memory1 SHA-256 `41F995007782BDDF665C39EA9F69B2B699C90329D1D0CAEC61F4307154773B68`; backend efectivo `memory1`; `NEXA_MEMORY_BACKEND` sin definir; `data/memory-v2.json` ausente. Automatic Memory assessment apagada por la CLI, guardado automático desactivado, y extractor real no invocado. C.8 no cambia estas condiciones.
