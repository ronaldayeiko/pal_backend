const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { mediaUpload, profilePhotoUpload, uploadDir } = require('./media_upload');
const { generateMissions } = require('./mission_generator');

const PROD = process.env.NODE_ENV === 'production';
const SECRET = process.env.JWT_SECRET || (PROD ? null : 'dev-secret');
if (!SECRET) throw new Error('JWT_SECRET is required in production');
const TYPES = ['ask', 'offer', 'event', 'going', 'other'];
const app = express();
app.use(cors());
app.use(express.json({ limit: '50kb' }));
app.use('/uploads', express.static(require('path').join(__dirname, '..', 'uploads')));

const wrap = (fn) => (req, res) => { try { fn(req, res); } catch (e) { console.error(e); res.status(500).json({ error: 'Something went wrong.' }); } };
const auth = (req, res, next) => {
  const h = req.headers.authorization || '';
  try { req.uid = jwt.verify(h.replace('Bearer ', ''), SECRET).uid; next(); }
  catch { res.status(401).json({ error: 'Please sign in again.' }); }
};
const normPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 9 && d.length <= 15 ? d : null; };
const userJson = (u) => ({
  id: u.id,
  name: u.name,
  username: u.username,
  email: u.email,
  campus: u.campus,
  country: u.country || null,
  city: u.city || null,
  profile_photo_url: u.profile_photo_url,
  profile_complete: !!(u.name && u.username),
  is_admin: String(process.env.PAL_ADMIN_IDS || '').split(',').map((id) => id.trim()).includes(String(u.id)),
});
const userCampus = (userId) => db.prepare('SELECT campus FROM users WHERE id=?').get(userId)?.campus || '';
const canManageActivity = (activity, userId) =>
  activity.created_by === userId ||
  String(process.env.PAL_ADMIN_IDS || '').split(',').map((id) => id.trim()).includes(String(userId));
function awardActivity(activity, userId) {
  const existing = db.prepare(`
    SELECT * FROM activity_verifications WHERE activity_id=? AND user_id=?
  `).get(activity.id, userId);
  if (existing) {
    return {
      already_verified: true,
      xp_awarded: existing.xp_awarded,
      cash_awarded: existing.cash_awarded,
      creature: null,
    };
  }
  const verifiedCount = db.prepare(
    'SELECT COUNT(*) AS count FROM activity_verifications WHERE user_id=?'
  ).get(userId).count;
  const creature = db.prepare(`
    SELECT id,name,rarity FROM pal_creatures
    WHERE id NOT IN (SELECT creature_id FROM user_creatures WHERE user_id=?)
    ORDER BY CASE rarity WHEN 'Common' THEN 1 WHEN 'Uncommon' THEN 2 WHEN 'Rare' THEN 3 WHEN 'Epic' THEN 4 ELSE 5 END
    LIMIT 1
  `).get(userId);
  db.transaction(() => {
    db.prepare(`
      INSERT INTO activity_verifications(activity_id,user_id,xp_awarded,cash_awarded)
      VALUES(?,?,?,?)
    `).run(activity.id, userId, activity.xp_reward, activity.cash_reward);
    if (creature) {
      db.prepare(`
        INSERT OR IGNORE INTO user_creatures(user_id,creature_id,activity_id)
        VALUES(?,?,?)
      `).run(userId, creature.id, activity.id);
    }
    const completed = verifiedCount + 1;
    if (completed >= 1) {
      db.prepare(`
        INSERT OR IGNORE INTO user_achievements(user_id,achievement_id,activity_id)
        VALUES(?,?,?)
      `).run(userId, 'first_verified', activity.id);
    }
    if (completed >= 5) {
      db.prepare(`
        INSERT OR IGNORE INTO user_achievements(user_id,achievement_id,activity_id)
        VALUES(?,?,?)
      `).run(userId, 'five_verified', activity.id);
    }
  })();
  return {
    already_verified: false,
    xp_awarded: activity.xp_reward,
    cash_awarded: activity.cash_reward,
    creature: creature ? { id: creature.id, name: creature.name, rarity: creature.rarity } : null,
  };
}
const normalizeEmail = (value) => {
  const email = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
};
const passwordHash = (password, salt = crypto.randomBytes(16).toString('hex')) =>
  `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
const passwordMatches = (password, stored) => {
  if (!stored || !stored.includes(':')) return false;
  const [salt, expectedHex] = stored.split(':');
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
};
const issueSession = (user) => ({
  token: jwt.sign({ uid: user.id }, SECRET, { expiresIn: '30d' }),
  user: userJson(user),
});

app.post('/v1/auth/signup', wrap((req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 50);
  const username = String(req.body.username || '').trim().toLowerCase();
  const campus = String(req.body.campus || '').trim().slice(0, 60);
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');

  if (!name || !campus) return res.status(400).json({ error: 'Add your name and campus.' });
  if (!/^[a-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Username must be 3–20 letters, numbers or _.' });
  if (!email) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return res.status(409).json({ error: 'An account already uses that email.' });
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) return res.status(409).json({ error: 'That username is taken.' });

  const result = db.prepare(`
    INSERT INTO users(phone, name, username, campus, email, password_hash)
    VALUES(?,?,?,?,?,?)
  `).run(`email:${email}`, name, username, campus, email, passwordHash(password));
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(result.lastInsertRowid);
  res.status(201).json(issueSession(user));
}));

app.post('/v1/auth/login', wrap((req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const user = email && db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user || !passwordMatches(password, user.password_hash)) {
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }
  res.json(issueSession(user));
}));

app.post('/v1/auth/request-otp', wrap((req, res) => {
  const phone = normPhone(req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Enter a valid phone number.' });
  const code = String(crypto.randomInt(100000, 1000000));
  db.prepare('INSERT OR REPLACE INTO otps(phone,code,expires_at,attempts) VALUES(?,?,?,0)').run(phone, code, Date.now() + 5 * 60000);
  // TODO: send via an SMS provider. Code is never returned in production.
  if (!PROD) console.log(`[dev] OTP for ${phone}: ${code}`);
  res.json({ ok: true });
}));

app.post('/v1/auth/verify-otp', wrap((req, res) => {
  const phone = normPhone(req.body.phone);
  const o = phone && db.prepare('SELECT * FROM otps WHERE phone=?').get(phone);
  if (!o || o.expires_at < Date.now() || o.attempts >= 5) return res.status(400).json({ error: 'That code has expired. Request a new one.' });
  if (o.code !== String(req.body.code)) {
    db.prepare('UPDATE otps SET attempts=attempts+1 WHERE phone=?').run(phone);
    return res.status(400).json({ error: "That code isn't right." });
  }
  db.prepare('DELETE FROM otps WHERE phone=?').run(phone);
  db.prepare('INSERT OR IGNORE INTO users(phone) VALUES(?)').run(phone);
  const u = db.prepare('SELECT * FROM users WHERE phone=?').get(phone);
  res.json({ token: jwt.sign({ uid: u.id }, SECRET, { expiresIn: '30d' }), user: userJson(u) });
}));

app.get('/v1/me', auth, wrap((req, res) => res.json(userJson(db.prepare('SELECT * FROM users WHERE id=?').get(req.uid)))));

app.get('/v1/me/qr', auth, wrap((req, res) => {
  let user = db.prepare('SELECT id,pal_qr_code FROM users WHERE id=?').get(req.uid);
  if (!user.pal_qr_code) {
    const code = `PAL-U-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
    db.prepare('UPDATE users SET pal_qr_code=? WHERE id=?').run(code, req.uid);
    user = { ...user, pal_qr_code: code };
  }
  res.json({ qr_code: user.pal_qr_code });
}));

