const express = require('express');
const path = require('path');
const http = require('http');
const fs = require('fs');
const webpush = require('web-push');
const multer = require('multer');
const { Server } = require('socket.io');
const families = require('./families');
const themes = require('./themes');

const app = express();
// === VAPID для Push ===
const VAPID_PUBLIC_KEY = 'BF6PAqorG6sudo1BagMezYYbNwciGw3iNNOneR_lOKcgR5pH4xjn7uo0ntBkj2ghxlwYZi94fiA-4TdOoDjXUVg';
const VAPID_PRIVATE_KEY = 'MRopeFnoKQK80wUGbaCNgwY91NqVVqMMSwyzG8h9ntM';
const VAPID_SUBJECT = 'mailto:family@example.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
const PORT = process.env.PORT || 3000;

const server = http.createServer(app);
const io = new Server(server);

app.get('/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY });
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'uploads'));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.webm';
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + ext);
  }
});

// Загрузка аватарок (только фото)
const uploadAvatar = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Только изображения'));
  }
});

// Загрузка фото для чата
const uploadImage = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Только изображения'));
  }
});

// Загрузка аудио для чата
const uploadAudio = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('audio/') || file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Только аудио'));
  }
});

// Загрузка видео (кружков)
const uploadVideo = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/') || file.mimetype.startsWith('audio/')) cb(null, true);
    else cb(new Error('Только видео'));
  }
});

