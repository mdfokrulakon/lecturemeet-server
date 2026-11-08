// LectureMeet signaling server: rooms, WebRTC signal relay, chat, raise-hand, share-link page.
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PACKAGE = 'com.lecturemeet.app';

let ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  // Free shared TEST relay. For real use set ICE_SERVERS to your own TURN.
  { urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp'],
    username: 'openrelayproject', credential: 'openrelayproject' },
];
if (process.env.ICE_SERVERS) {
  try { ICE = JSON.parse(process.env.ICE_SERVERS); } catch (e) { console.error('Bad ICE_SERVERS JSON'); }
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// room code -> { teacher: ws, students: Map(id -> ws) }
const rooms = new Map();
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 6; i++) c += ALPHABET[crypto.randomInt(ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
}
function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(room, obj) {
  send(room.teacher, obj);
  for (const s of room.students.values()) send(s, obj);
}
function clean(s, max) { return String(s || '').replace(/[\u0000-\u001f]/g, '').slice(0, max); }

app.get('/', (req, res) => res.send('LectureMeet server is running. Rooms: ' + rooms.size));

app.get('/j/:code', (req, res) => {
  const code = String(req.params.code).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 10);
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
  const origin = proto + '://' + req.headers.host;
  const intent = 'intent://join?server=' + encodeURIComponent(origin) + '&room=' + code +
    '#Intent;scheme=lecturemeet;package=' + PACKAGE + ';end';
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Join class</title>
<body style="font-family:sans-serif;text-align:center;padding:40px">
<h2>Join live class</h2>
<p>Class code</p><h1 style="letter-spacing:4px">${code}</h1>
<p><a href="${intent}" style="display:inline-block;padding:14px 28px;background:#1a73e8;color:#fff;border-radius:8px;text-decoration:none">Open in LectureMeet app</a></p>
<p style="color:#666">Or open the app, tap Student, and paste this page's address.</p></body>`);
});

wss.on('connection', (ws) => {
  ws.id = crypto.randomBytes(4).toString('hex');
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }

    if (m.type === 'create' && !ws.room) {
      const code = newCode();
      ws.room = code; ws.role = 'teacher'; ws.name = clean(m.name, 40) || 'Teacher';
      rooms.set(code, { teacher: ws, students: new Map() });
      send(ws, { type: 'created', room: code, id: ws.id, ice: ICE });
      return;
    }

    if (m.type === 'join' && !ws.room) {
      const code = clean(m.room, 10).toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { type: 'error', message: 'Class not found. Check the code, or the teacher has not started yet.' });
      if (room.students.size >= 8) return send(ws, { type: 'error', message: 'Class is full (max 8 students).' });
      ws.room = code; ws.role = 'student'; ws.name = clean(m.name, 40) || 'Student';
      room.students.set(ws.id, ws);
      send(ws, { type: 'joined', room: code, id: ws.id, teacherId: room.teacher.id, teacherName: room.teacher.name, ice: ICE });
      send(room.teacher, { type: 'student-joined', id: ws.id, name: ws.name });
      return;
    }

    const room = rooms.get(ws.room);
    if (!room) return;

    if (m.type === 'signal') {
      const target = room.teacher.id === m.to ? room.teacher : room.students.get(m.to);
      send(target, { type: 'signal', from: ws.id, data: m.data });
    } else if (m.type === 'chat') {
      const text = clean(m.text, 500);
      if (text) broadcast(room, { type: 'chat', from: ws.id, name: ws.name, text, ts: Date.now() });
    } else if (m.type === 'hand') {
      broadcast(room, { type: 'hand', id: ws.id, name: ws.name, up: !!m.up });
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.room);
    if (!room) return;
    if (ws.role === 'teacher') {
      for (const s of room.students.values()) send(s, { type: 'ended' });
      rooms.delete(ws.room);
    } else {
      room.students.delete(ws.id);
      send(room.teacher, { type: 'student-left', id: ws.id });
      broadcast(room, { type: 'hand', id: ws.id, name: ws.name, up: false });
    }
  });
});

// keep connections alive through proxies (Render, ngrok) and drop dead ones
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 25000);

server.listen(PORT, () => console.log('LectureMeet server on port ' + PORT));
