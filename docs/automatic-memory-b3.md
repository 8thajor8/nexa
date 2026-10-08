# Automatic Memory B.3 — Auditoría integral de seguridad

## Alcance y método

Esta auditoría inspecciona la implementación consolidada de Automatic Memory A y B en `8c59503086744406f5c3064e87729665492fdb3b`. No conecta el detector, planner, coordinador ni writer al agente o a herramientas públicas, no cambia producción, no llama a OpenAI y no usa una memoria personal.

La prueba nueva `test/memory-automatic-audit.test.js` ejecuta un camino integral con un extractor sintético inyectado: stdin real del proceso hijo → detector y normalizador reales → policy/planner y contrato reales → coordinador de confirmación real → `commitAutomaticOperation()` y repositorio JSON v5 real en un directorio temporal. La prueba confirma explícitamente que el contrato B.2a sigue marcando autorización y ejecución como denegadas; el permiso para la mutación solo aparece tras la confirmación separada por stdin y la capability opaca del coordinador. Esto prueba la tubería local desde el límite de entrada hacia un fixture de repositorio; no prueba extracción real de modelo ni conexión conversacional.

Las demás propiedades se respaldan con las pruebas existentes del repositorio real, unitarias y estáticas, señaladas en la matriz. Los tests de simulador de fases B.2b.2/.3 no se usan como evidencia de comportamiento de producción.

## Flujo y fronteras

| Etapa | Datos / transformación | Confianza y control |
| --- | --- | --- |
| Entrada | `readDirectUserTurn()` obtiene el siguiente renglón de `stdin`, asigna sesión y turno, y guarda privadamente el hash del texto. | Confianza limitada al origen local observado por el proceso. No autentica a una persona ni demuestra quién controla el sistema operativo. |
| Detección A | El detector filtra secretos probables, entrega el texto a la extracción configurada y normaliza solo el esquema cerrado de candidatos. | Texto y salida del modelo son datos no confiables. Se rechazan campos extra de identidad, autorización, provenance, assertion o target. En B.3 se inyecta un extractor sintético; no se contacta OpenAI. |
| Validación y policy A1 | Comprueba evidencia textual exacta, screening, modalidad, sensibilidad, durabilidad, Self estructural, duplicados, contradicciones y terceros. | El código decide la disposición; la sugerencia del modelo no concede permiso. Credenciales se bloquean; datos sensibles no credenciales y terceros requieren revisión. |
| Planner B.1 / contrato B.2a | Produce ADD/REPLACE/ASK/IGNORE/DUPLICATE y contrato con fingerprints, provenance inferida y binding de snapshot. | Es dry-run: `executable:false`, `writeReady:false`, `authorization.granted:false`. ADD no selecciona target; REPLACE exige target único en evidencia y confirmación. |
| Coordinador B.2b.7 | Construye preview de código, frase aleatoria específica, y lee la confirmación desde el siguiente renglón real de stdin; consume el proof y emite capability opaca ligada a destinatario, operación, fingerprint, snapshot y target. | El texto de modelo o tool no es leído como confirmación. ASK/IGNORE/DUPLICATE no obtienen grant. El primer intento de verificación consume el grant. |
| Writer / repositorio B.2b.8 | Recalcula operación y fingerprint; bajo lock busca recibos, consume capability y compara revisión/digest actual; genera assertion/source/evidence/receipt internamente y publica una revisión. | No acepta records arbitrarios ni `authorization_request_id` como prueba. `commit()` genérico bloquea cambios de `automatic_operations`; el recibo permite replay aplicado de solo lectura. |
| Schema/migración | Schema v5 valida estructura y enlaces de los recibos; migración v4→v5 es explícita y separada. | La validación no es autenticación. Abrir v4 no activa migración. Esta auditoría no ejecuta migraciones. |

### Otras rutas de escritura encontradas

Las operaciones manuales de `MemoryService` (`remember`, `forget`, creación de personas/relaciones y correcciones) consumen grants del autorizador explícito y luego llaman a `repository.commit()`. La migración Memory1→Memory2 también usa `commit()` en un store destino vacío; la migración de esquema v4→v5 es una función separada y explícita que toma lock, crea/verifica backup y reemplaza el archivo. La inicialización de un store Memory2 solo ocurre si se selecciona explícitamente el backend `memory2`. `src/memory/memory.js` escribe el formato Memory1 y queda fuera del repositorio v5. Estas rutas no son invocadas por Automatic Memory A.

El repositorio genérico sigue siendo una API de código confiable: protege la colección de recibos automáticos, pero no es una sandbox que haga imposible a cualquier módulo interno con un handle cometer otros cambios válidos. La propiedad de seguridad de Automatic Memory depende además de que el handle no se entregue a la salida del modelo ni a tools, y de que la única ruta automática use `commitAutomaticOperation()`.

