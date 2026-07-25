# gbrain — operación: el sótano

> **El sótano de la skill `gbrain`.** La skill es la puerta: corta y operativa. Aquí vive el detalle.
> **Actualizado al cierre de F0 · 25-jul-2026.** Se actualiza en el cierre de **cada** fase del plan.

## Qué hay aquí y qué no

Aquí van: las rutas reales, el porqué de cada falla con la medición que la probó, el plan de arreglo por fases, y los bancos de preguntas con sus resultados. **La skill no duplica nada de esto** — apunta aquí, para no mentir en el primer cambio.

## Estado del sistema (F0)

**Dos instalaciones, mismo código, fallas distintas que convergen en el mismo silencio.**

| | PC (Claudio) | VPS (Claudy) |
|---|---|---|
| versión | 0.42.59.0 | 0.42.59.0 |
| marcador de esquema | `config.version = 122` | `122` |
| parches locales | 5 (mismos blobs, distinto SHA) | 5 |
| `unaccent` | ausente | ausente |
| latencia de vectorizado | ~0.037 s | ~5.6 s |
| brazo vectorial | vivo (por proveedor rápido) | **muerto** (pierde la carrera del plazo) |
| expansión de consultas | **muerta** (proxy caído + dirección sin sufijo de versión) | viva |

Upstream va en **0.42.66.0**, 349 commits adelante.

## Los defectos, con su evidencia

- **D1 — el sincronizador por MCP ignora el archivero del contexto** y escribe al de por defecto. Medido: 34 páginas duplicadas, y tres importaciones registradas en el log de ingesta. Sigue igual río arriba.
- **D2 — el brazo vectorial se cae por un plazo de 6 s y degrada en silencio.** Medido con control positivo: cuatro preguntas dan 0 con el plazo por defecto y 1-2 con el plazo alto, determinista al limpiar caché. **Presente en las dos instalaciones**; en la PC está latente por proveedor rápido.
- **D3 — el índice léxico analiza en inglés sobre corpus en español.** Tres defectos que se suman: exigencia de todos los términos, palabras vacías del español tratadas como datos (85% de los fragmentos contienen "que"), y sin normalización de acentos. **Río arriba ya hay idioma configurable, reindexado y repliegue de "todos" a "alguno"** — lo que falta encima es por archivero, corpus mixtos y acentos.
- **D4 — el parche del gateway puede saltarse la normalización de la dirección** y reintroducir el error de ruta. **Asimétrico:** condición cumplida en la PC (`base_urls.anthropic` sin sufijo de versión), no cumplida en el VPS. Demostración del error pendiente.
- **D5 — el parche de migración se traga cualquier error** y lo etiqueta como enlace colgante. Río arriba lo resolvieron por otra vía.
- **D6 — el tope del reordenador no entra en la firma del caché.** Cambiar el tope puede servir resultados del tope anterior.

## Las fallas silenciosas, como categoría

Todas comparten forma: **el sistema entrega algo plausible, calculado en condiciones que ya no existen, sin emitir señal.** El repliegue del vector sin rastro · el caché que sirve resultados de condiciones muertas · el tope fuera de la firma · la expansión que no corre sin quejarse · y —de nuestro lado— un comparador que ordena por clave que empata.

## Un comportamiento del motor que conviene tener claro

**El sincronizador recorre el directorio, no pregunta a git.** Verificado en el código: el escáner usa lectura de directorio, y la versión nueva de río arriba añade un filtro por visibilidad de git precisamente porque antes no existía. **Consecuencia: lo que esté en la carpeta puede entrar aunque no esté commiteado.** El commit previo es convención del pipeline, no garantía del motor.

## Dónde está cada cosa

Los documentos vivos —plan por fases, actas de cierre, diagnóstico completo del retrieval, bancos de preguntas y resultados de corridas— **no viven todos en el mismo lugar, y es a propósito**: cada instancia versiona en su casa. Este archivo es el índice; las rutas concretas se listan abajo y se actualizan al cierre de cada fase.

- **Plan por fases y actas:** en el espacio de trabajo del VPS.
- **Diagnóstico del retrieval, con cada medición y su comando:** en el espacio de trabajo del VPS.
- **Banco de preguntas del VPS:** congelado y versionado allá.
- **Banco de preguntas de la PC y su método:** en la memoria de Claudio.

## Pendientes de este documento

- [ ] Cómo **carga** cada instancia la skill (¿enlace al fork? ¿copia verificada?). Sin definir.
- [ ] Gotcha conocido: si la skill acaba dentro del árbol de skills del VPS, **necesita disparadores en el encabezado y fila en el resolvedor**, o el diagnóstico la reporta inalcanzable.
- [ ] Confirmar con Codex su fila de la tabla de instancias.
- [ ] Rutas absolutas de cada documento, cuando el plan las fije.
