# M.1c — Harness aislado de WebAuthn: preparación y mocks

## Alcance y estado

M.1c añade un simulador de protocolo para `node:test`, ubicado en `test/support/` y ejercitado desde `test/memory-m1c-webauthn-harness.test.js`. No es un proveedor de autenticación, un verificador WebAuthn de producción ni un emisor de sesiones. No se importa desde `src/`, el agente, el dispatcher o las herramientas. No accede a red, archivos de identidad, procesos externos, Windows Hello ni Windows Credential Manager.

El arnés usa claves EC P-256 sintéticas en memoria para demostrar la comprobación de firmas de assertions y una prueba de posesión específica del simulador para el registro. La prueba de registro **no es una attestation WebAuthn**: no valida origen de hardware, certificación, fabricante, biometría ni identidad humana. La asociación resultante se etiqueta `hypothetical_synthetic`. Aunque el simulador verifica una firma, eso solo demuestra que el fixture sintético correspondiente pudo producir una respuesta coherente.

Todas las salidas de decisión/verificación incluyen `executable: false`, `persistencePerformed: false` y `authorization: DENY`; una solicitud de ejecución siempre se rechaza. Las estructuras de request/response del protocolo sintético son fixtures, no resultados de autorización. El estado de ceremonias y credenciales vive únicamente en mapas efímeros. El módulo no crea ni modifica identidades reales.

## Contratos simulados

Una ceremonia conserva en estado privado del arnés: instalación, principal sintético, propósito, huella de operación, RP ID, origen esperado, challenge, hora de emisión y expiración, estado de consumo, credencial y requisito de verificación de usuario. Los identificadores deben usar el prefijo `test_`. El request visible al autenticador sintético lleva el challenge, RP ID, contexto de origen simulado, tipo de ceremonia, requisito UV y vencimiento; nunca lleva una clave privada.

El simulador separa estas acciones:

1. Crear un autenticador sintético efímero con par de claves P-256.
2. Emitir una ceremonia de registro o assertion ligada al contexto exacto.
3. Producir una respuesta sintética con challenge, origen, datos del autenticador y firma.
4. Verificar los campos, RP ID hash, presencia de usuario (UP), verificación de usuario (UV) cuando se exige y firma.
5. Crear solo una asociación estructural a un principal de prueba; no un vínculo de identidad autenticado.
6. Denegar por separado cualquier intento de ejecución real.

Las assertions usan la forma de datos firmados de WebAuthn para probar el enlace entre client data, authenticator data y clave pública. Esto no convierte la implementación en un verificador completo: no valida attestation de registro, extensiones, metadatos de autenticadores, todos los algoritmos, reglas de origin para una aplicación nativa ni las peculiaridades de Windows. El contador solo es una comprobación auxiliar del fixture; no debe usarse como prueba universal contra replay, porque algunos autenticadores sincronizados no mantienen contadores tradicionales.

La fuente aleatoria inyectable existe para controlar fixtures. El arnés conserva los challenges emitidos y rechaza colisiones dentro de una instancia; tras ocho colisiones consecutivas falla cerrado. Los IDs de ceremonia también se comprueban contra los ya existentes. Un generador determinista de tests no tiene seguridad criptográfica y jamás debe emplearse en runtime. En un host real el desafío debe generarse con CSPRNG del sistema, ligarse a una operación y consumirse atómicamente.

## Fallo cerrado y consumo

La verificación consume la ceremonia antes de inspeccionar campos controlados por la respuesta cuando puede identificarla sin ejecutar getters. Un challenge expirado, alterado, asociado a otro principal, instalación, propósito, huella, RP ID u origen, una credencial desconocida/revocada, firma inválida, falta de UP/UV, cancelación, timeout, denegación o estado ambiguo no permite reintentar el mismo identificador. Una entrada Proxy malformada con ID de ceremonia conocido también consume antes de ser rechazada; una entrada sin un ID de datos seguro no puede identificar qué ceremonia invalidar. Una excepción del verificador produce rechazo y consume la ceremonia. Se necesita una ceremonia nueva. Una expiración usa el reloj inyectado en la fixture para que el resultado sea comprobable.

Los tests cubren registro y assertion aceptados como sintéticos, challenge alterado, expirado, colisionado y repetido, reuso de una assertion aceptada, cruces de instalación/principal/propósito/operación, RP ID hash u origin incorrectos, sustitución de clave pública, credencial revocada/desconocida, firma inválida, excepción del verificador, ausencia de UP/UV, claims `verified` añadidos, entradas malformadas, terminaciones, ejecución denegada y flags no ejecutables/no persistentes. También comprueban que las entradas no mutan, recorren los módulos de `src/` y comprueban que ninguno importa el harness. La prueba de aislamiento es una verificación estática acotada; no prueba que un paquete arbitrario no pueda acceder a la red o al sistema de archivos.

La opción de inyección `signatureVerifier` sirve solo para probar el manejo de una excepción del verificador. Un resultado de esa función no se expone como credencial ni como autorización y no debe copiarse a una composición productiva.

## Límites de confianza

- Una fixture, un SID, una etiqueta, un principal declarado o una respuesta de tool no autentican personas.
- El challenge correcto y una firma sintética no autorizan ninguna operación de Nexa.
- Registro de credencial, autenticación, autorización, consentimiento y escritura son etapas distintas. M.1c simula consistencia de protocolo y no implementa las otras etapas.
- No existe almacenamiento durable, protección contra carreras entre procesos, revocación persistente, estado de sesión, bootstrap Owner, recuperación ni resistencia a restaurar una copia antigua.
- La compatibilidad de RP ID/origen para una aplicación nativa local sigue sin resolverse en Windows real.

