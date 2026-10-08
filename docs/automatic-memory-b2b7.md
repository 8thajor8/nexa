# Automatic Memory B.2b.7 — Coordinador confiable de autorización

## Alcance implementado

B.2b.7 agrega un coordinador interno y una entrada de confirmación que lee directamente de `process.stdin`. El coordinador usa el contrato dry-run B.2a para preparar únicamente operaciones `ADD` o `REPLACE`, muestra una vista previa generada por código en la terminal y emite una capability opaca de un solo uso después de que la línea siguiente coincide exactamente con el desafío de esa solicitud.

Esta etapa **no escribe en Memory2**. El módulo no importa `MemoryService`, repositorios ni ejecutores; el agente no importa el coordinador; las herramientas no pueden invocarlo; B.2b.1 continúa denegando; y todo resultado mantiene `executable: false` y `writeReady: false`. La capability solo permite comprobar que se autorizó una operación concreta en esta fase. No existe un consumidor de producción que pueda persistirla.

## Frontera de confianza

`readDirectUserTurn()` sigue siendo el único origen de texto de conversación. `readDirectUserConfirmation()` es una vía separada: imprime el preview y el texto de confirmación exacto directamente por `stdout`, consume la línea siguiente desde el mismo lector privado de stdin y **no devuelve esa línea como turno conversacional**. Una respuesta del modelo, salida de tool, texto citado o argumento estructurado no pasa por este lector.

El runtime genera IDs de turno y la sesión local. La capability de confirmación queda asociada a identidad de destinatario, sesión, turno de confirmación, request ID, fingerprint y phrase. La capability no contiene propiedades ni puede reconstruirse desde JSON. El verificador la reconoce por identidad en un `WeakMap` privado. Mismatch o intento repetido consume/rechaza el proof. Nuevo turno y cierre invalidan el uso posterior.

La sesión continúa siendo `local_runtime_session`: demuestra entrada local observada por este proceso, no una identidad humana autenticada, titularidad del sistema operativo o ingreso remoto. No hay scopes de identidad de usuario.

## Preparación y confirmación

`prepareAutomaticMemoryAuthorization()`:

1. Consume una capability vigente del turno original de stdin, ligada al texto exacto.
2. Reejecuta el contrato B.2a con propuesta y snapshot, y acepta únicamente `ADD`/`REPLACE` con binding de snapshot, destino requerido y decisiones todavía no ejecutables.
3. Recalcula un fingerprint sobre versión, operación, candidato normalizado, source binding, key B.2a, snapshot y target.
4. Crea una solicitud privada, de vida corta, ligada al destinatario y turno. No autoriza durante esta etapa.
5. Devuelve preview exacto para el caller confiable y el handle opaco. No devuelve challenge ni capability.

`confirmAutomaticMemoryAuthorization()` consume el handle pendiente al primer intento, verifica destinatario/vigencia/turno y pide confirmación al lector confiable. El prompt exige la frase exacta generada para el request; el REPLACE incluye el ID del assertion target en la frase y en la vista previa. Una frase incorrecta, una confirmación desde otro destinatario o una repetición no emiten capacidad.

El preview distingue `Self` como owner estructural, atributo/predicate, valor y contexto de evidencia. REPLACE además muestra el valor previo y el ID exacto que cambiaría. El texto que se imprime elimina caracteres de control y se limita en longitud. La provenance se presenta como inferida/no confiable; la aprobación no la convierte en afirmación explícita.

`consumeAutomaticMemoryAuthorization()` quema la capability antes de comprobar todos los bindings. Comprueba destinatario, operación, fingerprint, revision/digest, target, expiración y que el turno local de confirmación siga activo. Los resultados `ASK`, `IGNORE` y `DUPLICATE` no crean requests ni capacidades. La capability no se serializa ni se registra.

## Límites y garantías ausentes

- La preparación recibe un snapshot validado por B.2a, pero `freshnessChecked` permanece `false`: el coordinador no consulta el repositorio ni prueba que el snapshot siga vigente.
- El runtime no está conectado al coordinador. La CLI normal y el agente conservan su comportamiento; ningún modelo/tool puede abrir el prompt o recibir la capability por una integración existente.
- El proceso debe invocar el coordinador y conservar el handle/capability internamente. No hay canal remoto ni interfaz gráfica.
- El mecanismo no persiste grants ni requests. Reiniciar pierde el estado. El siguiente turno o cerrar la sesión impide consumir la capacidad pendiente.
- No existe consumo atómico junto al commit, receipt transaccional, recuperación post-rename, retry autorizado ni ejecutor ADD/REPLACE. Eso pertenece a una etapa posterior.
- La API de lectura de confirmación forma parte del módulo de frontera confiable y presupone que solo código interno autorizado la llama con el preview producido por el coordinador. No se debe exponer como tool ni alimentarla con preview del modelo.
- La entrada local no prueba quién controla el terminal; ejecución arbitraria dentro del proceso y control del OS están fuera de esta frontera.

## Pruebas

`test/memory-automatic-coordinator.test.js` utiliza procesos hijos y texto sintético por stdin real. Comprueba preview ADD/REPLACE, target exacto, frase incorrecta, doble y concurrente confirmación, sustitución entre requests, operación/fingerprint/snapshot/destinatario alterados, nuevo turno/cierre, proof de request cruzado, claims falsificados, decisiones no ejecutables y ausencia de dependencias de escritura. Ningún test abre o modifica un store de memoria.

La capability representa consentimiento local para el plan mostrado; no es identidad autenticada ni permiso para persistir por sí sola. Memory2 sigue inactiva y B.2b.8 no está implementada.
