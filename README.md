# 🎡 Ruleta Mundial

App web *vanilla* (HTML + CSS + JS, sin build ni dependencias) que genera una
**ruleta de resultados** para los partidos del Mundial usando las
probabilidades implícitas de **Polymarket**.

Cada partido se descompone en hasta tres secciones — **Equipo 1**, **Empate**
y **Equipo 2** — y el ángulo de cada sección equivale a la probabilidad
implícita de ese resultado según el mercado. Al girar, la ruleta aterriza de
forma uniforme: como los sectores ya están dimensionados por probabilidad, el
resultado queda **ponderado por los odds** automáticamente.

## Uso

No requiere servidor ni instalación. Basta con servir los archivos estáticos:

```bash
# opción 1: abrir directamente
xdg-open index.html      # (o doble clic)

# opción 2: servidor local (recomendado)
python3 -m http.server 8000
# luego abrir http://localhost:8000
```

1. La app consulta la **Gamma API** de Polymarket (`gamma-api.polymarket.com`),
   pública y con CORS habilitado — no necesita backend ni API key.
2. Elige un partido en el menú desplegable.
3. Pulsa **Girar**.

## Cómo funciona

- **Descubrimiento**: resuelve la(s) etiqueta(s) del Mundial por slug
  (`world-cup`, …) y pide sus eventos activos. Si no encuentra la etiqueta,
  cae a un escaneo de eventos filtrando por palabras clave.
- **Normalización**: cada partido se mapea a secciones `{label, prob}`.
  Se cubren dos formatos de mercado de Polymarket:
  - un único mercado con 2–3 outcomes (moneyline 1-X-2), o
  - varios mercados binarios *Sí/No* agrupados (`groupItemTitle`).
  Las probabilidades se reescalan para sumar 1 (se elimina el *vig*/overround).
- **Ruleta**: dibujada en `<canvas>`; el barrido angular de cada sector es
  `prob × 360°`. El giro usa `requestAnimationFrame` con desaceleración
  (easeOutCubic) y el ganador se determina por el sector bajo el puntero.

## Configuración

Los parámetros de descubrimiento (slugs de etiqueta, palabras clave, límites)
están en el objeto `CONFIG` al inicio de [`app.js`](./app.js) por si Polymarket
cambia el etiquetado de los partidos.

## Archivos

| Archivo        | Rol                                            |
| -------------- | ---------------------------------------------- |
| `index.html`   | Estructura y layout                            |
| `styles.css`   | Estilos (tema oscuro, responsive)              |
| `app.js`       | Datos (Polymarket), normalización y ruleta     |

> Solo con fines de entretenimiento. Datos de Polymarket (Gamma API).
