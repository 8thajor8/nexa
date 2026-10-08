# Automatic Memory C.5g.1 — contratos de identidad Owner-first

## Alcance implementado

C.5g.1 añade contratos de datos estrictos para preparar una instalación Owner-first. No crea cuentas, no autentica personas, no inicia el bootstrap, no vincula identidades con Memory2 y no concede permisos. El módulo `src/core/identity-contracts.js` no está conectado al agente, a las tools, al repositorio, al contexto de memoria ni al escritor de Automatic Memory.

Los validadores comprueban forma y coherencia estructural; un objeto que los supera sigue siendo una declaración de datos, no prueba de autenticidad. La validación de un directorio no garantiza unicidad atómica, resistencia a carreras ni autorización efectiva: solo una implementación posterior con almacenamiento durable, transacciones/locking y un proveedor de confianza podría establecer esas propiedades. En particular, no hay emisor de sesiones confiables, capacidades administrativas o grants en producción. Las funciones de decisión de bootstrap, autorización administrativa y acceso a memoria deniegan siempre porque aún no existe un proveedor nativo confiable.

## Modelo de identidad

- **Instalación:** identificador UUID estable, estado de bootstrap, único slot `ownerPrincipalId` y época Owner. La validación exige cero Owners antes del bootstrap y exactamente un Owner activo después. La sustitución silenciosa del slot no es una operación implementada.
- **Principal:** identificador estable separado de cualquier persona de Memory, estado de cuenta, rol, estado/nivel/método de autenticación, vínculo opcional con una persona de Memory y época de cuenta. El nombre visible no es un identificador ni una prueba.
- **Owner / Member:** roles administrativos de una instalación. `role: owner` es solo un campo estructural validado y no habilita acciones. Los Members no pasan la validación del slot Owner.
- **Sesión y dispositivo:** contratos incluyen principal, instalación, época de cuenta, caducidad/revocación y vínculo de dispositivo opcional. Su estructura no verifica quién controla la sesión o el dispositivo.
- **Memory Self:** `self_person_id` conserva su semántica actual: identifica la persona Self del store. No se redefine como Owner, principal autenticado ni permiso. La identidad administrativa y el ID de persona usan dominios distintos.
- **Atribución:** los contratos distinguen hablante, sujeto del recuerdo y principal aportante. Una señal de voz puede describir una coincidencia probabilística, pero no autentica ni asigna autoridad.

El alcance contempla inicialmente un Owner único y Members futuros; no añade jerarquías empresariales, stores ni campos al Schema v5.

## Bootstrap y acciones administrativas

El estado puede describir una instalación no inicializada, pendiente, activa o en recuperación. Sin un proveedor nativo con autenticación humana fuerte y confirmación independiente, `evaluateOwnerBootstrap()` deniega incluso ante un objeto que afirme `verified: true`. No existe bootstrap real ni protección de concurrencia de un registro persistente porque no se implementa registro. La regla de un Owner es una invariante de validación para un snapshot individual; no impide que dos procesos concurrentes acepten cambios incompatibles ni vuelve atómica la creación o transferencia del Owner.

Se enumeran contratos para invitación, aprobación de vínculo, concesión/revocación de permisos, suspensión/revocación de usuarios, vinculación/revocación de dispositivos y recuperación del Owner. La validación de la solicitud no ejecuta ni autoriza estas acciones: `evaluateAdministrativeAuthorization()` devuelve denegación. La futura implementación necesitará autenticación reforzada según acción, autorización limitada a la operación exacta, confirmación fuera del modelo, revalidación de cuenta/época/instalación al ejecutar, protección de replay y auditoría resistente a manipulación.

## Privacidad y acceso a memoria

El rol Owner administra la instalación, pero no concede por sí solo acceso a recuerdos privados. `evaluateMemoryScopeAccess()` permanece cerrado hasta que exista un proveedor que resuelva permisos explícitos por principal, persona, ámbito y operación. No se añaden scopes efectivos ni se alteran los permisos actuales de herramientas. La separación futura deberá cubrir recuerdos personales, privados y compartidos, con denegación predeterminada.

## Seguridad comprobada y límites

Las pruebas sintéticas verifican invariantes de forma: un solo Owner; independencia entre Owner y Self; rechazo de registros ambiguos o contradictorios; distinción de speaker/subject/contributor; campos estrictos; y denegación de bootstrap, administración y acceso privado incluso ante claims con aspecto válido. También comprueban que no se exportan emisores o consumidores de capacidades.

Esto no es una prueba de autenticación ni de autorización de producción. No existe un proveedor nativo verificado de Windows Hello/passkey, registro de cuentas, almacenamiento de identidades, bootstrap atómico, recuperación segura del Owner, sesiones revocables operativas, dispositivo confiable, auditoría administrativa ni permisos multiusuario. Los datos sintéticos viven en tests y no se convierten en credenciales de runtime.

La arquitectura actual de C.5f sigue tratando la sesión local de stdin como origen local no autenticado; SID de Windows no equivale a autenticación. El proveedor de Windows Hello continúa fallando cerrado. No se crean vínculos Self reales.

## Etapas posteriores

- **C.5g.2:** proveedor nativo de autenticación, registro durable, bootstrap exclusivo y recuperación Owner; requiere revisión específica de amenazas y concurrencia.
- **C.5g.3:** vínculos principal-persona, sesiones/dispositivos revocables y permisos administrativos y de memoria; no cambiar globalmente `self_person_id` sin un diseño de compatibilidad con Memory2.
- **C.6:** integración conversacional de Automatic Memory solo después de definir consentimiento, ámbito por usuario, confirmación independiente y acceso seguro a memoria. La detección `auto_save` nunca equivale a autorización.
- **Voz y dispositivos:** identificación de hablante es una señal separada; no implementar reconocimiento, biometría o enrolamiento como autenticación en esta etapa.

Decisiones aún necesarias incluyen proveedor y garantías de autenticación fuerte; recuperación del Owner y protección frente a apropiación; política de permisos administrativos; tratamiento de recuerdos privados ante solicitudes del Owner; definición de memoria compartida; retención/auditoría y respuesta ante compromiso de un dispositivo.

## Estado

Memory1 sigue siendo el backend predeterminado. No se modifican Memory1 ni Schema v5, no se crea `data/memory-v2.json`, no se ejecuta bootstrap, no se activa Memory2 o Automatic Memory, y no se conecta el módulo a agente, tools o escritura.
