const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = Number(process.env.PORT || 8080);
const MAX_PLAYERS_PER_ROOM = 5;
const MAX_EDITORS_PER_COLLAB = 6;
const COLLAB_COLORS = ["#FFC52E", "#2ECC71", "#38BDF8", "#F472B6", "#A78BFA", "#FB923C"];

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
const collabRooms = new Map();

function generateCollabCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return collabRooms.has(code) || rooms.has(code) ? generateCollabCode() : code;
}

function serializeCollabPeers(room) {
  const list = [];
  for (const peer of room.peers.values()) {
    list.push({
      peer_id: peer.peerId,
      name: peer.name,
      color: peer.color,
      is_host: peer.peerId === room.hostId,
    });
  }
  return list;
}

function serializeCollabSummary(room) {
  const host = room.peers.get(room.hostId);
  return {
    code: room.code,
    project_name: room.projectName,
    host_name: host ? host.name : "Creador",
    editors: room.peers.size,
    max_editors: MAX_EDITORS_PER_COLLAB,
    revision: room.revision,
  };
}

function removeClientFromCollab(ws) {
  const code = ws.collabCode;
  const peerId = ws.collabPeerId;
  if (!code || !peerId) return;

  const room = collabRooms.get(code);
  ws.collabCode = null;
  ws.collabPeerId = null;
  if (!room) return;

  const leaving = room.peers.get(peerId);
  room.peers.delete(peerId);

  if (room.peers.size === 0) {
    collabRooms.delete(code);
    return;
  }

  if (peerId === room.hostId) {
    const nextPeer = room.peers.values().next().value;
    if (nextPeer) room.hostId = nextPeer.peerId;
  }

  const peersList = serializeCollabPeers(room);
  for (const other of room.peers.values()) {
    sendJson(other.ws, {
      type: "collab_peer_left",
      peer_id: peerId,
      name: leaving ? leaving.name : "Editor",
      host_id: room.hostId,
      peers: peersList,
    });
  }
}

// Presencia ligera en memoria (TTL 90s, sin base de datos ni WebSocket permanente)
const ONLINE_TTL_MS = 90 * 1000;
const onlinePlayers = new Map();

function pruneOnlinePlayers() {
  const now = Date.now();
  for (const [id, entry] of onlinePlayers.entries()) {
    if (now - entry.lastSeen > ONLINE_TTL_MS) {
      onlinePlayers.delete(id);
    }
  }
}

