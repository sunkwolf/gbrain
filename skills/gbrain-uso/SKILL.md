---
name: gbrain
description: Cómo usar gbrain como tu memoria — qué es, cómo se consulta, qué te miente hoy y cómo lo verificas. Úsala ANTES de consultar la memoria, antes de concluir que algo "no está", y antes de escribir en ella. Audiencia — Claudio, Claudy, Codex, Axis y cualquier agente futuro.
---

# gbrain — tu memoria, y cómo no dejar que te engañe

> **Actualizada al cierre de F0 · 25-jul-2026.**
> Describe el sistema **como está hoy**, con sus fallas vivas. No describe el que queremos. Si una falla de aquí ya está arreglada, este archivo está viejo: verifícalo y corrígelo. **Actualizarlo es parte del cierre de cada fase, no una tarea aparte.**
> **Contra qué comprobarlo:** el plan de trabajo va por fases; si la fase actual es posterior a F0, asume que algo de aquí cambió y ve al sótano (§9) antes de fiarte.

## 1. Qué es, en una línea

Tu memoria de largo plazo: fichas en markdown, versionadas en git, indexadas en Postgres, consultables por significado y por palabra. **La fuente de verdad son los archivos markdown en git**, no la base. La base es un índice — si se pierde, se reconstruye; si se pierden los archivos, se perdió la memoria.

## 2. 🔴 Lo primero, porque es lo que más caro cuesta: un vacío NO es una ausencia

**Si una búsqueda no devuelve nada, eso NO significa que el recuerdo no exista.** Hoy, en este sistema, un vacío puede ser cualquiera de estas cosas, y **ninguna avisa**:

| lo que pasó | lo que ves |
|---|---|
| el brazo semántico se cayó por tiempo y solo buscó por palabra literal | resultados pobres o cero |
| el brazo semántico ni se intentó porque el proveedor no estaba | igual |
| preguntaste en español a un índice que analiza en inglés | cero |
| tu pregunta tiene palabras que el índice trata como obligatorias | cero |
| estás consultando el archivero equivocado | cero |

**Regla: un cero se interroga, no se cree.** Antes de decirle a alguien "no tengo eso":

```
gbrain search "<una palabra sola y muy distintiva del tema>"
```

…o la herramienta **`search` por MCP**, si entras por ahí. Da igual el camino: lo que importa es preguntar corto.

Si eso devuelve resultados y tu pregunta completa devolvía cero, **el sistema está degradado, no vacío**. Reformula corto, o avísalo.

## 3. Cómo se consulta

- **`gbrain search "<texto>"`** — por palabra. Rápido y literal. Hoy analiza en **inglés** aunque el corpus esté en español: exige que **todas** las palabras aparezcan, trata "que"/"de"/"a" como obligatorias, y **no ignora acentos** (`canción` ≠ `cancion`). Frases largas dan cero muy fácil. **Úsalo con 1-3 palabras raras, no con oraciones.**
- **`gbrain query "<pregunta>"`** — híbrido: significado + palabra. Es el bueno para preguntas en lenguaje natural. **Es también el que puede degradar en silencio** (ver §2).
- **Herramientas MCP equivalentes:** `query`, `search`, `get_page`, `list_pages`. Mismo motor, mismas fallas.

**Escala solo hasta donde la tarea necesita:** puntero → página completa (`get_page`) → vecinos (`get_links`/`get_backlinks`). No cargues de más.

### Si eres X, entras así

| instancia | entra por | lo que tienes que saber |
|---|---|---|
| **Claudy** (VPS) | **MCP** (`mcp__gbrain__*`), archivero `default` | ⚠️ El `serve` cuelga de su sesión: si la sesión muere, el MCP muere con ella. Alternativa siempre disponible: la línea de comandos. **OJO: la CLI NO hereda los ajustes de entorno del `serve`** — los que importen (p. ej. plazos de espera) se pasan en cada invocación. |
| **Claudio** (PC) | **MCP**, archivero `claudio` | La CLI es un envoltorio sobre un clon fijado, no un binario instalado. 🔴 Hoy: su expansión de consultas **no corre** (el proxy configurado no responde) y la dirección del proveedor **carece del sufijo de versión**, así que levantarlo no basta. |
| **Codex** | **línea de comandos**, sin más | Su entorno suele ser de solo lectura y **sin red**: **no asumas que puede consultar la memoria viva.** Pásale los insumos en archivos. *(Observado al despacharle trabajo el 25-jul-2026; **no confirmado por él** — se confirma en el siguiente despacho.)* |
| **Axis** | *(pendiente)* | **Su instalación todavía no existe. Esta fila se llena cuando exista.** No se inventa: una tabla que describe una instalación imaginaria es un mapa que miente. |

## 4. 🔴 Qué te miente hoy, y cómo lo compruebas

Cuatro fallas medidas el 25-jul-2026. Todas comparten la misma forma: **el sistema entrega algo plausible, calculado en condiciones que ya no existen, sin emitir ninguna señal.**

