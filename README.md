# Badalona Strike — Online 1v1

Dos piezas:
- `index.html` → el juego (estático). Va en **Vercel**.
- `server.js` → servidor WebSocket sin dependencias. Vercel NO sirve WebSockets persistentes, así que va en **Render / Fly.io / Railway**.

## Desplegar
1. Sube `server.js`, `package.json` y `render.yaml` a un repo y crea un Web Service en Render (plan gratis vale; se duerme tras inactividad y tarda ~30 s en despertar).
2. Pon la variable `ALLOWED_ORIGINS=https://TU-JUEGO.vercel.app` (varios, separados por comas).
3. En `index.html` cambia `wss://TU-SERVIDOR.onrender.com` por la URL real de tu servidor (con `wss://`).
4. Sube `index.html` a Vercel (renómbralo/ponlo como `index.html` en la raíz del proyecto).

## Probar en local
```
node server.js                      # puerto 8080 (PORT para cambiarlo)
# abre index.html (servido en localhost) con ?server=ws://localhost:8080 en dos pestañas
```

## Cómo funciona
- Menú → ONLINE → Crear sala (código de 4 letras), Unirse con código o Buscar partida (cola).
- El anfitrión decide el flujo de rondas; cada jugador aplica el daño que recibe (cliente autoritativo).
- Límite de 120 mensajes/s por conexión, frames de máx. 4 KB, solo tipos de mensaje permitidos.

## Limitaciones conocidas
- Solo 1v1. Battle Royale online (10 jugadores) no está hecho.
- Un cliente modificado puede hacer trampas (no hay servidor autoritativo).
- Monedas, skins y pase viven en localStorage: se pueden editar.
- No hay pausa en online.