app.patch('/v1/me', auth, wrap((req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 50);
  const username = String(req.body.username || '').trim().toLowerCase();
  const campus = String(req.body.campus || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Add your name.' });
  if (!/^[a-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Usernames are 3â€“20 letters, numbers or _.' });
  const taken = db.prepare('SELECT id FROM users WHERE username=? AND id<>?').get(username, req.uid);
  if (taken) return res.status(409).json({ error: 'That username is taken.' });
  db.prepare('UPDATE users SET name=?, username=?, campus=? WHERE id=?').run(name, username, campus, req.uid);
  res.json(userJson(db.prepare('SELECT * FROM users WHERE id=?').get(req.uid)));
}));

app.patch('/v1/me/location', auth, wrap((req, res) => {
  const country = String(req.body.country || '').trim().slice(0, 80);
  const city = String(req.body.city || '').trim().slice(0, 80);
  if (!country || !city) return res.status(400).json({ error: 'Add both your country and city.' });
  db.prepare('UPDATE users SET country=?,city=? WHERE id=?').run(country, city, req.uid);
  res.json(userJson(db.prepare('SELECT * FROM users WHERE id=?').get(req.uid)));
}));

app.post('/v1/me/photo', auth, (req, res) => {
  profilePhotoUpload.single('photo')(req, res, (uploadError) => {
    if (uploadError) return res.status(400).json({ error: uploadError.message });
    if (!req.file) return res.status(400).json({ error: 'Choose a profile photo.' });

    try {
      const user = db.prepare('SELECT profile_photo_url FROM users WHERE id=?').get(req.uid);
      const photoUrl = `/uploads/${req.file.filename}`;
      db.prepare('UPDATE users SET profile_photo_url=? WHERE id=?').run(photoUrl, req.uid);
      if (user?.profile_photo_url) removeUploadedFile(user.profile_photo_url);
      res.status(201).json(userJson(db.prepare('SELECT * FROM users WHERE id=?').get(req.uid)));
    } catch (error) {
      try { fs.unlinkSync(req.file.path); } catch {}
      console.error('Profile photo save error:', error);
      res.status(500).json({ error: 'Could not save profile photo.' });
    }
  });
});

app.delete('/v1/me/photo', auth, wrap((req, res) => {
  const user = db.prepare('SELECT profile_photo_url FROM users WHERE id=?').get(req.uid);
  db.prepare('UPDATE users SET profile_photo_url=NULL WHERE id=?').run(req.uid);
  if (user?.profile_photo_url) removeUploadedFile(user.profile_photo_url);
  res.json(userJson(db.prepare('SELECT * FROM users WHERE id=?').get(req.uid)));
}));

function removeUploadedFile(fileUrl) {
  if (typeof fileUrl !== 'string' || !fileUrl.startsWith('/uploads/')) return;
  const filePath = path.resolve(uploadDir, path.basename(fileUrl));
  if (!filePath.startsWith(`${path.resolve(uploadDir)}${path.sep}`)) return;
  try { fs.unlinkSync(filePath); } catch {}
}

const postSelect = `SELECT
  p.id,
  p.type,
  p.body,
  p.location,
  p.visibility,
  p.campus,
  p.created_at,
  u.name AS author_name,
  (SELECT COUNT(*) FROM replies r WHERE r.post_id=p.id) AS replies,
  (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id=p.id) AS likes,
  (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id) AS comments
FROM posts p
JOIN users u ON u.id=p.user_id`;
const postJson = (p, userId = null) => {
  const media = db.prepare(`
    SELECT id, media_type, file_url, sort_order, created_at
    FROM post_media
    WHERE post_id=?
    ORDER BY sort_order ASC, id ASC
  `).all(p.id);

  const liked = userId != null
    ? !!db.prepare(
        'SELECT 1 FROM post_likes WHERE post_id=? AND user_id=?'
      ).get(p.id, userId)
    : false;

  const saved = userId != null
    ? !!db.prepare(
        'SELECT 1 FROM post_saves WHERE post_id=? AND user_id=?'
      ).get(p.id, userId)
    : false;

  return {
    ...p,
    location: p.visibility === 'public' ? p.location : null,
    id: String(p.id),
    likes: Number(p.likes || 0),
    liked,
    saved,
    comments: Number(p.comments || 0),
    created_at: new Date(
      p.created_at.replace(' ', 'T') + 'Z'
    ).toISOString(),
    nearby: 0,
    media: media.map((m) => ({
      id: String(m.id),
      media_type: m.media_type,
      file_url: m.file_url,
      sort_order: m.sort_order,
      created_at: new Date(
        m.created_at.replace(' ', 'T') + 'Z'
      ).toISOString(),
    })),
  };
};

 
// Activity API

app.get('/v1/activities', auth, wrap((req, res) => {
  generateMissions(db, req.uid);
  const rows = db.prepare(`
    SELECT
      a.*,
      COUNT(DISTINCT am.user_id) AS participants
    FROM activities a
    LEFT JOIN activity_members am
      ON am.activity_id = a.id
    WHERE a.status = 'active'
      AND (a.visibility = 'public' OR a.campus = ?)
    GROUP BY a.id
    ORDER BY a.id DESC
    LIMIT 50
  `).all(userCampus(req.uid));

  const activities = rows.map((a) => {
    const joined = !!db.prepare(
      'SELECT 1 FROM activity_members WHERE activity_id=? AND user_id=?'
    ).get(a.id, req.uid);

    const { qr_code, ...publicActivity } = a;
    return {
      ...publicActivity,
      id: String(a.id),
      is_mission: !!a.generated_key,
      participants: Number(a.participants || 0),
      xp_reward: Number(a.xp_reward || 0),
      cash_reward: Number(a.cash_reward || 0),
      joined,
      verified: !!db.prepare('SELECT 1 FROM activity_verifications WHERE activity_id=? AND user_id=?').get(a.id, req.uid),
    };
  });

  res.json({ data: activities });
}));

app.get('/v1/missions', auth, wrap((req, res) => {
  const missions = generateMissions(db, req.uid).map((mission) => {
    const { qr_code, ...publicMission } = mission;
    return {
    ...publicMission,
    id: String(mission.id),
    is_mission: true,
    participants: Number(db.prepare(
      'SELECT COUNT(*) AS count FROM activity_members WHERE activity_id=?'
    ).get(mission.id).count || 0),
    xp_reward: Number(mission.xp_reward || 0),
    cash_reward: Number(mission.cash_reward || 0),
    joined: !!db.prepare(
      'SELECT 1 FROM activity_members WHERE activity_id=? AND user_id=?'
    ).get(mission.id, req.uid),
    verified: !!db.prepare('SELECT 1 FROM activity_verifications WHERE activity_id=? AND user_id=?').get(mission.id, req.uid),
  }; });
  res.json({ data: missions });
}));

app.get('/v1/creatures', auth, wrap((_req, res) => {
  res.json({ data: db.prepare(
    'SELECT id,name,description,rarity,availability,color FROM pal_creatures ORDER BY CASE rarity WHEN ? THEN 1 WHEN ? THEN 2 WHEN ? THEN 3 WHEN ? THEN 4 ELSE 5 END,name'
  ).all('Common', 'Uncommon', 'Rare', 'Epic') });
}));

app.get('/v1/me/creatures', auth, wrap((req, res) => {
  res.json({ data: db.prepare(`
    SELECT c.id,c.name,c.description,c.rarity,c.availability,c.color,uc.activity_id,uc.unlocked_at
    FROM user_creatures uc JOIN pal_creatures c ON c.id=uc.creature_id
    WHERE uc.user_id=? ORDER BY uc.unlocked_at DESC
  `).all(req.uid) });
}));

app.get('/v1/me/achievements', auth, wrap((req, res) => {
  res.json({ data: db.prepare(`
    SELECT a.id,a.name,a.description,ua.activity_id,ua.awarded_at
    FROM user_achievements ua JOIN pal_achievements a ON a.id=ua.achievement_id
    WHERE ua.user_id=? ORDER BY ua.awarded_at DESC
  `).all(req.uid) });
}));

app.get('/v1/activity-feed', auth, wrap((req, res) => {
  const data = db.prepare(`
    SELECT v.id,v.activity_id,v.user_id,v.created_at,a.title,u.name AS user_name,c.name AS creature_name,c.rarity AS creature_rarity
    FROM activity_verifications v
    JOIN activities a ON a.id=v.activity_id
    JOIN users u ON u.id=v.user_id
    LEFT JOIN user_creatures uc ON uc.user_id=v.user_id AND uc.activity_id=v.activity_id
    LEFT JOIN pal_creatures c ON c.id=uc.creature_id
    WHERE a.visibility='public' OR a.campus=?
    ORDER BY v.id DESC LIMIT 50
  `).all(userCampus(req.uid)).map((item) => ({
    ...item,
    id: String(item.id),
    activity_id: String(item.activity_id),
    user_id: String(item.user_id),
  }));
  res.json({ data });
}));

app.get('/v1/leaderboard', auth, wrap((req, res) => {
  const scope = ['global', 'country', 'city'].includes(req.query.scope) ? req.query.scope : 'global';
  const period = ['week', 'month', 'all'].includes(req.query.period) ? req.query.period : 'week';
  const currentUser = db.prepare('SELECT id,country,city FROM users WHERE id=?').get(req.uid);
  const scopeValue = scope === 'country' ? currentUser.country : scope === 'city' ? currentUser.city : null;
  if (scope !== 'global' && !scopeValue) {
    return res.json({ data: [], me: null, scope, period, needs_location: true });
  }
  const interval = period === 'week' ? '-7 days' : period === 'month' ? '-1 month' : null;
  const query = `
    WITH verified AS (
      SELECT user_id,SUM(xp_awarded) AS xp,COUNT(*) AS activity_count
      FROM activity_verifications
      WHERE (? IS NULL OR created_at >= datetime('now', ?))
      GROUP BY user_id
    ), achievements AS (
      SELECT user_id,COUNT(*) AS achievement_count
      FROM user_achievements
      WHERE (? IS NULL OR awarded_at >= datetime('now', ?))
      GROUP BY user_id
    ), ranked AS (
      SELECT
        u.id,u.name,u.username,u.profile_photo_url,u.country,u.city,
        COALESCE(v.activity_count,0) AS verified_activities,
        COALESCE(a.achievement_count,0) AS verified_achievements,
        COALESCE(v.xp,0) + COALESCE(a.achievement_count,0) * 100 AS score,
        ROW_NUMBER() OVER (
          ORDER BY COALESCE(v.xp,0) + COALESCE(a.achievement_count,0) * 100 DESC,
            COALESCE(v.activity_count,0) DESC, u.name COLLATE NOCASE, u.id
        ) AS rank
      FROM users u
      LEFT JOIN verified v ON v.user_id=u.id
      LEFT JOIN achievements a ON a.user_id=u.id
      WHERE (COALESCE(v.activity_count,0)>0 OR COALESCE(a.achievement_count,0)>0)
        AND (?='global' OR (?='country' AND lower(u.country)=lower(?)) OR (?='city' AND lower(u.city)=lower(?) AND lower(u.country)=lower(?)))
    )
    SELECT * FROM ranked ORDER BY rank
  `;
  const params = [interval, interval, interval, interval, scope, scope, scopeValue, scope, scopeValue, currentUser.country];
  const records = db.prepare(query).all(...params).map((row) => ({
    ...row,
    id: String(row.id),
    rank: Number(row.rank),
    score: Number(row.score),
    verified_activities: Number(row.verified_activities),
    verified_achievements: Number(row.verified_achievements),
  }));
  const me = records.find((row) => row.id === String(req.uid)) || null;
  res.json({ data: records.slice(0, 50), me, scope, period, needs_location: false });
}));

app.post('/v1/activities', auth, wrap((req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 80);
  const description = String(req.body.description || '').trim().slice(0, 1000);
  const location = String(req.body.location || '').trim().slice(0, 120);
  const campus = String(userCampus(req.uid)).trim();
  const startsAt = req.body.starts_at ? Date.parse(req.body.starts_at) : Date.now();
  const endsAt = req.body.ends_at ? Date.parse(req.body.ends_at) : startsAt + 7 * 86400000;
  if (!title || !location || !campus || !Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) {
    return res.status(400).json({ error: 'Add a title, campus location, and valid start and end times.' });
  }
  const qrCode = `PAL-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
  const visibility = req.body.visibility === 'public' ? 'public' : 'campus';
  const result = db.prepare(`
    INSERT INTO activities(title,description,location,starts_at,ends_at,xp_reward,cash_reward,qr_code,qr_expires_at,status,created_by,campus,visibility)
    VALUES(?,?,?,?,?,?,0,?,?, 'active',?,?,?)
  `).run(title, description, location, new Date(startsAt).toISOString(), new Date(endsAt).toISOString(), 100, qrCode, endsAt, req.uid, campus, visibility);
  res.status(201).json({ id: String(result.lastInsertRowid), qr_code: qrCode, expires_at: endsAt, visibility });
}));

app.post('/v1/activities/:id/qr', auth, wrap((req, res) => {
  const activity = db.prepare('SELECT * FROM activities WHERE id=?').get(req.params.id);
  if (!activity) return res.status(404).json({ error: 'Activity not found.' });
  if (!canManageActivity(activity, req.uid)) return res.status(403).json({ error: 'Only the activity creator or a PAL admin can refresh this QR code.' });
  const qrCode = `PAL-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
  const expiresAt = activity.ends_at ? Date.parse(activity.ends_at) : Date.now() + 7 * 86400000;
  db.prepare('UPDATE activities SET qr_code=?,qr_expires_at=? WHERE id=?').run(qrCode, expiresAt, activity.id);
  res.json({ id: String(activity.id), qr_code: qrCode, expires_at: expiresAt });
}));

app.get('/v1/activities/:id', auth, wrap((req, res) => {
  const activity = db.prepare(`
    SELECT
      a.*,
      COUNT(DISTINCT am.user_id) AS participants
    FROM activities a
    LEFT JOIN activity_members am
      ON am.activity_id = a.id
    WHERE a.id = ? AND (a.visibility = 'public' OR a.campus = ?)
    GROUP BY a.id
  `).get(req.params.id, userCampus(req.uid));

  if (!activity) {
    return res.status(404).json({
      error: 'Activity not found.',
    });
  }

  const joined = !!db.prepare(
    'SELECT 1 FROM activity_members WHERE activity_id=? AND user_id=?'
  ).get(activity.id, req.uid);

  const { qr_code, ...publicActivity } = activity;
  res.json({
    ...publicActivity,
    id: String(activity.id),
    is_mission: !!activity.generated_key,
    participants: Number(activity.participants || 0),
    xp_reward: Number(activity.xp_reward || 0),
    cash_reward: Number(activity.cash_reward || 0),
    joined,
    verified: !!db.prepare('SELECT 1 FROM activity_verifications WHERE activity_id=? AND user_id=?').get(activity.id, req.uid),
  });
}));

app.get('/v1/scan/:code', auth, wrap((req, res) => {
  const activity = db.prepare(`
    SELECT
      a.*,
      COUNT(DISTINCT am.user_id) AS participants
    FROM activities a
    LEFT JOIN activity_members am
      ON am.activity_id = a.id
    WHERE a.qr_code = ? AND (a.visibility = 'public' OR a.campus = ?)
      AND a.status = 'active'
      AND (a.qr_expires_at IS NULL OR a.qr_expires_at > ?)
    GROUP BY a.id
  `).get(req.params.code, userCampus(req.uid), Date.now());

  if (!activity) {
    const profile = db.prepare(
      'SELECT name,username,campus FROM users WHERE pal_qr_code=?'
    ).get(req.params.code);
    if (profile) return res.json({ kind: 'profile', profile });
    return res.status(404).json({
      error: 'PAL code not found.',
    });
  }

  const joined = !!db.prepare(
    'SELECT 1 FROM activity_members WHERE activity_id=? AND user_id=?'
  ).get(activity.id, req.uid);

  db.prepare(`
    INSERT OR IGNORE INTO activity_qr_scans(activity_id,user_id,scanned_at)
    VALUES(?,?,?)
  `).run(activity.id, req.uid, Date.now());

  const { qr_code, ...publicActivity } = activity;
  res.json({
    ...publicActivity,
    kind: 'activity',
    id: String(activity.id),
    is_mission: !!activity.generated_key,
    participants: Number(activity.participants || 0),
    xp_reward: Number(activity.xp_reward || 0),
    cash_reward: Number(activity.cash_reward || 0),
    joined,
    verified: !!db.prepare('SELECT 1 FROM activity_verifications WHERE activity_id=? AND user_id=?').get(activity.id, req.uid),
  });
}));

app.post('/v1/activities/:id/join', auth, wrap((req, res) => {
  const activity = db.prepare(
    "SELECT * FROM activities WHERE id=? AND status=? AND (visibility='public' OR campus=?)"
  ).get(req.params.id, 'active', userCampus(req.uid));

  if (!activity) {
    return res.status(404).json({
      error: 'Activity not found.',
    });
  }

  db.prepare(`
    INSERT OR IGNORE INTO activity_members
      (activity_id, user_id)
    VALUES (?, ?)
  `).run(activity.id, req.uid);

  const participants = db.prepare(
    'SELECT COUNT(*) AS count FROM activity_members WHERE activity_id=?'
  ).get(activity.id).count;

  res.json({
    joined: true,
    participants: Number(participants),
  });
}));

app.post('/v1/activities/:id/verify', auth, wrap((req, res) => {
  const activity = db.prepare(
    "SELECT * FROM activities WHERE id=? AND status=? AND (visibility='public' OR campus=?)"
  ).get(req.params.id, 'active', userCampus(req.uid));

  if (!activity) {
    return res.status(404).json({
      error: 'Activity not found.',
    });
  }

  const joined = db.prepare(
    'SELECT 1 FROM activity_members WHERE activity_id=? AND user_id=?'
  ).get(activity.id, req.uid);

  if (!joined) {
    return res.status(400).json({
      error: 'Join the activity first.',
    });
  }

  const existing = db.prepare(`
    SELECT *
    FROM activity_verifications
    WHERE activity_id=? AND user_id=?
  `).get(activity.id, req.uid);

  if (existing) {
    return res.json({
      verified: true,
      already_verified: true,
      xp_awarded: existing.xp_awarded,
      cash_awarded: existing.cash_awarded,
    });
  }

  const scan = db.prepare(`
    SELECT id FROM activity_qr_scans
    WHERE activity_id=? AND user_id=? AND used_at IS NULL AND scanned_at>=?
    ORDER BY scanned_at DESC LIMIT 1
  `).get(activity.id, req.uid, Date.now() - 10 * 60 * 1000);
  if (!scan) {
    return res.status(400).json({ error: 'Scan this activity’s PAL QR code before claiming its reward.' });
  }

  const transaction = db.transaction(() => {
    db.prepare('UPDATE activity_qr_scans SET used_at=? WHERE id=?').run(Date.now(), scan.id);
    awardActivity(activity, req.uid);
  });
  transaction();

  const result = db.prepare(`
    SELECT xp_awarded,cash_awarded FROM activity_verifications
    WHERE activity_id=? AND user_id=?
  `).get(activity.id, req.uid);
  const unlockedCreature = db.prepare(`
    SELECT c.id,c.name,c.rarity FROM user_creatures uc
    JOIN pal_creatures c ON c.id=uc.creature_id
    WHERE uc.user_id=? AND uc.activity_id=?
  `).get(req.uid, activity.id);
  res.json({
    verified: true,
    already_verified: false,
    ...result,
    creature: unlockedCreature || null,
  });
}));

app.post('/v1/activities/:id/evidence', auth, (req, res) => {
  profilePhotoUpload.single('evidence')(req, res, (uploadError) => {
    if (uploadError) return res.status(400).json({ error: uploadError.message });
    try {
      const activity = db.prepare(
        "SELECT * FROM activities WHERE id=? AND status='active' AND (visibility='public' OR campus=?)"
      ).get(req.params.id, userCampus(req.uid));
      if (!activity) {
        if (req.file) removeUploadedFile(`/uploads/${req.file.filename}`);
        return res.status(404).json({ error: 'Activity not found.' });
      }
      const joined = db.prepare(
        'SELECT 1 FROM activity_members WHERE activity_id=? AND user_id=?'
      ).get(activity.id, req.uid);
      if (!joined) {
        if (req.file) removeUploadedFile(`/uploads/${req.file.filename}`);
        return res.status(400).json({ error: 'Join the activity before submitting evidence.' });
      }
      if (db.prepare("SELECT 1 FROM activity_evidence WHERE activity_id=? AND user_id=? AND status='pending'").get(activity.id, req.uid)) {
        if (req.file) removeUploadedFile(`/uploads/${req.file.filename}`);
        return res.status(409).json({ error: 'Your photo evidence is already awaiting review.' });
      }
      if (db.prepare('SELECT 1 FROM activity_verifications WHERE activity_id=? AND user_id=?').get(activity.id, req.uid)) {
        if (req.file) removeUploadedFile(`/uploads/${req.file.filename}`);
        return res.status(409).json({ error: 'This activity has already been verified.' });
      }
      if (!req.file) return res.status(400).json({ error: 'Choose a photo as evidence.' });
      const fileUrl = `/uploads/${req.file.filename}`;
      const result = db.prepare(`
        INSERT INTO activity_evidence(activity_id,user_id,file_url)
        VALUES(?,?,?)
      `).run(activity.id, req.uid, fileUrl);
      res.status(201).json({ id: String(result.lastInsertRowid), status: 'pending', file_url: fileUrl });
    } catch (error) {
      if (req.file) removeUploadedFile(`/uploads/${req.file.filename}`);
      console.error('Evidence submission error:', error);
      res.status(500).json({ error: 'Could not save evidence.' });
    }
  });
});

app.get('/v1/activities/:id/evidence/me', auth, wrap((req, res) => {
  const evidence = db.prepare(`
    SELECT id,status,created_at,reviewed_at FROM activity_evidence
    WHERE activity_id=? AND user_id=? ORDER BY id DESC LIMIT 1
  `).get(req.params.id, req.uid);
  res.json({ evidence: evidence ? { ...evidence, id: String(evidence.id) } : null });
}));

app.get('/v1/admin/evidence', auth, wrap((req, res) => {
  if (!userJson(db.prepare('SELECT * FROM users WHERE id=?').get(req.uid)).is_admin) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  const data = db.prepare(`
    SELECT e.id,e.activity_id,e.user_id,e.file_url,e.status,e.created_at,a.title,u.name AS user_name
    FROM activity_evidence e
    JOIN activities a ON a.id=e.activity_id
    JOIN users u ON u.id=e.user_id
    WHERE e.status='pending' ORDER BY e.created_at ASC
  `).all().map((item) => ({ ...item, id: String(item.id), activity_id: String(item.activity_id), user_id: String(item.user_id) }));
  res.json({ data });
}));

app.patch('/v1/admin/evidence/:id', auth, wrap((req, res) => {
  if (!userJson(db.prepare('SELECT * FROM users WHERE id=?').get(req.uid)).is_admin) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  const status = req.body.status;
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Choose approved or rejected.' });
  const evidence = db.prepare("SELECT * FROM activity_evidence WHERE id=? AND status='pending'").get(req.params.id);
  if (!evidence) return res.status(404).json({ error: 'Pending evidence not found.' });
  db.transaction(() => {
    db.prepare('UPDATE activity_evidence SET status=?,reviewed_at=CURRENT_TIMESTAMP,reviewed_by=? WHERE id=?').run(status, req.uid, evidence.id);
    if (status === 'approved') {
      const activity = db.prepare('SELECT * FROM activities WHERE id=?').get(evidence.activity_id);
      awardActivity(activity, evidence.user_id);
    }
  })();
  res.json({ id: String(evidence.id), status });
}));
app.get('/v1/posts', auth, wrap((req, res) =>
  res.json({
    data: db
      .prepare(`${postSelect} WHERE p.visibility='public' OR p.campus=? ORDER BY p.id DESC LIMIT 50`)
      .all(userCampus(req.uid))
      .map((post) => postJson(post, req.uid)),
  })
));

app.post('/v1/posts', auth, wrap((req, res) => {
  const body = String(req.body.body || '').trim();
  const type = req.body.type;
  if (!TYPES.includes(type)) return res.status(400).json({ error: 'Pick what kind of post this is.' });
  if (!body || body.length > 280) return res.status(400).json({ error: 'Posts are 1â€“280 characters.' });
  const location = req.body.location ? String(req.body.location).slice(0, 80) : null;
  const campus = userCampus(req.uid);
  const visibility = req.body.visibility === 'public' ? 'public' : 'campus';
  const id = db.prepare('INSERT INTO posts(user_id,type,body,location,campus,visibility) VALUES(?,?,?,?,?,?)').run(req.uid, type, body, location, campus, visibility).lastInsertRowid;
  res.status(201).json(
    postJson(
      db.prepare(`${postSelect} WHERE p.id=?`).get(id),
      req.uid
    )
  );
}));

const mediaUploadHandler = mediaUpload.array('media', 10);

app.post('/v1/posts/:id/media', auth, (req, res) => {
  mediaUploadHandler(req, res, (err) => {
    if (err) {
      console.error('Media upload error:', err.message);
      return res.status(400).json({ error: err.message });
    }

    try {
      const postId = Number(req.params.id);

      if (!Number.isInteger(postId) || postId <= 0) {
        for (const file of req.files || []) {
          try { require('fs').unlinkSync(file.path); } catch {}
        }
        return res.status(400).json({ error: 'Invalid post.' });
      }

      const post = db.prepare(
        'SELECT id, user_id FROM posts WHERE id=?'
      ).get(postId);

      if (!post) {
        for (const file of req.files || []) {
          try { require('fs').unlinkSync(file.path); } catch {}
        }
        return res.status(404).json({ error: 'That post is gone.' });
      }

      if (post.user_id !== req.uid) {
        for (const file of req.files || []) {
          try { require('fs').unlinkSync(file.path); } catch {}
        }
        return res.status(403).json({
          error: 'You can only add media to your own posts.'
        });
      }

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({
          error: 'Choose at least one image or video.'
        });
      }

      const insert = db.prepare(`
        INSERT INTO post_media(
          post_id,
          media_type,
          file_url,
          sort_order
        )
        VALUES(?,?,?,?)
      `);

      const transaction = db.transaction((files) => {
        return files.map((file, index) => {
          const mediaType = file.mimetype.startsWith('video/')
            ? 'video'
            : 'image';

          const fileUrl = `/uploads/${file.filename}`;

          const result = insert.run(
            postId,
            mediaType,
            fileUrl,
            index
          );

          return {
            id: String(result.lastInsertRowid),
            post_id: String(postId),
            media_type: mediaType,
            file_url: fileUrl,
            sort_order: index,
          };
        });
      });

      const media = transaction(req.files);

      res.status(201).json({ data: media });
    } catch (e) {
      console.error('Media database error:', e);

      for (const file of req.files || []) {
        try { require('fs').unlinkSync(file.path); } catch {}
      }

      res.status(500).json({ error: 'Could not save media.' });
    }
  });
});

