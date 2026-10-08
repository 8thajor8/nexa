# C.5g.4 — contratos hipotéticos de dispositivos y sesiones

## Alcance y relación con las etapas anteriores

`src/core/device-session-lifecycle.js` añade validación estricta de snapshots y transiciones puras en memoria. Reutiliza los contratos de instalación, Owner, principal, sesión y dispositivo de C.5g.1, y consulta el motor hipotético C.5g.2 para las acciones administrativas. No está conectado al agente, a herramientas, al repositorio de memoria ni a proveedores de autenticación. C.5g.3 continúa siendo un contrato separado de selección de referencias de memoria.

Los resultados `ALLOW` indican únicamente que una transición de datos sintéticos es internamente consistente; siempre incluyen `executable: false`. Toda entrada con `mode: execution` produce `DENY`. Ni `role: owner`, ni el nombre visible de un dispositivo, UUID declarado, SID, IP, contenido del modelo, voz o fixture demuestran identidad. Evidencia de autenticación solo se representa como `unverified` y `synthetic_fixture`.

## Modelo

- **Instalación** conserva el slot Owner de C.5g.1 y una época de instalación.
- **Cuenta y principal** tienen vínculo uno a uno, estado y época que deben coincidir exactamente. Owner y Self siguen siendo conceptos distintos.
- **Dispositivo/cliente** registra instalación, cuenta y principal, tipo de cliente extensible (`windows_desktop`, `ios_mobile`, `smartwatch`, `other`), etiqueta solo descriptiva, nivel `unverified`, estado y revisión.
- **Solicitud de vínculo** es una propuesta con vencimiento. Un dispositivo nuevo permanece `pending`; aprobación hipotética exige Owner y un requisito explícito `admin.devices` para el recurso exacto, más confirmación independiente. Esto sigue siendo una evaluación con datos declarados, no una aprobación real.
- **Sesión** liga un identificador de formato opaco (dato sintético, no secreto ni capacidad), principal, cuenta, instalación, dispositivo opcional, estados, marcas temporales, épocas, revisión de dispositivo y evidencia no verificada. No hay emisor de IDs o sesiones. Sesión sin dispositivo se permite como modalidad estructural; no puede omitir el dispositivo de una sesión que sí lo declara.

## Estados y transiciones

Dispositivo: `pending → active → suspended → active` solo requeriría una futura operación explícita; `active/suspended → revoked` es terminal en este contrato. Solicitudes pasan `pending → approved` o `pending → expired`. Una solicitud aprobada queda como historial aunque el dispositivo después se suspenda o revoque. Una solicitud expirada invalida el dispositivo pendiente.

Sesión: `active → suspended`, `active/suspended → revoked` al revocar dispositivo, y `active/suspended → expired` al expirar. Renovar crea un nuevo ID ligado al mismo principal, cuenta, instalación y dispositivo, marca la anterior como revocada y conserva una referencia `supersedesSessionId` comprobable. La sesión nueva no prueba autenticación real. La revisión esperada debe coincidir con el snapshot antes de proponer transiciones.

Las acciones hipotéticas incluyen solicitud y aprobación de vínculo, suspensión/revocación/desvinculación, renovación y expiración. La revocación invalida las sesiones activas y suspendidas vinculadas. El Owner requiere además una autorización hipotética específica; su rol por sí solo no es bypass y no otorga acceso a recuerdos privados. `unlink_device` comparte la semántica conservadora de revocación.

## Integridad y límites

El validador exige referencias únicas, vínculos account/principal/installation exactos, épocas coincidentes, vencimientos válidos, estados coherentes, dispositivo activo para una sesión activa y referencias de renovación a una sesión previa revocada del mismo vínculo. No entrega contenido personal, tokens, secretos ni capacidades.

Esto no es autenticación, almacenamiento durable, protección contra carreras, revocación atómica ni autorización efectiva. Dos transiciones hipotéticas sobre la misma revisión pueden producir propuestas válidas concurrentes; no hay serialización ni ganador canónico. Una revisión obsoleta solo se detecta contra el número declarado en el snapshot recibido, que también es dato del llamador. En consecuencia, renovaciones simultáneas, revocaciones concurrentes y uso de aprobaciones antiguas requieren un repositorio transaccional que vuelva a leer y compare la revisión bajo lock; la aprobación histórica solo documenta un evento y el reducer no la acepta como sustituto de una autorización fresca para otra acción. Los snapshots son objetos aportados por el llamador y podrían ser falsos aunque sean estructuralmente válidos. Cualquier integración futura necesita proveedores nativos verificados, almacenamiento de cuentas/dispositivos, control transaccional de épocas y revocaciones, confirmación administrativa independiente y pruebas de carrera/reinicio. Windows Hello, passkeys, attestation y señales de voz no se implementan aquí; voz solo puede ser señal de identificación y nunca autenticación suficiente por sí sola.

## Validación

Las pruebas de `test/device-session-lifecycle.test.js` usan exclusivamente fixtures sintéticas. Incluyen vínculos cruzados, estados de dispositivo, sesión expirada, rotación/renovación, revisión obsoleta, revocación de sesiones y denegación en modo ejecución. No demuestran emparejamiento, autenticación, gestión de sesión real ni acceso a memoria.
