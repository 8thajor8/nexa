# Memory D.4 — Consolidación conservadora de recuerdos

## Alcance

D.4 agrega una evaluación pura, acotada y de solo lectura para proponer pares de assertions que podrían revisarse como duplicados o como evidencia adicional. Reutiliza el Schema v5, D.1 para vigencia e intención, D.2 para validar relaciones y D.3 para temporalidad y conflictos. No modifica el esquema, repositorios, servicios, Memory1 ni la ruta de escritura B.2b.

La API evaluateConsolidation() recibe registros completos de fixture con assertion, pares evidence/source, asOf, intent, scopeLabel y endpoints de entidad nulos o explícitos. Exige un conjunto acotado (hasta 100 registros), un único sujeto, ámbito declarado e instante de referencia, IDs únicos y referencias de evidencia consistentes. Para relaciones, exige intent: "fact" y endpoints validados por D.2. El caller debe autenticar, autorizar y filtrar previamente los datos a una sola partición; scopeLabel es una etiqueta declarada, no prueba de autorización ni aislamiento.

## Clasificaciones

- exact_duplicate: assertions activas con contenido semántico idéntico, ignorando solo su ID y recorded_at, y con metadatos de evidencia equivalentes. La propuesta enumera las referencias de evidencia que deben conservarse y ambos IDs para preservar el historial.
- additional_evidence: assertions semánticamente idénticas con referencias de evidencia o procedencia distintas. La propuesta requiere retener todas las referencias; esto no demuestra que las fuentes sean independientes ni que el hecho sea verdadero.
- equivalent_by_explicit_rule: solo se puede producir con una regla inyectada synthetic_test_only, limitada a predicados test.*, fingerprints SHA-256 exactos de objetos, misma compatibilidad y assertions actuales de intención fact. Es una ruta de prueba; no existen reglas reales de equivalencia ni se admite semejanza textual.
- temporal_distinction: D.3 detecta intervalos definitivamente disjuntos, o D.4 detecta límites de vigencia distintos. Las afirmaciones permanecen separadas.
- potential_conflict: D.3 lo produce únicamente con una regla sintética explícita aplicable. No se genera propuesta de consolidación.
- related_not_equivalent: predicados distintos o relaciones con endpoints diferentes. La cardinalidad múltiple de partner_of no convierte enlaces diferentes en duplicados.
- insufficient_information: falta una equivalencia demostrable, las afirmaciones tienen intenciones distintas, la vigencia difiere o una relación no es idéntica.

Los registros superseded nunca se colapsan: se informa que el historial debe seguir separado. Un plan y un hecho no se tratan como la misma ocurrencia. La ausencia de conflicto no demuestra equivalencia. Valores diferentes no se consolidan sin una regla explícita, y ninguna similitud lingüística se usa como criterio.

## Preview y conservación

Un resultado con propuesta incluye IDs de assertions, tipo de redundancia, reason codes, IDs de evidencia/source que deberían conservarse, IDs cuyo historial debe seguir disponible, riesgos y reviewRequired: true. No incluye valores, nombres, texto de evidencia, locators ni huellas de los valores. Los IDs son datos del conjunto consultado y solo deben exponerse a un consumidor autorizado.

Cada comparación y propuesta tiene executable: false y persistencePerformed: false. El modo execute devuelve DENY sin comparaciones. D.4 no elimina, fusiona, reemplaza ni reescribe datos. Los previews son sugerencias para revisión; no autorizan una operación futura.

La entrada puede no contener todo el repositorio. Por eso las referencias de historial enumeradas son solo las del par observado; antes de cualquier implementación posterior habría que comprobar todas las referencias de supersession, recibos, evidencia, backups y otros dependientes en el snapshot autoritativo. No se afirma que una combinación de records sea transaccional o segura para persistir.

## Detección existente reutilizada

El planner de Automatic Memory ya detecta una assertion activa exactamente duplicada durante la planificación y la clasifica como DUPLICATE; el catálogo de relaciones detecta enlaces directos duplicados al consultar un subgrafo. Esos mecanismos responden a flujos concretos y no son un servicio general de consolidación. D.4 no los reemplaza ni conecta a Automatic Memory. El repositorio protege recibos de Automatic Memory, pero no ofrece una operación general para fusionar assertions ni evidencia.

## Privacidad y límites

La capa no abre stores, no autentica sujetos, no resuelve Self, no concede permisos y no selecciona particiones. Rechaza mezclas detectables de sujetos, ámbitos declarados e instantes, pero no puede descubrir una mezcla oculta o etiquetada uniformemente. El filtro por autorización debe ocurrir antes de invocarla. D.4 no accede al agente, CLI, Automatic Memory ni escritor.

Las reglas de equivalencia y exclusividad aceptadas por esta API son únicamente catálogos explícitos de test y predicados test.*; no extienden Schema v5 ni el catálogo real de predicados. Sin un conjunto previamente autorizado y completo no se debe interpretar la salida como inventario de duplicados del usuario.

## Pruebas y validación

test/memory-consolidation-semantics.test.js usa fixtures sintéticas y cubre duplicados, evidencia distinta, equivalencias explícitas de test sin cierre transitivo entre evaluaciones independientes, diferencias temporales y de precisión, plan frente a hecho, conflictos potenciales, relaciones con endpoints distintos, sujetos/ámbitos/tiempos cruzados, historial superseded y referencias externas de supersession no verificadas, evidencia o fuentes duplicadas/inconsistentes, entradas inválidas, orden estable, ausencia de mutación, redacción de valores sensibles y denegación de ejecución.

Estas pruebas validan solo las funciones puras y la forma de sus previews. No prueban autenticación, autorización, aislamiento de almacenamiento, verdad de fuentes, consumo único, resolución de conflictos en producción ni seguridad de una escritura futura.