// ==================== SOCIAL API ====================

app.post('/v1/posts/:id/like', auth, wrap((req, res) => {
  const postId = Number(req.params.id);

  const post = db.prepare(
    'SELECT id FROM posts WHERE id=?'
  ).get(postId);

  if (!post) {
    return res.status(404).json({ error: 'That post is gone.' });
  }

  db.prepare(
    'INSERT OR IGNORE INTO post_likes(post_id,user_id) VALUES(?,?)'
  ).run(postId, req.uid);

  const count = db.prepare(
    'SELECT COUNT(*) AS count FROM post_likes WHERE post_id=?'
  ).get(postId).count;

  res.json({
    liked: true,
    likes: count,
  });
}));

app.delete('/v1/posts/:id/like', auth, wrap((req, res) => {
  const postId = Number(req.params.id);

  db.prepare(
    'DELETE FROM post_likes WHERE post_id=? AND user_id=?'
  ).run(postId, req.uid);

  const count = db.prepare(
    'SELECT COUNT(*) AS count FROM post_likes WHERE post_id=?'
  ).get(postId).count;

  res.json({
    liked: false,
    likes: count,
  });
}));

app.post('/v1/posts/:id/save', auth, wrap((req, res) => {
  const postId = Number(req.params.id);

  const post = db.prepare(
    'SELECT id FROM posts WHERE id=?'
  ).get(postId);

  if (!post) {
    return res.status(404).json({ error: 'That post is gone.' });
  }

  db.prepare(
    'INSERT OR IGNORE INTO post_saves(post_id,user_id) VALUES(?,?)'
  ).run(postId, req.uid);

  res.json({ saved: true });
}));

