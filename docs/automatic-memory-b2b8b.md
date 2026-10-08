# Automatic Memory B.2b.8b — Frontera transaccional autorizada

## Alcance

B.2b.8b añade `commitAutomaticOperation()` al repositorio JSON. El método solo acepta la frase original, propuesta no confiable, snapshot de planificación, índice de operación, destinatario y capability opaca emitida por el coordinador B.2b.7. No acepta assertion, evidence, source, receipt ni un lote libre de cambios. Recalcula el contrato B.2a y el fingerprint antes de persistir.

La funcionalidad permanece aislada: ningún agente ni tool importa el coordinador o llama al método. No cambia el backend efectivo, no migra datos y no conecta Automatic Memory al flujo conversacional.

El contrato B.2b.1 continúa denegando claims sintéticos. El writer no interpreta `authorization.granted`, provenance ni request IDs como autoridad; exige la capability opaca del coordinador B.2b.7. La sesión local sigue sin probar una identidad humana.

## Snapshot y sección crítica

`readSnapshot()` conserva el digest SHA-256 de bytes que utiliza el CAS del repositorio. `readAutomaticMemorySnapshot()` entrega el mismo store/revisión con el fingerprint semántico JSON que espera el planificador B.2a. El escritor valida esa huella semántica contra el store leído bajo el lock; el repositorio continúa usando su digest de bytes, lock y comprobación de revisión para detectar ediciones y coordinar escritores.

Dentro de la cola y sección crítica del repositorio, el método:

1. Recalcula operación, clave de idempotencia y fingerprint desde texto, propuesta y snapshot.
2. Busca recibos por clave y fingerprint. Un `applied` idéntico devuelve solo `already_applied`, sin capability ni mutación. Una colisión falla cerrada.
3. Consume mediante el verificador real de B.2b.7. El primer intento consume la capability incluso si falla el binding o la revisión. Un identificador de solicitud no autoriza.
4. Compara revisión y fingerprint del snapshot con el estado actual. No replanifica conflictos.
5. Construye internamente records con provenance `inference`/`derived_untrusted` y `data_only`, y aplica assertion, source, evidence y recibo a un único candidato validado y una sola revisión.

El texto completo y las capabilities no se almacenan. Evidence conserva metadatos, no la cita textual. El valor de assertion es el contenido aprobado y el recibo solo guarda hashes, IDs, revisión y request ID requerido por Schema v5.

## ADD y REPLACE

ADD solo agrega una assertion nueva y nunca altera otras assertions. REPLACE requiere el target exacto del plan confirmado, todavía activo, con sujeto Self y predicate compatibles; marca únicamente ese record como `superseded`, conserva sus fuentes/evidence y añade la nueva assertion con `supersedes` al target. Una revisión obsoleta o un target cambiado no se sustituye por otro destino.

La policy, normalización, verificación de evidencia y secret screening se vuelven a ejecutar desde los inputs. El modelo no elige IDs canónicos, estado, provenance ni receipt. La sesión de `stdin` sigue representando origen local observado, no identidad humana autenticada.

## Protección de recibos

`repository.commit()` rechaza cualquier `put` de `automatic_operations`; también rechaza su eliminación. No se permite crear, reemplazar o borrar receipts por el camino genérico. El método autorizado es el único writer de receipts en el repositorio JSON y estos se agregan append-only.

Las escrituras manuales y la migración explícita mantienen `commit()` para sus colecciones legítimas. Esto no convierte a `commit()` en una frontera contra módulos internos arbitrarios: como documenta B.2b.8a, el handle genérico y el repositorio siguen siendo APIs internas de confianza y no se exponen al agente/tools. Un writer externo que ignore el lock tampoco queda protegido.

## Resultados y límites

- `applied`: el snapshot actualizado contiene assertion, evidence, source y recibo juntos.
- `already_applied`: existe un receipt aplicado con la misma clave, fingerprint y operación; respuesta de solo lectura.
- Revisión/target obsoletos, inputs inválidos o authorization inválida: no se escribe; la capability no se restaura.
- Error antes de reemplazar el archivo: el comportamiento usa la ruta de persistencia existente y no devuelve un resultado de éxito.
- Error alrededor del reemplazo: se conserva el manejo actual del repositorio (`memory_commit_uncertain` o reconciliación si el reemplazo se puede verificar). El receipt permite una consulta posterior, pero los escenarios adversariales de respuesta perdida, fallos físicos y concurrencia entre instancias requieren la etapa B.2b.8c.

No se afirma exactly-once ante fallos físicos ni durabilidad universal. Los locks coordinan escritores cooperantes. La integración con el agente, la activación de Memory2 y migraciones personales requieren revisiones separadas.

## Pruebas

`test/memory-automatic-transaction.test.js` usa procesos hijos con stdin sintético y repositorios v5 temporales. Comprueba ADD, REPLACE y preservación del historial, receipt y evidencia en una revisión, replay de solo lectura, falta de capability, rechazo de recibos genéricos, conflicto de snapshot con capability consumida y ausencia de cambios tras rechazo. Las pruebas no usan datos personales ni llamadas de red.
