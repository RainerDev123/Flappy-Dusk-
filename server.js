const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'flappy-dusk-db.json');
const GAME_FILE = path.join(__dirname, 'index.html');

let db = { users: {} };

try {
  db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
} catch {}

if (!db.users) db.users = {};

const sessions = new Map();
const rooms = new Map();

function saveDb() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function makePassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    salt,
    hash: hashPassword(password, salt)
  };
}

function verifyPassword(password, rec) {
  const a = Buffer.from(hashPassword(password, rec.salt), 'hex');
  const b = Buffer.from(rec.hash, 'hex');
  return crypto.timingSafeEqual(a, b);
}

function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getAuthUser(req) {
  const header = req.headers.authorization || '';

  if (!header.startsWith('Bearer ')) {
    return null;
  }

  const name = sessions.get(header.slice(7));

  if (!name) {
    return null;
  }

  return db.users[name] || null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';

    req.on('data', chunk => {
      data += chunk;
    });

    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization'
  });

  res.end(JSON.stringify(data));
}

function defaultProgress() {
  return {
    coins: 0,
    totalPipesPassed: 0,
    ownedBirds: {
      classic: true
    },
    selectedBird: 'classic',
    best: 0,
    updatedAt: Date.now()
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization'
    });

    return res.end();
  }

  try {
    if (req.url === '/api/signup' && req.method === 'POST') {
      const body = await readBody(req);

      const name = String(body.name || '')
        .trim()
        .slice(0, 20);

      const password = String(body.password || '');

      if (
        !/^[A-Za-z0-9 _-]{2,20}$/.test(name) ||
        password.length < 4
      ) {
        return sendJson(res, 400, {
          error: 'Use a 2–20 character name and a 4+ character password.'
        });
      }

      if (db.users[name]) {
        return sendJson(res, 409, {
          error: 'That name is already taken.'
        });
      }

      const passwordData = makePassword(password);

      db.users[name] = {
        password: passwordData,
        progress: defaultProgress(),
        createdAt: Date.now()
      };

      saveDb();

      const sessionToken = makeToken();
      sessions.set(sessionToken, name);

      return sendJson(res, 200, {
        token: sessionToken,
        user: {
          name
        },
        progress: db.users[name].progress
      });
    }

    if (req.url === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);

      const name = String(body.name || '').trim();
      const password = String(body.password || '');

      const user = db.users[name];

      if (
        !user ||
        !user.password ||
        !verifyPassword(password, user.password)
      ) {
        return sendJson(res, 401, {
          error: 'Name or password is incorrect.'
        });
      }

      const sessionToken = makeToken();
      sessions.set(sessionToken, name);

      return sendJson(res, 200, {
        token: sessionToken,
        user: {
          name
        },
        progress: user.progress || defaultProgress()
      });
    }

    if (req.url === '/api/me' && req.method === 'GET') {
      const user = getAuthUser(req);

      if (!user) {
        return sendJson(res, 401, {
          error: 'Not logged in'
        });
      }

      const name = Object.keys(db.users).find(
        key => db.users[key] === user
      );

      return sendJson(res, 200, {
        user: {
          name
        },
        progress: user.progress || defaultProgress()
      });
    }

    if (req.url === '/api/progress' && req.method === 'PUT') {
      const user = getAuthUser(req);

      if (!user) {
        return sendJson(res, 401, {
          error: 'Not logged in'
        });
      }

      const body = await readBody(req);

      user.progress = {
        ...defaultProgress(),
        ...body,
        ownedBirds: body.ownedBirds || {
          classic: true
        },
        updatedAt: Date.now()
      };

      saveDb();

      return sendJson(res, 200, {
        ok: true
      });
    }

    if (req.url === '/api/leaderboard' && req.method === 'GET') {
      const rows = Object.entries(db.users)
        .map(([name, user]) => ({
          name,
          pipes: Number(user.progress?.totalPipesPassed) || 0,
          best: Number(user.progress?.best) || 0
        }))
        .sort(
          (a, b) =>
            b.pipes - a.pipes ||
            b.best - a.best
        )
        .slice(0, 20);

      return sendJson(res, 200, {
        rows
      });
    }

    if (req.url.startsWith('/api/')) {
      return sendJson(res, 404, {
        error: 'Not found'
      });
    }

    let requestedPath =
      req.url === '/'
        ? GAME_FILE
        : path.join(
            __dirname,
            decodeURIComponent(req.url.split('?')[0])
          );

    if (
      !requestedPath.startsWith(__dirname) ||
      !fs.existsSync(requestedPath) ||
      fs.statSync(requestedPath).isDirectory()
    ) {
      return sendJson(res, 404, {
        error: 'Not found'
      });
    }

    const extension = path.extname(requestedPath);

    let contentType = 'application/octet-stream';

    if (extension === '.html') {
      contentType = 'text/html';
    } else if (extension === '.js') {
      contentType = 'text/javascript';
    } else if (extension === '.css') {
      contentType = 'text/css';
    } else if (extension === '.json') {
      contentType = 'application/json';
    }

    res.writeHead(200, {
      'Content-Type': contentType
    });

    fs.createReadStream(requestedPath).pipe(res);

    return;
  } catch (error) {
    console.error(error);

    return sendJson(res, 500, {
      error: 'Server error'
    });
  }
});

