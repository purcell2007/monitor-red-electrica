# Monitor de la red eléctrica (España)

Página web en tiempo real con datos oficiales de Red Eléctrica (API pública REData, `apidatos.ree.es`).
Se adapta a móvil, tablet y ordenador, con modo claro y oscuro.

## Arrancar

Requiere Node 18 o superior. No tiene dependencias.

```bash
node server.js
```

Abre http://localhost:8787. Para verla desde el móvil en la misma wifi, usa `http://IP-DEL-ORDENADOR:8787`
(la IP se ve con `hostname -I`).

## Publicarlo en internet

El proyecto está listo para tres vías. Todas usan el mismo `server.js`, que escucha en la variable `PORT`.

### Opción A — Render (gratis, la más sencilla)

1. Sube esta carpeta a un repositorio de GitHub.
2. En https://render.com → **New → Blueprint** y elige el repositorio. Render lee `render.yaml` y lo despliega solo.
3. Te da una dirección tipo `https://monitor-red-electrica.onrender.com`.

En el plan gratuito el servicio se duerme tras 15 minutos sin visitas: la primera visita tarda unos
30 s en despertar y el mapa de comunidades unos segundos más.

### Opción B — Docker (cualquier servidor, VPS, Fly.io, Railway, Google Cloud Run…)

```bash
docker build -t monitor-red-electrica .
docker run -d --restart unless-stopped -p 80:8787 monitor-red-electrica
```

### Opción C — Node directamente en un servidor

```bash
NODE_ENV=production PORT=8787 node server.js
```

Detrás de un proxy (Nginx, Caddy) que ponga HTTPS.

### Variables de entorno

| Variable | Por defecto | Uso |
|---|---|---|
| `PORT` | `8787` | Puerto |
| `HOST` | `0.0.0.0` | Interfaz de escucha |
| `NODE_ENV` | — | `production` guarda los ficheros estáticos en memoria |
| `RATE_LIMIT` | `120` | Peticiones a `/api` por minuto e IP |
| `TRUST_PROXY` | activado | Pon `0` si no hay proxy delante (ignora `X-Forwarded-For`) |

### Preparado para producción

- Compresión Brotli/gzip, cabeceras de seguridad (CSP, nosniff, etc.) y límite de peticiones por IP.
- Caché en servidor: aunque haya muchos visitantes, a Red Eléctrica solo llega una consulta cada 45 s
  para el dato en directo; los datos lentos se precargan al arrancar y se refrescan cada 30 min.
- `/healthz` para comprobaciones de salud.
- Imagen para compartir el enlace (`og.png`) e iconos para instalarla en el móvil como app
  (en el navegador del móvil: «Añadir a pantalla de inicio»).
- `?solo` en la dirección muestra solo el gráfico principal (para pantallas o capturas).

## Qué muestra

| Sección | Dato | Frecuencia en la fuente |
|---|---|---|
| Consumo real y previsto | Demanda real, prevista y programada; comparativa con ayer y hace 7 días; tramos de tarifa 2.0TD | cada 5 min (~10 min de retraso) |
| Indicadores | Demanda actual, desviación en la última hora y en el día, frente a ayer, máximo, precio, renovables, CO₂ | — |
| Desviación | Real − prevista por intervalo, error medio de la previsión | cada 5 min |
| Precio | PVPC horario y precio mayorista cada 15 min | diario |
| Mix de generación | Tecnologías por día, % renovable, últimos 30 días, emisiones g CO₂/kWh | diario (el día en curso es provisional) |
| Sistemas eléctricos | Península, Canarias, Baleares, Ceuta, Melilla | diario |
| Comunidades autónomas | Mapa y ranking de generación por comunidad y tecnología | mensual |
| Consumo por sectores | Índice IRE: industria, servicios y general (variación interanual) | mensual |
| Tendencia | Demanda diaria de los últimos 12 meses frente al año anterior | diario |

## Limitaciones de los datos

- Red Eléctrica publica la demanda cada 5 minutos; no hay datos públicos al segundo. La página consulta cada
  30 s, 1 min o 5 min (configurable), así que muestra cada dato en cuanto se publica.
- Red Eléctrica no publica la demanda por comunidad autónoma, solo la generación (salvo los sistemas aislados).
- El consumo doméstico no se publica por separado; el IRE cubre a los grandes consumidores (industria y servicios).

## Estructura

- `server.js`: servidor HTTP + proxy con caché hacia REData (evita la caché de 24 h de la API para el dato de hoy).
- `public/`: la web (`index.html`, `styles.css`, `app.js` con gráficos D3).