function getOnlinePlayersList() {
  pruneOnlinePlayers();
  return Array.from(onlinePlayers.values())
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, 60)
    .map(({ id, name, level, discord, provider, status, avatarUrl, lastSeen }) => ({
      id,
      name,
      level,
      discord,
      provider: provider || "",
      status,
      avatar_url: avatarUrl || "",
      last_seen: lastSeen,
    }));
}

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
    pruneOnlinePlayers();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        service: "nuestra-tierra-webrtc-signaling",
        active_rooms: rooms.size,
        active_collab_rooms: collabRooms.size,
        online_players: onlinePlayers.size,
      })
    );
    return;
  }

  if (req.method === "GET" && req.url === "/online") {
    const players = getOnlinePlayersList();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ count: players.length, players }));
    return;
  }

  if (req.method === "POST" && req.url === "/presence") {
    let body = "";
    req.on("data", (chunk) => {
      if (body.length < 2048) body += chunk;
    });
    req.on("end", () => {
      try {
        const data = JSON.parse(body || "{}");
        const id = String(data.id || "").trim().slice(0, 64);
        const name = String(data.name || "Conductor").trim().slice(0, 32) || "Conductor";
        if (id) {
          onlinePlayers.set(id, {
            id,
            name,
            level: Math.max(0, Number(data.level || 0)),
            discord: String(data.discord || "").trim().slice(0, 36),
            provider: String(data.provider || "").trim().slice(0, 32),
            status: String(data.status || "En menu").trim().slice(0, 32),
            avatarUrl: String(data.avatar_url || "").trim().slice(0, 300),
            lastSeen: Date.now(),
          });
        }
        const players = getOnlinePlayersList();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, count: players.length, players }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "JSON inválido" }));
      }
    });
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
    const action = String(data.action || "");

    if (action === "ticket_create") {
      const ticketId = "NT-" + Math.floor(1000 + Math.random() * 9000);
      const cat = String(data.category || "ASISTENCIA GENERAL");
      const discordCategoryId = String(data.discord_category_id || "1487700686819823747");
      const playerName = String(data.player_name || "Conductor").slice(0, 32);
      const msg = String(data.message || "").slice(0, 1000);
      console.log(`[Soporte] Ticket ${ticketId} en categoria Discord ${discordCategoryId} de ${playerName} (${cat}): ${msg}`);

      const botToken = process.env.DISCORD_BOT_TOKEN || "";
      const guildId = process.env.DISCORD_GUILD_ID || "";
      if (botToken && guildId) {
        const channelName = `${ticketId.toLowerCase()}-${playerName.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "jugador"}`;
        fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
          method: "POST",
          headers: {
            "Authorization": `Bot ${botToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            name: channelName,
            type: 0,
            parent_id: discordCategoryId,
            topic: `Ticket ${ticketId} | ${playerName} | ${cat} | ${data.priority || "NORMAL"}`
          })
        }).then((r) => r.ok ? r.json() : null).then((ch) => {
          if (ch && ch.id) {
            fetch(`https://discord.com/api/v10/channels/${ch.id}/messages`, {
              method: "POST",
              headers: {
                "Authorization": `Bot ${botToken}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                content: `**${ticketId}** | **${playerName}** (${cat} - ${data.priority || "NORMAL"})\n${msg}`
              })
            }).catch(() => {});
          }
        }).catch(() => {});
      }

      const webhookUrl = process.env.DISCORD_SUPPORT_WEBHOOK || "";
      if (webhookUrl) {
        fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `**${ticketId}** [Cat: ${discordCategoryId}] | **${playerName}** (${cat} - ${data.priority || "NORMAL"})\n${msg}`
          })
        }).catch(() => {});
      }
      sendJson(ws, { action: "ticket_created", ticket_id: ticketId, discord_category_id: discordCategoryId });
      sendJson(ws, {
        action: "ticket_reply",
        ticket_id: ticketId,
        area: "SOPORTE NT",
        message: `Ticket ${ticketId} registrado en Discord (categoria ${discordCategoryId}). Un miembro del equipo atendera tu caso.`
      });
      return;
    }

    if (action === "ticket_message") {
      const ticketId = String(data.ticket_id || "");
      const msg = String(data.message || "").slice(0, 1000);
      console.log(`[Soporte] Mensaje en ${ticketId}: ${msg}`);
      sendJson(ws, {
        action: "staff_reply",
        ticket_id: ticketId,
        staff_name: "SOPORTE NT",
        message: "Mensaje recibido y anexado a tu ticket " + ticketId + "."
      });
      return;
    }

    if (action === "ticket_close") {
      const ticketId = String(data.ticket_id || "");
      sendJson(ws, { action: "ticket_closed", ticket_id: ticketId, by: "Usuario" });
      return;
    }

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

    // ── MODO EDITOR DE MAPAS COLABORATIVO ONLINE ───────────────────────
    if (type === "collab_list") {
      const list = [];
      for (const r of collabRooms.values()) {
        list.push(serializeCollabSummary(r));
      }
      sendJson(ws, { type: "collab_rooms", rooms: list });
      return;
    }

    if (type === "collab_create") {
      removeClientFromCollab(ws);
      const code = generateCollabCode();
      const playerName = String(data.player_name || "Creador").slice(0, 28);
      const projectName = String(data.project_name || "Proyecto Online").slice(0, 48);
      const snapshot = data.snapshot && typeof data.snapshot === "object" ? data.snapshot : {};
      const room = {
        code,
        projectName,
        hostId: 1,
        nextPeerId: 2,
        revision: 1,
        locked: false,
        snapshot,
        peers: new Map(),
      };
      room.peers.set(1, { peerId: 1, name: playerName, color: COLLAB_COLORS[0], ws });
      collabRooms.set(code, room);
      ws.collabCode = code;
      ws.collabPeerId = 1;

      sendJson(ws, {
        type: "collab_created",
        code,
        peer_id: 1,
        project_name: projectName,
        revision: room.revision,
        peers: serializeCollabPeers(room),
      });
      return;
    }

    if (type === "collab_join") {
      removeClientFromCollab(ws);
      const code = String(data.code || "").trim().toUpperCase();
      const room = collabRooms.get(code);
      if (!room) {
        sendJson(ws, { type: "collab_error", message: `No existe proyecto online con código ${code}.` });
        return;
      }
      if (room.peers.size >= MAX_EDITORS_PER_COLLAB) {
        sendJson(ws, { type: "collab_error", message: `Proyecto lleno (máximo ${MAX_EDITORS_PER_COLLAB} editores).` });
        return;
      }
      const peerId = room.nextPeerId++;
      const playerName = String(data.player_name || `Editor ${peerId}`).slice(0, 28);
      const color = COLLAB_COLORS[(peerId - 1) % COLLAB_COLORS.length];
      room.peers.set(peerId, { peerId, name: playerName, color, ws });
      ws.collabCode = code;
      ws.collabPeerId = peerId;

      const peersList = serializeCollabPeers(room);
      sendJson(ws, {
        type: "collab_joined",
        code,
        peer_id: peerId,
        project_name: room.projectName,
        revision: room.revision,
        snapshot: room.snapshot,
        peers: peersList,
      });

      for (const [id, peer] of room.peers.entries()) {
        if (id !== peerId) {
          sendJson(peer.ws, {
            type: "collab_peer_joined",
            peer_id: peerId,
            name: playerName,
            color,
            peers: peersList,
          });
        }
      }
      return;
    }

    if (type === "collab_sync") {
      const room = collabRooms.get(ws.collabCode);
      if (!room || !ws.collabPeerId) return;
      if (!data.snapshot || typeof data.snapshot !== "object") return;
      const sender = room.peers.get(ws.collabPeerId);
      room.snapshot = data.snapshot;
      room.revision += 1;
      const summary = String(data.summary || "Actualizó el mapa").slice(0, 64);

      for (const [id, peer] of room.peers.entries()) {
        if (id !== ws.collabPeerId) {
          sendJson(peer.ws, {
            type: "collab_state_updated",
            from_id: ws.collabPeerId,
            from_name: sender ? sender.name : "Editor",
            revision: room.revision,
            summary,
            snapshot: room.snapshot,
          });
        }
      }
      sendJson(ws, { type: "collab_sync_ack", revision: room.revision });
      return;
    }

    if (type === "collab_patch") {
      const room = collabRooms.get(ws.collabCode);
      if (!room || !ws.collabPeerId) return;
      if (room.locked && ws.collabPeerId !== room.hostId) {
        sendJson(ws, { type: "collab_error", message: "El anfitrión pausó las ediciones temporalmente." });
        return;
      }
      const category = String(data.category || "").slice(0, 32);
      if (!category) return;
      const sender = room.peers.get(ws.collabPeerId);
      const summary = String(data.summary || "Editó el mapa").slice(0, 64);
      if (category === "vias" && data.payload && typeof data.payload === "object") {
        if (data.payload.vias !== undefined) room.snapshot.carreteras = data.payload.vias;
        if (data.payload.equip !== undefined) room.snapshot.equipamiento_vias = data.payload.equip;
      } else if (category !== "terreno") {
        room.snapshot[category] = data.payload;
      }
      room.revision += 1;
      for (const [id, peer] of room.peers.entries()) {
        if (id !== ws.collabPeerId) {
          sendJson(peer.ws, {
            type: "collab_patch_received",
            from_id: ws.collabPeerId,
            from_name: sender ? sender.name : "Editor",
            revision: room.revision,
            category,
            payload: data.payload,
            summary,
          });
        }
      }
      sendJson(ws, { type: "collab_sync_ack", revision: room.revision });
      return;
    }

    if (type === "collab_lock") {
      const room = collabRooms.get(ws.collabCode);
      if (!room || ws.collabPeerId !== room.hostId) return;
      room.locked = Boolean(data.locked);
      for (const peer of room.peers.values()) {
        sendJson(peer.ws, { type: "collab_lock_changed", locked: room.locked });
      }
      return;
    }

    if (type === "collab_kick") {
      const room = collabRooms.get(ws.collabCode);
      if (!room || ws.collabPeerId !== room.hostId) return;
      const targetId = Number(data.target_peer_id);
      if (!targetId || targetId === room.hostId) return;
      const target = room.peers.get(targetId);
      if (!target) return;
      sendJson(target.ws, { type: "collab_kicked", reason: "El anfitrión te retiró del proyecto." });
      removeClientFromCollab(target.ws);
      return;
    }

    if (type === "collab_leave") {
      removeClientFromCollab(ws);
      return;
    }
  });

  ws.on("close", () => {
    removeClientFromRoom(ws);
    removeClientFromCollab(ws);
  });

  ws.on("error", () => {
    removeClientFromRoom(ws);
    removeClientFromCollab(ws);
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