const wss = new WebSocket.Server({
  server,
  path: '/ws'
});

wss.on('connection', ws => {
  ws.on('message', raw => {
    let message;

    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message.type === 'join') {
      const name = sessions.get(message.token);

      if (!name) {
        return ws.send(
          JSON.stringify({
            type: 'error',
            message: 'Log in first.'
          })
        );
      }

      const room = String(message.room || '').toUpperCase();

      if (!/^[A-Z0-9]{6}$/.test(room)) {
        return ws.send(
          JSON.stringify({
            type: 'error',
            message: 'Invalid room code.'
          })
        );
      }

      let roomState = rooms.get(room);

      if (!roomState) {
        roomState = {
          host: null,
          guest: null,
          hostName: '',
          guestName: ''
        };

        rooms.set(room, roomState);
      }

      if (
        message.role === 'host' &&
        !roomState.host
      ) {
        roomState.host = ws;
        roomState.hostName = name;

        ws.room = room;
        ws.role = 'host';

        ws.send(
          JSON.stringify({
            type: 'roomJoined',
            role: 'host'
          })
        );

        return;
      }

      if (!roomState.guest) {
        roomState.guest = ws;
        roomState.guestName = name;

        ws.room = room;
        ws.role = 'guest';

        ws.send(
          JSON.stringify({
            type: 'roomJoined',
            role: 'guest',
            hostName: roomState.hostName
          })
        );

        if (
          roomState.host &&
          roomState.host.readyState === 1
        ) {
          roomState.host.send(
            JSON.stringify({
              type: 'peerJoined',
              guestName: name
            })
          );
        }

        return;
      }

      return ws.send(
        JSON.stringify({
          type: 'error',
          message: 'Room is full.'
        })
      );
    }

    if (
      message.type === 'input' &&
      ws.role === 'guest'
    ) {
      const roomState = rooms.get(ws.room);

      if (
        roomState?.host &&
        roomState.host.readyState === 1
      ) {
        roomState.host.send(JSON.stringify(message));
      }

      return;
    }

    if (
      (message.type === 'snapshot' ||
        message.type === 'matchOver') &&
      ws.role === 'host'
    ) {
      const roomState = rooms.get(ws.room);

      if (
        roomState?.guest &&
        roomState.guest.readyState === 1
      ) {
        roomState.guest.send(
          JSON.stringify(message)
        );
      }

      return;
    }
  });

  ws.on('close', () => {
    if (!ws.room) {
      return;
    }

    const roomState = rooms.get(ws.room);

    if (!roomState) {
      return;
    }

    if (roomState.host === ws) {
      roomState.host = null;
    }

    if (roomState.guest === ws) {
      roomState.guest = null;
    }

    if (!roomState.host && !roomState.guest) {
      rooms.delete(ws.room);
    }
  });
});

server.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `Flappy Dusk online server running on port ${PORT}`
    );
  }
);