app.post('/upload-avatar', uploadAvatar.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

app.post('/upload-chat-image', uploadImage.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

app.post('/upload-chat-audio', uploadAudio.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

app.post('/upload-chat-video', uploadVideo.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

const users = {};
// Хранилище подписок на Push
const pushSubscriptions = [];

// === Сохранение желаний ===
const WISHES_FILE = path.join(__dirname, 'wishes.json');
let wishes = [];
if (fs.existsSync(WISHES_FILE)) {
  try {
    wishes = JSON.parse(fs.readFileSync(WISHES_FILE, 'utf8'));
  } catch (e) {
    wishes = [];
  }
}

// === Чат ===
const messages = [];
const MAX_MESSAGES = 200;

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

  return R * c;
}

// === Защита от спама салютом ===
let lastGatheredTime = 0;
const GATHERED_COOLDOWN = 5 * 60 * 1000;

function checkAllGathered() {
  const now = Date.now();
  if (now - lastGatheredTime < GATHERED_COOLDOWN) return;

  const online = Object.values(users).filter(u => u.lat && u.lng);
  const currentFamilies = [...new Set(online.map(u => u.family))];

  if (online.length < 3) return;

  const requiredFamilies = ['ovchinnikov', 'baranov', 'sarapin'];
  const allPresent = requiredFamilies.every(f => currentFamilies.includes(f));
  if (!allPresent) return;

  const center = online.find(u => requiredFamilies.includes(u.family));
  const allClose = online.every(u => {
    const dist = distanceMeters(center.lat, center.lng, u.lat, u.lng);
    return dist < 500;
  });

  if (allClose) {
    lastGatheredTime = now;
    io.emit('all-gathered', {
      count: online.length,
      families: currentFamilies
    });
    console.log('🎆 ВСЕ В СБОРЕ! Салют отправлен. Следующий будет не раньше, чем через 5 минут.');
  }
}

io.on('connection', (socket) => {
  console.log(`🟢 Подключился: ${socket.id}`);

  socket.on('join', (data) => {
    const name = (data.name || 'Гость').trim();
    const code = (data.code || '').trim();
    const avatar = data.avatar || null;

    let familyId = null;
    let family = null;
    for (const [id, fam] of Object.entries(families)) {
      if (fam.code === code) {
        familyId = id;
        family = fam;
        break;
      }
    }

    if (!family) {
      socket.emit('join-error', 'Неверный код семьи');
      return;
    }

    socket.familyId = familyId;
    socket.userName = name;
    socket.isVip = !!family.vip;
    socket.avatar = avatar;

    socket.join(`family:${familyId}`);
    socket.join('family:all');

    const themeId = (data.theme && themes[data.theme]) ? data.theme : 'newyear';
    const themeData = themes[themeId];

    socket.emit('join-ok', {
      familyId,
      familyName: family.name,
      color: family.color,
      mascot: family.mascot,
      vip: !!family.vip,
      avatar: avatar,
      theme: themeId,
      themeData: themeData
    });

    console.log(`✅ ${name} вошёл в ${family.name}${family.vip ? ' (VIP)' : ''}`);
  });

  socket.on('location', (data) => {
    if (!socket.familyId) return;

    const now = Date.now();
    const prev = users[socket.id];
    let status = 'active';
    let nearbyFamily = null;

    if (prev && prev.timestamp && prev.lat && prev.lng) {
      const dt = (now - prev.timestamp) / 1000;
      if (dt > 0.5 && dt < 60) {
        const dist = distanceMeters(prev.lat, prev.lng, data.lat, data.lng);
        const speed = dist / dt;
        if (speed > 1) status = 'moving';
      }
    }

    if (status !== 'moving' && data.home) {
      const dist = distanceMeters(data.lat, data.lng, data.home.lat, data.home.lng);
      if (dist < 100) status = 'home';
    }

    if (status !== 'moving' && status !== 'home' && prev && prev.lastMove) {
      const hoursIdle = (now - prev.lastMove) / (1000 * 60 * 60);
      const hour = new Date().getHours();
      const isNight = hour >= 23 || hour < 7;
      if (hoursIdle > 4 && isNight) status = 'sleeping';
    }

    if (status === 'active' || status === 'home') {
      for (const [id, u] of Object.entries(users)) {
        if (id === socket.id) continue;
        if (u.family === socket.familyId) continue;
        if (!u.lat || !u.lng) continue;

        const dist = distanceMeters(data.lat, data.lng, u.lat, u.lng);
        if (dist < 50) {
          nearbyFamily = u.family;
          status = 'visiting';
          break;
        }
      }
    }

    let lastMove = prev?.lastMove || now;
    if (prev && prev.lat && prev.lng) {
      const dist = distanceMeters(prev.lat, prev.lng, data.lat, data.lng);
      if (dist > 10) lastMove = now;
    } else {
      lastMove = now;
    }

    users[socket.id] = {
      lat: data.lat,
      lng: data.lng,
      name: socket.userName,
      family: socket.familyId,
      timestamp: now,
      lastMove: lastMove,
      status: status
    };

    const payload = {
      id: socket.id,
      lat: data.lat,
      lng: data.lng,
      name: socket.userName,
      family: socket.familyId,
      vip: !!socket.isVip,
      avatar: socket.avatar,
      status: status,
      nearbyFamily: nearbyFamily
    };

    socket.to('family:all').emit('location', payload);
    socket.to(`family:${socket.familyId}`).emit('location', payload);

    checkAllGathered();
  });

  socket.on('throw-snowball', (data) => {
    if (!socket.familyId) return;
    const targetId = data.targetId;
    if (!targetId) return;

    io.to(targetId).emit('snowball-received', {
      fromName: socket.userName,
      fromFamily: socket.familyId,
      fromAvatar: socket.avatar
    });
  });

  // === Ёлка желаний ===
  socket.on('add-wish', (data) => {
    if (!socket.familyId || !data.text) return;

    const wish = {
      id: Date.now() + '-' + Math.round(Math.random() * 1000),
      text: data.text.trim().slice(0, 100),
      family: socket.familyId,
      name: socket.userName,
      color: families[socket.familyId].color
    };

    wishes.push(wish);
    fs.writeFileSync(WISHES_FILE, JSON.stringify(wishes, null, 2));
    
    io.emit('new-wish', wish);
  });

  socket.on('get-wishes', () => {
    socket.emit('all-wishes', wishes);
  });

  // === Чат ===
  socket.on('chat-message', (data) => {
    if (!socket.familyId) return;
    if (!data.text && !data.imageUrl && !data.audioUrl && !data.videoUrl) return;

    const msg = {
      id: Date.now() + '-' + Math.round(Math.random() * 1000),
      text: (data.text || '').trim().slice(0, 500),
      imageUrl: data.imageUrl || null,
      audioUrl: data.audioUrl || null,
      videoUrl: data.videoUrl || null,
      name: socket.userName,
      family: socket.familyId,
      avatar: socket.avatar,
      time: Date.now(),
      reactions: {}
    };

    messages.push(msg);
    if (messages.length > MAX_MESSAGES) {
      messages.shift();
    }

    io.emit('chat-message', msg);
        // Отправляем Push всем подписчикам (кроме отправителя)
    const pushPayload = JSON.stringify({
      title: `💬 ${msg.name}`,
      body: msg.text || (msg.imageUrl ? '📷 Фото' : msg.audioUrl ? '🎤 Голосовое' : msg.videoUrl ? '⭕ Кружок' : 'Новое сообщение'),
      url: '/'
    });

    pushSubscriptions.forEach((sub) => {
      webpush.sendNotification(sub, pushPayload).catch((err) => {
        if (err.statusCode === 410 || err.statusCode === 404) {
          // Подписка устарела — удаляем
          const idx = pushSubscriptions.indexOf(sub);
          if (idx > -1) pushSubscriptions.splice(idx, 1);
        }
      });
    });
  });

  socket.on('get-messages', () => {
    socket.emit('all-messages', messages);
  });

  // === Реакции ===
  socket.on('add-reaction', (data) => {
    if (!socket.familyId || !data.messageId || !data.emoji) return;

    const msg = messages.find(m => m.id === data.messageId);
    if (!msg) return;

    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[data.emoji]) msg.reactions[data.emoji] = [];

    const arr = msg.reactions[data.emoji];
    const userId = socket.id;

    if (arr.includes(userId)) {
      msg.reactions[data.emoji] = arr.filter(id => id !== userId);
      if (msg.reactions[data.emoji].length === 0) {
        delete msg.reactions[data.emoji];
      }
    } else {
      arr.push(userId);
    }

    io.emit('reaction-updated', {
      messageId: msg.id,
      reactions: msg.reactions
    });
  });

  // === Push-подписка ===
socket.on('subscribe-push', (subscription) => {
  if (!subscription || !subscription.endpoint) return;
  
  // Проверяем, нет ли уже такой подписки
  const exists = pushSubscriptions.some(s => s.endpoint === subscription.endpoint);
  if (!exists) {
    pushSubscriptions.push(subscription);
    console.log('📲 Новая Push-подписка. Всего:', pushSubscriptions.length);
  }
});

  socket.on('disconnect', () => {
    console.log(`🔴 Отключился: ${socket.id}`);
    delete users[socket.id];

    if (socket.familyId) {
      io.to(`family:${socket.familyId}`).emit('user-left', socket.id);
      io.to('family:all').emit('user-left', socket.id);
    }
  });
});

server.listen(PORT, () => {
  console.log(`🎄 Сервер запущен: http://localhost:${PORT}`);
});