## Matriz de invariantes y evidencia

| Invariante | Evidencia revisada | Cobertura / resultado |
| --- | --- | --- |
| El modelo no autoriza su propia operación | `detector.js`, `schema.js`, policy, planner, contrato B.2a, coordinador; nuevo test de campos falsificados | El candidato con `authorization_request_id` y `canonicalEntityId` se rechaza por esquema antes de preparar autorización. El sugerido `ignore` no bloqueó el ADD sintético: la policy determinista tomó la decisión y aun así exigió confirmación separada. |
| Claims, IDs y provenance del modelo no se convierten en autoridad | Esquema cerrado; planner y writer generan Self, IDs, provenance, evidence y recibo desde código/estado validado | Inyección de campos extra rechazada; el registro publicado usa `derived_untrusted` / `data_only`. El writer vuelve a normalizar y calcular plan/fingerprint. |
| Texto de confirmación es independiente de la salida del modelo | `direct-user-input.js` y `authorization-coordinator.js`; ADD integral y REPLACE sin confirmación | La confirmación se lee desde stdin aparte y no vuelve como turno conversacional. REPLACE sin esa lectura no escribe y deja bytes del store sin cambio. La prueba positiva de REPLACE con confirmación específica está en `memory-automatic-transaction.test.js`. |
| Capability opaca, ligada y de un uso | WeakMaps privados en boundary/coordinator; pruebas de coordinador y transacción | Se verifican destinatario, operación, fingerprint, revisión/digest y target; el primer intento de consumo la invalida. Reuso, mismatch y capacidad falsa se rechazan. |
| ASK, IGNORE y DUPLICATE no escriben | Policy/planner, contrato y writer | ASK sensible no obtiene request ejecutable; intento de writer rechazado, revisión y recibos permanecen en cero. La suite específica también cubre duplicados y operaciones inelegibles. |
| Secretos no se persisten automáticamente | `secret-screening.js`, detector y writer | Prueba sintética verifica bloqueo antes de llamar al extractor y que el resultado no reproduce el secreto. Screening es heurístico, ver límites abajo. |
| ADD preserva datos anteriores | Planner, writer, transacción | El flujo integral confirma ADD de una assertion y receipt en revisión 1; los tests transaccionales cubren append-only y atomicidad lógica. |
| REPLACE usa target exacto, confirmado y conserva historial | Planner, preview, writer | Pruebas transaccionales verifican REPLACE positivo, target activo exacto, supersession y evidencia/provenance anterior preservados. La prueba B.3 verifica que omitir confirmación deja el store idéntico. |
| Replay no duplica | Recibos Schema v5 y writer | Pruebas reales sobre repo temporal verifican replay idéntico, también tras reabrir, como `already_applied` sin nueva revisión; misma clave con fingerprint distinto falla cerrada. |
| Snapshot obsoleto falla seguro | CAS/lock del repositorio y coordinador | Pruebas B.2b.8b/8c verifican rechazo sin mutación; la capability se consume si el intento alcanzó el verificador. No se replanifica silenciosamente. |
| API genérica no altera recibos automáticos | `repository.js`, `json-repository.js`, tests de repositorio/transacción | Inserción/eliminación/reemplazo genérico de `automatic_operations` se rechaza. Esto protege recibos, no convierte toda API del repositorio en una frontera frente a código interno arbitrario. |
| Sin ruta actual desde agente/tools | `src/core/agent.js`, `src/tools/*`, búsquedas de imports/callers; test estático nuevo | Agente y tools públicas no importan detector/coordinador ni llaman a `commitAutomaticOperation`. El agente sigue usando Memory1. |
| Memory1/Memory2 aisladas | Backend y configuración revisados; comprobaciones finales | Se verificará Memory1 por SHA-256, ausencia del store personal v2, entorno sin override y backend efectivo `memory1`. Las pruebas usan fixtures temporales. |

### Pruebas integrales nuevas

`test/memory-automatic-audit.test.js` incluye cinco pruebas que cubren seis escenarios: ADD sintético desde stdin hasta repositorio temporal; REPLACE sin confirmación; candidato de salud que queda ASK; campos de autoridad falsificados; secreto sintético detenido antes del extractor; y comprobación estática de que agente/tools no están conectados. Ninguna usa red ni memoria personal. La capa de extracción es un stub deliberado y no una respuesta inventada de modelo.

