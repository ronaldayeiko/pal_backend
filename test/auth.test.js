const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { once } = require('node:events');
const { dailyTemplates } = require('../src/mission_generator');

const databasePath = path.join(os.tmpdir(), `pal-auth-test-${process.pid}.db`);
const setupDb = new Database(databasePath);
setupDb.exec(`
  CREATE TABLE activities(
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    cover_url TEXT,
    location TEXT NOT NULL DEFAULT '',
    starts_at TEXT,
    ends_at TEXT,
    xp_reward INTEGER NOT NULL DEFAULT 0,
    cash_reward INTEGER NOT NULL DEFAULT 0,
    qr_code TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_by INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE activity_members(
    activity_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    PRIMARY KEY(activity_id, user_id)
  );
  CREATE TABLE activity_verifications(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    verified_at TEXT DEFAULT CURRENT_TIMESTAMP,
    xp_awarded INTEGER NOT NULL DEFAULT 0,
    cash_awarded INTEGER NOT NULL DEFAULT 0,
    UNIQUE(activity_id, user_id)
  );
  INSERT INTO activity_verifications(activity_id,user_id,verified_at,xp_awarded,cash_awarded)
  VALUES(999,999,'2026-10-02 10:44:42',0,0);
`);
setupDb.close();

process.env.DB_PATH = databasePath;
const app = require('../src/server');
const db = require('../src/db');
let server;
let baseUrl;
let token;

before(async () => {
  server = app.listen(0);
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await once(server, 'close');
  db.close();
  for (const suffix of ['', '-shm', '-wal']) {
    try {
      fs.unlinkSync(`${databasePath}${suffix}`);
    } catch {}
  }
});