1. **La búsqueda semántica se cae sola por un plazo de 6 s** y sigue de largo solo con palabra literal. No lo dice: ni campo en la respuesta, ni contador, ni bitácora. Si tu proveedor de vectores tarda más de eso, **llevas días buscando como grep sin saberlo**.
   → *Cómo lo ves:* mide cuánto tarda tu proveedor en vectorizar una frase corta. Si se acerca a 6 s, ya estás perdiendo el brazo semántico.
2. **El caché sirve resultados calculados cuando el sistema estaba sano.** Una consulta cacheada en buenas condiciones sigue contestando bien con el sistema roto.
   → *Cómo lo ves:* **para medir cualquier cosa, limpia el caché primero.** Si no, mides el caché.
3. **Un tope de configuración del reordenador no entra en la firma del caché.** Cambias el tope y puedes seguir comiendo resultados del tope viejo.
4. **La expansión de consultas puede no estar corriendo** y las búsquedas devuelven resultados igual, sin una queja. (Medido en la PC: el proxy configurado no contestaba, 4 de 4 rechazos, `stderr` vacío.)

**Regla general que sale de las cuatro: todo componente que devuelva un resultado en vez de un sí/no necesita un caso absurdo antes de creerle.** Una pregunta cuya respuesta correcta sea obvia y cuya basura sea inconfundible. Si gana la basura, el componente está roto por bonita que se vea la demo.

## 5. Los archiveros (sources) — dónde vive cada cosa

Un brain puede tener varios *sources*. **Consultar el equivocado devuelve cero sin avisar.**

- Cada agente tiene su propio source con su memoria (fichas, dailies, proyectos).
- Puede haber además espejos de solo lectura de otras máquinas.
- **El source se fija con `GBRAIN_SOURCE` en el entorno o con `--source` en la línea de comandos.**

🔴 **Trampa medida el 25-jul:** el tool MCP de sincronización **ignora el source del contexto** y escribe siempre al archivero por defecto, aunque el entorno diga otra cosa. **No uses el atajo MCP para sincronizar.** Usa la vía de línea de comandos con `--source` explícito, o el script canónico de tu instalación.

## 6. Escribir en la memoria

- Se escribe **el archivo markdown**, se commitea, y **luego** se sincroniza con el script canónico de tu instalación.
- 🔴 **Ojo con lo que NO hace:** en esta versión el sincronizador **recorre el directorio, no pregunta a git** (verificado en el código: el escáner usa lectura de directorio, y la versión nueva de río arriba añade un filtro por visibilidad de git precisamente porque antes no lo había). **Todo lo que esté en la carpeta del archivero puede entrar, esté commiteado o no — basura incluida.** El commit antes de sincronizar es convención de los pipelines canónicos, no una garantía del motor.
- Una ficha por hecho. Enlaza a las relacionadas con `[[nombre]]`.
- **Antes de crear, busca.** Duplicar una ficha es peor que no tenerla: dos versiones que se contradicen y que después hay que reconciliar a mano.

## 7. Protocolo para medir cualquier cosa de la memoria

Si vas a comparar antes/después, o a decidir si algo mejoró:

1. **Limpia el caché de consultas** antes de cada corrida completa.
2. **Registra las condiciones**: máquina, fecha, configuración vigente, y la latencia del proveedor de vectores ese día. Sin eso, en una semana nadie sabe interpretar el número.
3. **Usa preguntas parafraseadas**, sin las palabras exactas de la fuente. Si la pregunta trae las palabras del documento, acierta el brazo literal y **el semántico ni se examina**.
4. **Ten un control que muerda**: incluye a propósito un caso que DEBE fallar. Un verificador que nunca ha reprobado a nadie no está probado.
5. **Que la respuesta no viva en el nombre del archivo.** Si la ficha se llama igual que la pregunta, mediste el nombre, no la memoria.

## 8. Errores que ya cometimos — no los repitas

- **Ordenar una huella de verificación por una clave que puede empatar.** Da "difieren" con datos idénticos. Ordena por clave única y **declara cuál**.
- **Extrapolar de un caso verificado a los demás.** Se comprobó un defecto contra la versión nueva y se supuso que los otros seguían igual; dos ya estaban arreglados río arriba. **Un predicado de ausencia necesita un instrumento por cada cosa que se afirma ausente.**
- **Reescribir un documento desde cero en vez de compararlo contra lo ya acordado.** Se pierden justo los acuerdos de la ronda anterior, que es cuando más caro sale.
- **Creerle al letrero.** Un servicio puede anunciar un modelo y estar sirviendo otro. Mide el comportamiento, no leas el nombre.

## 9. Dónde está el detalle (el sótano)

Esta skill es la **puerta**: corta, operativa, para saber qué hacer y qué no creerte. El **sótano** —el porqué de cada falla, las mediciones que la probaron, las rutas reales de archiveros, repositorios y parches, y el plan de arreglo— vive en:

> 📁 **`docs/gbrain-operacion/` dentro de este mismo repositorio.**

**Esa es la única ruta dura de este documento, y es a propósito.** Todo lo demás —rutas de repos, nombres de archiveros, versiones, puertos— vive allá y se actualiza con el plan. Si estuvieran aquí, este archivo mentiría en el primer cambio; si no estuviera ninguna, no sabrías dónde buscar.

**Si algo de aquí no te cuadra con lo que ves: gana lo que ves.** Mídelo, y corrige este archivo.