## Interfaces conceptuales del futuro host

El diseño futuro separa Desktop, autoridad local, host nativo WebAuthn, verificador y runtime Node. El modelo y las tools no reciben acceso a los canales de autenticación.

```text
Desktop confiable ── solicitud acotada ──► Autoridad local
      │                                      │ challenge/operación
      │ interfaz visible                    ▼
      └──────────────────────────────► Host nativo Windows
                                             │ respuesta nativa
                                             ▼
                                     Verificador mantenido
                                             │ resultado acotado
                                             ▼
                                        Runtime Node
```

Esquema conceptual de request:

```text
{ ceremonyId, installationId, purpose, operationFingerprint,
  challenge, rpId, expectedOrigin, expiresAt, requireUserVerification }
```

Esquema conceptual de response: un estado tipado (`verified`, `cancelled`, `timed_out`, `denied` o `error`) y, solo en la respuesta interna de éxito, el resultado verificado que la autoridad necesita. No se devuelven claves, tokens genéricos ni capacidades al renderer, modelo o tools. El host no debe aceptar del modelo un HWND, RP ID, principal o propósito. La autoridad limita la operación y su vigencia, y el host obtiene la ventana desde su propio contexto de UI; un HWND recibido de un caller no es confiable por sí solo.

Los códigos de fallo recomendados incluyen `request_invalid`, `challenge_expired`, `challenge_replayed`, `context_mismatch`, `rp_id_mismatch`, `origin_mismatch`, `credential_unknown`, `credential_revoked`, `signature_invalid`, `user_presence_required`, `user_verification_required`, `cancelled`, `timed_out`, `denied`, `native_host_unavailable` y `state_ambiguous`. No se debe convertir un resultado ambiguo o una pérdida de respuesta en éxito.

Antes de implementar el host debe resolverse cómo se aplica el límite RP ID/origen en la llamada nativa. El contrato del navegador WebAuthn y un API nativo no son intercambiables por asumir que ambos validan un origin de navegador. También deben probarse HWND, presentación del diálogo del sistema, cancelación, expiración, autenticadores externos/sincronizados y las políticas de contador en el Windows 11 objetivo.

## Preparación del spike nativo futuro

Un futuro M.1d debería ser un harness separado, con instalación y principal ficticios, y una RP de prueba elegida expresamente. Debe probar registro y assertion de Windows Hello, una credencial FIDO2 externa si está disponible, challenge/origin/RP incorrectos, challenge repetido, credencial desconocida, UP/UV, firma, cancelación, timeout, cierre de UI y fallo/ambigüedad del host. Ningún resultado debe conectarse a Memory2 o crear un Owner.

Ese spike debe documentar cómo limpiar la credencial de prueba desde la interfaz del autenticador/sistema antes de registrar una; no debe borrar credenciales del usuario automáticamente. M.1c no ejecuta diálogos, no registra credenciales ni cambia ajustes de Windows. El proceso de limpieza específico depende de la API y del autenticador, y queda por verificar en el spike real.

No se añadieron dependencias. El harness usa exclusivamente `node:crypto` y utilidades estándar de `node:test`. No se seleccionó aún una biblioteca mantenida para verificar respuestas reales: hacerlo requiere comprobar compatibilidad con el formato de respuesta nativo de Windows, RP ID/origen, algoritmos admitidos, mantenimiento y política de actualizaciones antes de aprobar el host.

## Auditoría M.1c y validación

La auditoría añadió controles de colisión de challenge/ID de ceremonia y rechazo seguro de excepciones del verificador, junto con regresiones adversariales para challenges repetidos, replays, cambio de contexto, clave sustituida, claims `verified`, entradas con getters y falta de mutación. No se encontró una ruta desde el runtime productivo al arnés.

En la primera ejecución, tests existentes que crean repositorios sintéticos con `os.tmpdir()` recibieron `EPERM` al resolver el directorio temporal dentro del área temporal gestionada por el sandbox. No era un error de la validación de Memory ni una lectura de datos personales. Las pruebas registran limpieza con `t.after`; los directorios identificados en el fallo no existían al comprobarlos después. La repetición bajo acceso normal a los temporales fue satisfactoria. No se cambiaron permisos globales y no quedaron directorios `nexa-auto-audit-*` en las ubicaciones comprobadas.

Resultados finales después de las correcciones: harness M.1c, **18/18**; identidad/autorización C.5f/C.5g, **43/43**; Automatic Memory, **236/236**; Memory, **308/308**; suite completa, **774/774**. También pasan sintaxis, whitespace y `git diff --check`. Los tests usan claves y repositorios sintéticos; no se ejecutaron procesos de autenticación del sistema.

## Estado del sistema

Las pruebas de esta etapa usan datos sintéticos y no hacen llamadas a OpenAI ni escrituras de recuerdos. El proveedor de Windows Hello productivo continúa devolviendo `unavailable`. El agente mantiene la evaluación automática desactivada. Memory1 continúa como backend efectivo y de solo lectura para escrituras desde el agente; Memory2 permanece inactiva y no existe `data/memory-v2.json`.

Memory1 conserva su SHA-256 esperado. `NEXA_MEMORY_BACKEND` está sin definir y el backend efectivo es `memory1`; `data/memory-v2.json` no existe. Automatic Memory sigue desactivada. Este batch no modifica Nexa Desktop, no inicia bootstrap Owner, no crea sesiones productivas, no añade dependencias y no ejecuta ceremonias de Windows Hello. Cualquier spike nativo futuro requiere aprobación y aislamiento independiente.