test('email signup, login, and authenticated session', async () => {
  const migratedVerification = db.prepare(
    'SELECT verified_at,created_at FROM activity_verifications WHERE user_id=999'
  ).get();
  assert.equal(migratedVerification.created_at, migratedVerification.verified_at);

  const signup = await fetch(`${baseUrl}/v1/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Test PAL',
      username: 'test_pal',
      email: 'test@example.com',
      password: 'password123',
      campus: 'Test campus',
    }),
  });
  const created = await signup.json();
  assert.equal(signup.status, 201);
  assert.ok(created.token);

  const login = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'test@example.com', password: 'password123' }),
  });
  const session = await login.json();
  assert.equal(login.status, 200);
  assert.ok(session.token);
  token = session.token;

  const rejectedLogin = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'test@example.com', password: 'wrongpass' }),
  });
  assert.equal(rejectedLogin.status, 401);

  const me = await fetch(`${baseUrl}/v1/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const user = await me.json();
  assert.equal(me.status, 200);
  assert.equal(user.email, 'test@example.com');
  assert.equal(user.profile_complete, true);
});

test('profile photo can be uploaded and removed', async () => {
  const form = new FormData();
  form.append('photo', new Blob([Buffer.from('test image')], { type: 'image/png' }), 'avatar.png');
  const upload = await fetch(`${baseUrl}/v1/me/photo`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const userWithPhoto = await upload.json();
  assert.equal(upload.status, 201);
  assert.match(userWithPhoto.profile_photo_url, /^\/uploads\//);

  const removal = await fetch(`${baseUrl}/v1/me/photo`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  const userWithoutPhoto = await removal.json();
  assert.equal(removal.status, 200);
  assert.equal(userWithoutPhoto.profile_photo_url, null);
});

test('mission generation reuses known locations and is idempotent', async () => {
  const currentUserResponse = await fetch(`${baseUrl}/v1/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const currentUser = await currentUserResponse.json();
  db.prepare(`
    INSERT INTO activities(title, location, xp_reward, status, created_by, campus)
    VALUES(?, ?, ?, ?, ?, ?)
  `).run(
    'Existing campus activity',
    'PAL Test Library',
    50,
    'active',
    currentUser.id,
    currentUser.campus,
  );

  const firstResponse = await fetch(`${baseUrl}/v1/missions`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const first = await firstResponse.json();
  assert.equal(firstResponse.status, 200);
  assert.equal(first.data.length, 3);
  assert.ok(first.data.every((mission) => mission.location === 'PAL Test Library'));
  assert.ok(first.data.every((mission) => mission.is_mission && mission.xp_reward > 0));

  db.prepare(`
    INSERT INTO activities(title, location, status, created_by, campus)
    VALUES(?, ?, ?, ?, ?)
  `).run('New campus activity', 'PAL Test Garden', 'active', currentUser.id, currentUser.campus);

  const secondResponse = await fetch(`${baseUrl}/v1/missions`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const second = await secondResponse.json();
  assert.equal(second.data.length, first.data.length * 2);
  assert.ok(second.data.some((mission) => mission.location === 'PAL Test Garden'));
});

test('daily mission challenges rotate across days', () => {
  const today = dailyTemplates('2026-10-03').map((item) => item.key);
  const tomorrow = dailyTemplates('2026-10-04').map((item) => item.key);
  assert.equal(today.length, 3);
  assert.equal(tomorrow.length, 3);
  assert.notDeepEqual(today, tomorrow);
});

test('activity poster can retrieve the manual QR code and posted duration', async () => {
  const me = await fetch(`${baseUrl}/v1/me`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((response) => response.json());
  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + 4 * 86400000);
  const created = await fetch(`${baseUrl}/v1/activities`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Poster QR test',
      description: 'Manual code test',
      location: 'PAL Poster Test Hall',
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
    }),
  }).then((response) => response.json());
  assert.match(created.qr_code, /^PAL-/);
  assert.equal(created.created_by, Number(me.id));
  assert.equal(created.duration_days, 4);

  const posterQr = await fetch(`${baseUrl}/v1/activities/${created.id}/qr`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((response) => response.json());
  assert.equal(posterQr.qr_code, created.qr_code);
  assert.equal(posterQr.duration_days, 4);
  assert.ok(posterQr.days_remaining > 0);

  const publicActivity = await fetch(`${baseUrl}/v1/activities/${created.id}`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((response) => response.json());
  assert.equal('qr_code' in publicActivity, false);
});

test('activity rewards require a scanned QR and unlock server-owned records', async () => {
  const me = await fetch(`${baseUrl}/v1/me`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((response) => response.json());
  const code = 'PAL-TEST-QR-ONE-TIME';
  const activityId = db.prepare(`
    INSERT INTO activities(title,description,location,xp_reward,cash_reward,qr_code,qr_expires_at,status,created_by,campus,generated_key)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)
  `).run('Verified library visit', 'Visit the shared library.', 'PAL Test Library', 1000, 75, code, Date.now() + 60000, 'active', me.id, me.campus, 'test-level-one-mission').lastInsertRowid;
  db.prepare('UPDATE activities SET ends_at=? WHERE id=?').run(new Date(Date.now() + 86400000).toISOString(), activityId);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const listed = await fetch(`${baseUrl}/v1/activities`, { headers }).then((response) => response.json());
  const listedActivity = listed.data.find((item) => item.id === String(activityId));
  assert.ok(listedActivity);
  assert.equal('qr_code' in listedActivity, false);
  assert.equal(listedActivity.cash_reward, 0);

  const joined = await fetch(`${baseUrl}/v1/activities/${activityId}/join`, { method: 'POST', headers });
  assert.equal(joined.status, 200);
  const blockedClaim = await fetch(`${baseUrl}/v1/activities/${activityId}/verify`, { method: 'POST', headers });
  assert.equal(blockedClaim.status, 400);

  const scanned = await fetch(`${baseUrl}/v1/scan/${code}`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
  assert.equal(scanned.kind, 'activity');
  assert.equal('qr_code' in scanned, false);
  const claim = await fetch(`${baseUrl}/v1/activities/${activityId}/verify`, { method: 'POST', headers }).then((response) => response.json());
  assert.equal(claim.verified, true);
  assert.equal(claim.xp_awarded, 1000);
  assert.equal(claim.cash_awarded, 0);
  assert.ok(claim.creature?.id);

  const leaderboardResponse = await fetch(`${baseUrl}/v1/leaderboard?period=all`, { headers });
  const leaderboard = await leaderboardResponse.json();
  assert.equal(leaderboardResponse.status, 200);
  assert.equal(leaderboard.me.score, 1000);
  const feedResponse = await fetch(`${baseUrl}/v1/activity-feed`, { headers });
  const feed = await feedResponse.json();
  assert.equal(feedResponse.status, 200);
  assert.ok(feed.data.some((item) => item.activity_id === String(activityId)));

  db.prepare('UPDATE activity_verifications SET cash_awarded=75 WHERE activity_id=? AND user_id=?').run(activityId, me.id);
  const duplicateClaim = await fetch(`${baseUrl}/v1/activities/${activityId}/verify`, { method: 'POST', headers }).then((response) => response.json());
  assert.equal(duplicateClaim.already_verified, true);
  assert.equal(duplicateClaim.cash_awarded, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM activity_verifications WHERE activity_id=? AND user_id=?').get(activityId, me.id).count, 1);

  const progressedProfile = await fetch(`${baseUrl}/v1/me`, { headers }).then((response) => response.json());
  assert.equal(progressedProfile.xp, 1000);
  assert.equal(progressedProfile.level, 2);
  assert.equal(progressedProfile.missions_completed, 1);

  db.prepare('UPDATE users SET country=?,city=? WHERE id=?').run('Kenya', 'Nairobi', me.id);
  const profileUpdate = await fetch(`${baseUrl}/v1/me`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ name: 'Updated Test PAL', username: me.username, campus: me.campus }),
  }).then((response) => response.json());
  assert.equal(profileUpdate.email, me.email);
  assert.equal(profileUpdate.country, 'Kenya');
  assert.equal(profileUpdate.city, 'Nairobi');
  assert.equal(profileUpdate.xp, 1000);
  assert.equal(profileUpdate.level, 2);

  const completedMissions = await fetch(`${baseUrl}/v1/missions`, { headers }).then((response) => response.json());
  const completedMission = completedMissions.data.find((mission) => mission.id === String(activityId));
  assert.equal(completedMission.verified, true);
  assert.equal(completedMission.cash_reward, 0);

  const collection = await fetch(`${baseUrl}/v1/me/creatures`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
  assert.ok(collection.data.some((creature) => creature.id === claim.creature.id));
  const achievements = await fetch(`${baseUrl}/v1/me/achievements`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
  assert.ok(achievements.data.some((achievement) => achievement.id === 'first_verified'));
});

test('photo evidence stays pending and is not an automatic reward claim', async () => {
  const me = await fetch(`${baseUrl}/v1/me`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((response) => response.json());
  const activityId = db.prepare(`
    INSERT INTO activities(title,location,status,created_by,campus)
    VALUES(?,?,?,?,?)
  `).run('Photo evidence activity', 'PAL Test Garden', 'active', me.id, me.campus).lastInsertRowid;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  await fetch(`${baseUrl}/v1/activities/${activityId}/join`, { method: 'POST', headers });

  const form = new FormData();
  form.append('evidence', new Blob([Buffer.from('test photo')], { type: 'image/png' }), 'evidence.png');
  const response = await fetch(`${baseUrl}/v1/activities/${activityId}/evidence`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const evidence = await response.json();
  assert.equal(response.status, 201);
  assert.equal(evidence.status, 'pending');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM activity_verifications WHERE activity_id=? AND user_id=?').get(activityId, me.id).count, 0);
});

test('leaderboard ranks verified score and scopes by country and city', async () => {
  const userId = db.prepare('SELECT id FROM users WHERE email=?').get('test@example.com').id;
  db.prepare('UPDATE users SET country=?,city=? WHERE id=?').run('Kenya', 'Nairobi', userId);
  const rivalId = db.prepare(`
    INSERT INTO users(phone,name,username,campus,email,country,city)
    VALUES(?,?,?,?,?,?,?)
  `).run('leaderboard-rival', 'Rival PAL', 'rival_pal', 'Other campus', 'rival@example.com', 'Kenya', 'Nairobi').lastInsertRowid;
  const ownActivityId = db.prepare(`
    INSERT INTO activities(title,location,status,campus,created_by)
    VALUES(?,?,?,?,?)
  `).run('Verified high-value activity', 'PAL Test Library', 'active', 'Test campus', userId).lastInsertRowid;
  const rivalActivityId = db.prepare(`
    INSERT INTO activities(title,location,status,campus,created_by)
    VALUES(?,?,?,?,?)
  `).run('Verified small activity', 'Other campus library', 'active', 'Other campus', rivalId).lastInsertRowid;
  db.prepare('INSERT INTO activity_verifications(activity_id,user_id,xp_awarded) VALUES(?,?,?)').run(ownActivityId, userId, 400);
  db.prepare('INSERT INTO activity_verifications(activity_id,user_id,xp_awarded) VALUES(?,?,?)').run(rivalActivityId, rivalId, 1500);
  db.prepare('INSERT INTO user_achievements(user_id,achievement_id,activity_id) VALUES(?,?,?)').run(userId, 'five_verified', ownActivityId);
  const headers = { authorization: `Bearer ${token}` };

  const city = await fetch(`${baseUrl}/v1/leaderboard?scope=city&period=all`, { headers }).then((response) => response.json());
  assert.equal(city.data.length, 2);
  assert.equal(city.data[0].id, String(rivalId));
  assert.equal(city.me.rank, 2);
  assert.equal(city.me.score, 1400);

  const country = await fetch(`${baseUrl}/v1/leaderboard?scope=country&period=all`, { headers }).then((response) => response.json());
  assert.equal(country.data.length, 2);
  assert.equal(country.data[0].id, String(rivalId));
  assert.equal(country.me.rank, 2);

  db.prepare('UPDATE users SET country=NULL,city=NULL WHERE id=?').run(userId);
  const missingLocation = await fetch(`${baseUrl}/v1/leaderboard?scope=city&period=all`, { headers }).then((response) => response.json());
  assert.equal(missingLocation.needs_location, true);
  db.prepare('UPDATE users SET country=?,city=? WHERE id=?').run('Kenya', 'Nairobi', userId);
});