La suite existente `test/memory-automatic-transaction.test.js` cubre contra repositorio v5 temporal capabilities inválidas/reusadas, ADD/REPLACE, receipts, replay tras reapertura, conflictos, fallos de publicación y resultado incierto. `test/memory-automatic-coordinator.test.js` cubre confirmación y bindings. Los tests de schema/repository y suites A/B cubren recibos, policy y contratos. Los informes B.2b.8b/8c describen los límites de las pruebas de fallos y concurrencia.

## Hallazgos y riesgos residuales

| Severidad | Hallazgo | Consecuencia / acción requerida |
| --- | --- | --- |
| Bloqueante para activar C | La sesión de stdin no autentica a un humano. | C no debe presentar esto como identidad personal, ni permitir aprobación silenciosa. Mantener confirmación visible y específica; definir el modelo de usuario/autenticación si se requiere identidad. No es un bloqueo para la auditoría aislada actual. |
| Importante, condición previa a C | `repository.commit()` es API interna genérica para escrituras legítimas y protege específicamente la colección de recibos automáticos; no es aislamiento contra módulos arbitrarios del mismo proceso que obtuvieran el repositorio. | Mantener repositorio/capability fuera de argumentos del modelo y tools, minimizar módulos con acceso al handle y revisar el grafo de dependencias en C. Si se requiere frontera contra módulos internos no confiables, habrá que encapsular la API, no confiar en `source`/provenance. Hoy no se encontró exposición desde agente/tools. |
| Importante | Screening de secretos y sensibilidad es una combinación de heurísticas, esquema y etiquetas propuestas; no demuestra reconocimiento de todos los secretos o datos sensibles semánticos. | Antes de C, conservar listas positivas conservadoras, no persistir credenciales, probar categorías y citar claramente que una sensibilidad no detectada puede eludir la política. No afirmar cobertura completa. |
| Importante | La concurrencia y persistencia dependen del lock cooperativo, filesystem local compatible y recibos íntegros. | No protege editores/escritores que ignoren lock. No hay garantía universal ante pérdida de energía, fallos de hardware, terminación abrupta durante rename ni entre todos los filesystems. Seguir el procedimiento de resultado incierto de B.2b.8c; nunca repetir a ciegas. |
| Mejora futura | A depende de la exactitud lingüística del extractor; extracción estructuralmente válida puede seguir estar semánticamente equivocada. | Al integrar C, usar confirmación visible con los valores precisos, mantener ASK ante ambigüedad y evaluar con corpus sintético/real autorizado antes de ampliar escrituras. |
| Mejora futura | Los recibos son append-only y la autorización es de proceso; limpieza/retención de recibos o recuperación tras reinicio requieren cuidado. | No podar recibos aplicados sin diseño que preserve detección de replay. Un grant en memoria desaparece al cerrar/reiniciar; después del commit se reconcilia por receipt, y si no hay receipt aplicado se requiere plan/confirmación/grant nuevos. |

## Criterios obligatorios antes de iniciar C

1. Diseñar la integración en el punto de entrada confiable, nunca desde texto de tool ni salida del modelo; preservar comandos explícitos actuales.
2. No pasar repositorio, capability, destinatario de autorización, confirmación ni APIs de escritura al modelo/tools.
3. Conservar un paso de revisión/confirmación independiente que presente operación, valor, snapshot y target REPLACE exactos; no interpretar una respuesta del modelo como confirmación.
4. Mantener policy y writer como validadores independientes; revalidar candidato, evidencia, secreto, snapshot, target y receipt inmediatamente antes de persistir.
5. Empezar con backend y directorios de prueba, sin habilitar Memory2 personal; establecer apagado seguro, telemetría sin texto/capabilities y recuperación documentada.
6. Añadir pruebas adversariales del flujo integrado y pruebas que prueben que el grafo de módulos del agente no entrega autoridad ni writer a tools.
7. Resolver el alcance de identidad: stdin es origen local, no autenticación humana. No usar Self como autenticación.
8. Repetir una release review completa y verificar aislamiento de stores, configuración, credenciales y dependencias antes de cualquier activación.

## Conclusión de auditoría

En el alcance aislado auditado, no se encontró una ruta desde el modelo o las tools actuales para autorizar o escribir por su cuenta. El camino sintético confirmó la cadena hasta un repositorio temporal con una confirmación de stdin independiente; la operación publicada quedó marcada como provenance inferida y el contrato B.2a mantuvo sus campos de permiso denegados. Las pruebas de transacción existentes respaldan los casos adicionales de replay, snapshot y fallos, con los límites documentados.

La arquitectura está **preparada para iniciar el diseño de C**, no para activar escrituras personales ni para afirmar autenticación humana o seguridad frente a código interno arbitrario. C debe implementar primero una integración opt-in, aislada y revisable; el agente y tools actuales continúan sin Automatic Memory.