app.delete('/v1/posts/:id/save', auth, wrap((req, res) => {
  const postId = Number(req.params.id);

  db.prepare(
    'DELETE FROM post_saves WHERE post_id=? AND user_id=?'
  ).run(postId, req.uid);

  res.json({ saved: false });
}));

app.get('/v1/posts/:id/comments', auth, wrap((req, res) => {
  const postId = Number(req.params.id);

  const comments = db.prepare(`
    SELECT
      c.id,
      c.body,
      c.created_at,
      u.id AS user_id,
      u.name AS author_name,
      u.username AS author_username
    FROM comments c
    JOIN users u ON u.id=c.user_id
    WHERE c.post_id=?
    ORDER BY c.id ASC
  `).all(postId);

  res.json({
    data: comments.map((c) => ({
      ...c,
      id: String(c.id),
      user_id: String(c.user_id),
      created_at: new Date(
        c.created_at.replace(' ', 'T') + 'Z'
      ).toISOString(),
    })),
  });
}));

app.post('/v1/posts/:id/comments', auth, wrap((req, res) => {
  const postId = Number(req.params.id);
  const body = String(req.body.body || '').trim();

  if (!Number.isInteger(postId) || postId <= 0) {
    return res.status(400).json({ error: 'Invalid post.' });
  }

  if (!body || body.length > 280) {
    return res.status(400).json({
      error: 'Comments are 1–280 characters.',
    });
  }

  const post = db.prepare(
    'SELECT id FROM posts WHERE id=?'
  ).get(postId);

  if (!post) {
    return res.status(404).json({ error: 'That post is gone.' });
  }

  const result = db.prepare(`
    INSERT INTO comments(post_id,user_id,body)
    VALUES(?,?,?)
  `).run(postId, req.uid, body);

  const comment = db.prepare(`
    SELECT
      c.id,
      c.body,
      c.created_at,
      u.id AS user_id,
      u.name AS author_name,
      u.username AS author_username
    FROM comments c
    JOIN users u ON u.id=c.user_id
    WHERE c.id=?
  `).get(result.lastInsertRowid);

  res.status(201).json({
    ...comment,
    id: String(comment.id),
    user_id: String(comment.user_id),
    created_at: new Date(
      comment.created_at.replace(' ', 'T') + 'Z'
    ).toISOString(),
  });
}));

