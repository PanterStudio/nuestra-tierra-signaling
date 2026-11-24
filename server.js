const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = Number(process.env.PORT || 8080);
const MAX_PLAYERS_PER_ROOM = 5;

/**
 * Salas activas:
 * code -> {
 *   code: string,
 *   name: string,
 *   hostId: 1,
 *   nextPeerId: number,
 *   started: boolean,
 *   mapName: string,
 *   peers: Map<number, { peerId: number, name: string, ws: WebSocket }>
 * }
 */
const rooms = new Map();

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

function sendJson(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function serializeRoomSummary(room) {
  const host = room.peers.get(room.hostId);
  return {
    code: room.code,
    name: room.name,
    host_name: host ? host.name : "Anfitrión",
    players: room.peers.size,
    max_players: MAX_PLAYERS_PER_ROOM,
    started: room.started,
    map_name: room.mapName,
  };
}

function getPlayersDictionary(room) {
  const dict = {};
  for (const [peerId, peer] of room.peers.entries()) {
    dict[String(peerId)] = peer.name;
  }
  return dict;
}

function broadcastRoomList() {
  const list = [];
  for (const room of rooms.values()) {
    if (!room.started) {
      list.push(serializeRoomSummary(room));
    }
  }
  const msg = { type: "room_list", rooms: list };
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && !client.roomCode) {
      sendJson(client, msg);
    }
  }
}

function broadcastRoomPlayers(room) {
  const msg = {
    type: "players_updated",
    code: room.code,
    players: getPlayersDictionary(room),
  };
  for (const peer of room.peers.values()) {
    sendJson(peer.ws, msg);
  }
}

function removeClientFromRoom(ws) {
  const code = ws.roomCode;
  const peerId = ws.peerId;
  if (!code || !peerId) return;

  const room = rooms.get(code);
  ws.roomCode = null;
  ws.peerId = null;

  if (!room) return;

  room.peers.delete(peerId);

  if (peerId === room.hostId || room.peers.size === 0) {
    // Si el host sale, cerrar la sala y avisar a los demás
    for (const other of room.peers.values()) {
      other.ws.roomCode = null;
      other.ws.peerId = null;
      sendJson(other.ws, {
        type: "room_closed",
        reason: "El anfitrión cerró la sala.",
      });
    }
    rooms.delete(code);
    broadcastRoomList();
    return;
  }

  for (const other of room.peers.values()) {
    sendJson(other.ws, {
      type: "peer_disconnected",
      peer_id: peerId,
    });
  }
  broadcastRoomPlayers(room);
  broadcastRoomList();
}

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        service: "nuestra-tierra-webrtc-signaling",
        active_rooms: rooms.size,
      })
    );
    return;
  }
  res.writeHead(404);
  res.end("Not Found");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.roomCode = null;
  ws.peerId = null;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  sendJson(ws, { type: "welcome", message: "Conectado al servidor WebRTC P2P" });

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      sendJson(ws, { type: "error", message: "JSON inválido" });
      return;
    }

    const type = String(data.type || "");

    if (type === "list_rooms") {
      const list = [];
      for (const room of rooms.values()) {
        if (!room.started) {
          list.push(serializeRoomSummary(room));
        }
      }
      sendJson(ws, { type: "room_list", rooms: list });
      return;
    }

    if (type === "create_room") {
      removeClientFromRoom(ws);

      const code = generateRoomCode();
      const playerName = String(data.player_name || "Anfitrión").slice(0, 24);
      const roomName = String(data.room_name || `Sala de ${playerName}`).slice(0, 40);
      const mapName = String(data.map_name || "Principal").slice(0, 40);

      const room = {
        code,
        name: roomName,
        hostId: 1,
        nextPeerId: 2,
        started: false,
        mapName,
        peers: new Map(),
      };

      room.peers.set(1, { peerId: 1, name: playerName, ws });
      rooms.set(code, room);

      ws.roomCode = code;
      ws.peerId = 1;

      sendJson(ws, {
        type: "room_created",
        code,
        peer_id: 1,
        room: serializeRoomSummary(room),
        players: getPlayersDictionary(room),
      });
      broadcastRoomList();
      return;
    }

    if (type === "join_room") {
      removeClientFromRoom(ws);

      const code = String(data.code || "").trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        sendJson(ws, { type: "error", message: `No existe ninguna sala con el código ${code}.` });
        return;
      }
      if (room.started) {
        sendJson(ws, { type: "error", message: "La partida ya está en curso." });
        return;
      }
      if (room.peers.size >= MAX_PLAYERS_PER_ROOM) {
        sendJson(ws, { type: "error", message: "La sala está llena (máximo 5 jugadores)." });
        return;
      }

      const peerId = room.nextPeerId++;
      const playerName = String(data.player_name || `Jugador ${peerId}`).slice(0, 24);

      const existingPeers = [];
      for (const [id, peer] of room.peers.entries()) {
        existingPeers.push({ peer_id: id, name: peer.name });
      }

      room.peers.set(peerId, { peerId, name: playerName, ws });
      ws.roomCode = code;
      ws.peerId = peerId;

      sendJson(ws, {
        type: "room_joined",
        code,
        peer_id: peerId,
        room: serializeRoomSummary(room),
        existing_peers: existingPeers,
        players: getPlayersDictionary(room),
      });

      for (const [id, peer] of room.peers.entries()) {
        if (id !== peerId) {
          sendJson(peer.ws, {
            type: "peer_connected",
            peer_id: peerId,
            name: playerName,
          });
        }
      }

      broadcastRoomPlayers(room);
      broadcastRoomList();
      return;
    }

    if (type === "leave_room") {
      removeClientFromRoom(ws);
      return;
    }

    if (type === "start_game") {
      const room = rooms.get(ws.roomCode);
      if (!room || ws.peerId !== room.hostId) {
        sendJson(ws, { type: "error", message: "Solo el anfitrión puede iniciar la partida." });
        return;
      }
      room.started = true;
      const scene = String(data.scene || "res://mundo/principal/PrincipalMultijugador.tscn");
      const mapName = String(data.map_name || room.mapName || "");
      const mapPath = String(data.map_path || "");
      for (const peer of room.peers.values()) {
        sendJson(peer.ws, {
          type: "game_started",
          scene,
          map_name: mapName,
          map_path: mapPath,
        });
      }
      broadcastRoomList();
      return;
    }

    if (type === "offer" || type === "answer" || type === "candidate") {
      const room = rooms.get(ws.roomCode);
      if (!room || !ws.peerId) return;

      const targetId = Number(data.target_id);
      const targetPeer = room.peers.get(targetId);
      if (!targetPeer) return;

      sendJson(targetPeer.ws, {
        type,
        from_id: ws.peerId,
        sdp: data.sdp,
        media: data.media,
        index: data.index,
        name: data.name,
      });
      return;
    }
  });

  ws.on("close", () => {
    removeClientFromRoom(ws);
  });

  ws.on("error", () => {
    removeClientFromRoom(ws);
  });
});

// Keepalive para detectar conexiones caídas
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

wss.on("close", () => {
  clearInterval(heartbeat);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[Signaling WebRTC] Escuchando en puerto ${PORT}`);
});
