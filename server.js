// Badalona Strike · servidor de salas (sin dependencias, Node >= 18)
// Empareja jugadores (por código o cola) y reenvía sus mensajes al rival.
// Despliegue: Render / Fly.io / Railway (necesita conexiones WebSocket persistentes; Vercel no sirve para esto).
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean); // ej: https://mi-juego.vercel.app
const MAX_CLIENTS = +process.env.MAX_CLIENTS || 500;
const MAX_FRAME = 4096;            // bytes por mensaje
const MAX_MSGS_PER_SEC = 120;      // límite por jugador
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RELAY_TYPES = new Set(['hello', 'init', 'round', 'rend', 'over', 's', 'dead', 'hit', 'shot', 'proj', 'gren', 'smoke']);

const rooms = new Map();           // code -> { host, guest }
let queue = null;                  // jugador esperando partida
let clients = 0;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Badalona Strike server OK · jugadores: ' + clients + ' · salas: ' + rooms.size);
});

// ---------- WebSocket mínimo (RFC 6455) ----------
function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const origin = req.headers.origin;
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket' ||
      (ORIGINS.length && !ORIGINS.includes(origin)) || clients >= MAX_CLIENTS) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  newClient(socket);
});

function newClient(socket) {
  clients++;
  const c = { socket, buf: Buffer.alloc(0), peer: null, room: null, alive: true, tokens: MAX_MSGS_PER_SEC, closed: false, frag: null };
  c.send = obj => { if (!c.closed) try { socket.write(frame(1, Buffer.from(JSON.stringify(obj)))); } catch (e) {} };
  const refill = setInterval(() => { c.tokens = MAX_MSGS_PER_SEC; }, 1000);
  const ping = setInterval(() => {
    if (!c.alive) return close();
    c.alive = false;
    try { socket.write(frame(9, Buffer.alloc(0))); } catch (e) {}
  }, 25000);

  function close() {
    if (c.closed) return;
    c.closed = true;
    clearInterval(refill); clearInterval(ping);
    clients--;
    leave(c);
    try { socket.destroy(); } catch (e) {}
  }
  c.close = close;
  socket.on('data', d => {
    c.buf = Buffer.concat([c.buf, d]);
    if (c.buf.length > MAX_FRAME * 4) return close();
    parse(c);
  });
  socket.on('close', close);
  socket.on('error', close);
}

function parse(c) {
  while (c.buf.length >= 2) {
    const b0 = c.buf[0], b1 = c.buf[1], fin = !!(b0 & 0x80), op = b0 & 15, masked = !!(b1 & 0x80);
    let len = b1 & 127, off = 2;
    if (!masked) return c.close();                       // los clientes siempre enmascaran
    if (len === 126) { if (c.buf.length < 4) return; len = c.buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (c.buf.length < 10) return; const big = c.buf.readBigUInt64BE(2); if (big > BigInt(MAX_FRAME)) return c.close(); len = Number(big); off = 10; }
    if (len > MAX_FRAME) return c.close();
    if (c.buf.length < off + 4 + len) return;
    const mask = c.buf.subarray(off, off + 4);
    const data = Buffer.from(c.buf.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
    c.buf = c.buf.subarray(off + 4 + len);
    if (op === 8) { try { c.socket.write(frame(8, Buffer.alloc(0))); } catch (e) {} return c.close(); }
    if (op === 9) { try { c.socket.write(frame(10, data)); } catch (e) {} continue; }
    if (op === 10) { c.alive = true; continue; }
    if (op === 1 || op === 0) {
      if (op === 1) c.frag = [];
      if (!c.frag) return c.close();
      c.frag.push(data);
      if (c.frag.reduce((a, b) => a + b.length, 0) > MAX_FRAME) return c.close();
      if (fin) { const msg = Buffer.concat(c.frag).toString('utf8'); c.frag = null; onMsg(c, msg); }
    }
  }
}

// ---------- lógica de salas ----------
function code() {
  for (let t = 0; t < 50; t++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += ALPHA[crypto.randomInt(ALPHA.length)];
    if (!rooms.has(s)) return s;
  }
  return null;
}
function pair(host, guest, cd) {
  host.peer = guest; guest.peer = host;
  host.send({ t: 'match', host: true, code: cd || '' });
  guest.send({ t: 'match', host: false, code: cd || '' });
}
function leave(c) {
  if (queue === c) queue = null;
  if (c.room) { const r = rooms.get(c.room); if (r && r.host === c) rooms.delete(c.room); c.room = null; }
  if (c.peer) { const p = c.peer; p.peer = null; c.peer = null; p.send({ t: 'left' }); if (p.room) { rooms.delete(p.room); p.room = null; } }
}

function onMsg(c, text) {
  if (--c.tokens < 0) return c.close();
  let m; try { m = JSON.parse(text); } catch (e) { return; }
  if (!m || typeof m !== 'object') return;
  switch (m.t) {
    case 'create': {
      if (c.peer || c.room || queue === c) return c.send({ t: 'err', m: 'Ya estás en una partida.' });
      const cd = code(); if (!cd) return c.send({ t: 'err', m: 'Servidor lleno.' });
      rooms.set(cd, { host: c, guest: null }); c.room = cd;
      c.send({ t: 'created', code: cd }); break;
    }
    case 'join': {
      if (c.peer || c.room || queue === c) return c.send({ t: 'err', m: 'Ya estás en una partida.' });
      const cd = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4), r = rooms.get(cd);
      if (!r || r.guest || r.host.closed) return c.send({ t: 'err', m: 'Sala no encontrada o llena.' });
      r.guest = c; pair(r.host, c, cd); break;
    }
    case 'queue': {
      if (c.peer || c.room) return c.send({ t: 'err', m: 'Ya estás en una partida.' });
      if (queue && queue !== c && !queue.closed) { const h = queue; queue = null; pair(h, c, ''); }
      else { queue = c; c.send({ t: 'queued' }); }
      break;
    }
    case 'unqueue': if (queue === c) queue = null; break;
    case 'leave': leave(c); break;
    case 'rel': {
      const d = m.d;
      if (!c.peer || !d || typeof d !== 'object' || !RELAY_TYPES.has(d.t)) return;
      c.peer.send({ t: 'rel', d }); break;
    }
  }
}

server.listen(PORT, () => console.log('Badalona Strike server escuchando en :' + PORT));
module.exports = server;