// ==================== END SOCIAL API ====================

app.get('/v1/posts/:id/replies', auth, wrap((req, res) =>
  res.json({ data: db.prepare(`SELECT r.id,r.body,r.created_at,u.name AS author_name FROM replies r JOIN users u ON u.id=r.user_id WHERE r.post_id=? ORDER BY r.id`).all(req.params.id) })));

app.post('/v1/posts/:id/replies', auth, wrap((req, res) => {
  const body = String(req.body.body || '').trim();
  if (!body || body.length > 280) return res.status(400).json({ error: 'Replies are 1â€“280 characters.' });
  if (!db.prepare('SELECT 1 FROM posts WHERE id=?').get(req.params.id)) return res.status(404).json({ error: 'That post is gone.' });
  db.prepare('INSERT INTO replies(post_id,user_id,body) VALUES(?,?,?)').run(req.params.id, req.uid, body);
  res.status(201).json({ ok: true });
}));

// Balance = sum of COMPLETED rows only. Nothing here can complete a transaction.
app.get('/v1/wallet', auth, wrap((req, res) => {
  const bal = db.prepare("SELECT COALESCE(SUM(amount),0) AS b FROM transactions WHERE user_id=? AND status='completed'").get(req.uid).b;
  const tx = db.prepare('SELECT id,amount,kind,counterparty,status,created_at FROM transactions WHERE user_id=? ORDER BY id DESC LIMIT 50').all(req.uid);
  res.json({ balance: bal, currency: 'KES', transactions: tx });
}));

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
if (require.main === module) app.listen(process.env.PORT || 3000, () => console.log('PAL API up'));
module.exports = app;






