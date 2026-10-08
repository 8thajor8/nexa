# NEXA — C.5g.3: aislamiento de memorias por usuario y ámbito compartido

## Alcance y arquitectura existente

Memory2 continúa siendo un store único con `self_person_id` y colecciones globales de entidades, assertions, sources y evidence. Los subjects de una assertion pueden ser `owner`, `unspecified` o una entidad; el esquema no incluye propietario de assertion, partición por principal ni ACL de memoria. El context provider consulta ese store y no filtra por principal autenticado. El servicio, repositorio, recuperación y transacción B.2b operan sobre el mismo store. C.5g.1 aporta contratos estructurales de Owner/principal/sesión y C.5g.2 evalúa fixtures hipotéticas; ejecución real permanece DENY.

Automatic Memory conserva su política de candidatos y la integración experimental continúa separada de persistencia. Ningún componente de C.5g.3 se conecta a esos módulos, al agente, a tools o al proveedor real del context provider.

## Contrato implementado

`src/memory/isolation-contract.js` valida snapshots sintéticos con instalación, revisión, principals, particiones, referencias de records y shares. `selectHypotheticalMemoryContext()` devuelve únicamente IDs opacos de records exactos que pasarían una política hipotética. No devuelve IDs de partición compartida: hacerlo permitiría enumerar otros records de esa partición destinados a otros recipients. No devuelve contenido, no construye rutas, no lee ni escribe archivos y `mode: "execution"` siempre devuelve DENY con `executable: false`.

Una partición privada tiene un único Owner principal. Una partición compartida pertenece a una instalación y a un principal propietario. Los IDs tienen prefijos y formato UUID canónico en minúsculas, se validan antes de usarse como referencias y nunca se convierten en rutas. El snapshot rechaza IDs duplicados, particiones privadas duplicadas para un principal, instalaciones cruzadas, records huérfanos, referencias compartidas inconsistentes, approvals posteriores al momento evaluado, recipients duplicados/desconocidos y descriptores adicionales. No hay fallback a otra instalación, usuario, partición o coincidencia de nombres.

Cada record de fixture separa `ownerPrincipalId`, `subjectPersonId` y `contributorPrincipalId`. La visibilidad privada depende del propietario del record, no del sujeto mencionado, del rol Owner administrativo ni de un nombre. Por eso, un recuerdo del Owner sobre un miembro sigue privado del Owner salvo que se comparta explícitamente.

## Privacidad y compartir

La regla es personal por defecto. Owner y cada miembro ven únicamente sus propios records privados. El rol administrativo Owner no da acceso implícito a la memoria privada de otros. Un share describe una referencia compartida exacta: record fuente privado, proyección en partición compartida, Owner del record, lista explícita de recipients, aprobador estructural, revisión y estado de revocación. No comparte la partición privada completa. La revocación retira esa referencia de futuras selecciones; el record privado original continúa en su partición.

El campo `approvedByPrincipalId` y el objeto share son datos sintéticos, no prueba de consentimiento ni grant durable. En una implementación operativa, crear y revocar un share requerirá identidad autenticada, confirmación independiente del propietario del recuerdo, autorización durable y publicación transaccional de una referencia exacta. El modelo no podrá proponer recipients autorizados, aprobar un share ni ampliar su alcance.

Revocar evita futuras recuperaciones autorizadas, pero no borra contenido que un destinatario ya haya visto o copiado legítimamente. Una futura implementación también deberá invalidar índices, cachés, contexto preparado y sesiones afectadas; esos mecanismos no existen aquí.

## Selección futura de contexto

El flujo futuro debe autenticar al principal antes de abrir una partición, validar instalación y grants vigentes dentro de una frontera confiable, filtrar records privados y compartidos antes de leer su contenido, y solo entonces construir el contexto para el modelo. Nunca debe cargar todo el store para pedirle al modelo que oculte datos ajenos. La selección implementada es solamente un contrato hipotético de referencias y no está conectada al context provider real.

Cada solicitud vuelve a evaluar el principal y el snapshot. El módulo no conserva contexto ni reutiliza resultados entre llamadas; una llamada para un miembro diferente produce un conjunto independiente de IDs. La sesión autenticada, vigencia, revocación durable y consistencia atómica con el store deberán comprobarse por el futuro runtime. Los IDs de principal de estas fixtures no autentican a nadie.

## Pruebas y límites

`test/memory-isolation-contract.test.js` utiliza únicamente descriptores y contenido ficticios. Comprueba Owner y miembros aislados, el rol Owner sin bypass, recuerdos sobre terceros privados por defecto, shares exactos para recipients distintos dentro de una misma partición sin exponer referencias hermanas, revocación, identidades ausentes, instalaciones incorrectas, IDs manipulados, propietarios contradictorios, duplicados, records compartidos huérfanos, contaminación de contexto por cambio de principal y DENY incondicional en modo ejecución. Un ALLOW solo indica que una fixture pasa el selector hipotético; no demuestra autenticación ni acceso real.

Esta etapa no cambia Schema v5, repositorio, MemoryService, contexto real, herramientas, permisos, agentes, datos personales ni backend. No crea usuarios, grants o dispositivos reales, y no ofrece almacenamiento aislado. Los descriptores comparten IDs con el vocabulario del dominio, pero no son una migración del modelo de assertions existente.

## Riesgos y dependencias pendientes

- **Bloqueante para operación multiusuario:** proveedor nativo de identidad, sesiones verificables y registro durable Owner-first con control de revocación/épocas.
- **Bloqueante para persistencia separada:** esquema y repositorio transaccional que registren propietario, instalación, partición y referencias compartidas; las rutas genéricas actuales no implementan este aislamiento.
- **Bloqueante para compartir real:** consentimiento verificable por operación/record, autorización durable, historial de revocación e invalidación de cachés/contextos.
- **Bloqueante para contexto:** autorización aplicada antes de leer o serializar contenido; no basta filtrar IDs después de cargar el store.
- **Privacidad pendiente:** política de conservación de shares revocados, tratamiento de backups, exportaciones y copias ya vistas.

No se debe activar Memory2 personal, habilitar Automatic Memory ni conectar C.5g.3 a la conversación hasta resolver estas dependencias con revisión de seguridad específica.
