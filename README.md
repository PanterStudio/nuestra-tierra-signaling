# Servidor de Señalización WebRTC P2P — Nuestra Tierra 2.0

Servidor ligero en Node.js + WebSocket (`ws`) encargado exclusivamente del intercambio de señalización WebRTC (salas, códigos de sala, SDP `offer`/`answer` e ICE `candidate`).  
Todo el tráfico de juego (posiciones, vehículos, RPCs) viaja **directamente Peer-to-Peer (P2P)** entre jugadores usando `WebRTCMultiplayerPeer`.

## Ejecutar en local

```bash
npm install
npm start
```

Por defecto escucha en el puerto `8080` (`PORT=8080`).  
Endpoint de salud HTTP: `GET /health`.

## Despliegue con Docker / Dokploy / VPS

```bash
docker build -t nuestra-tierra-signaling .
docker run -d -p 8080:8080 --name nt-signaling nuestra-tierra-signaling
```
