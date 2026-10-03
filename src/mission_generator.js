const crypto = require('crypto');

const templates = [
  {
    key: 'quick-walk',
    title: 'Quick campus walk',
    description: 'Walk to {location} and scan its PAL code to check in.',
    xp: 150,
  },
  {
    key: 'new-detail',
    title: 'Find one new detail',
    description: 'Visit {location}, notice one thing you had not seen before, and scan its PAL code.',
    xp: 200,
  },
  {
    key: 'study-break',
    title: 'Take a five-minute break',
    description: 'Take a short break at {location} and scan its PAL code.',
    xp: 250,
  },
  {
    key: 'new-route',
    title: 'Try a different route',
    description: 'Take a different campus route to {location} and scan its PAL code.',
    xp: 150,
  },
  {
    key: 'photo-stop',
    title: 'Campus photo stop',
    description: 'Find a detail worth photographing at {location}, then scan its PAL code.',
    xp: 200,
  },
  {
    key: 'pal-meetup',
    title: 'Meet a PAL on campus',
    description: 'Meet a PAL at {location} and scan its PAL code together.',
    xp: 250,
  },
  {
    key: 'quiet-corner',
    title: 'Find a quiet corner',
    description: 'Spend a few minutes at {location} and scan its PAL code.',
    xp: 150,
  },
];

function dailyTemplates(cycle) {
  const day = Math.floor(Date.parse(`${cycle}T00:00:00Z`) / 86400000);
  const start = ((day % templates.length) + templates.length) % templates.length;
  return Array.from({ length: 3 }, (_, offset) => templates[(start + offset) % templates.length]);
}

function generateMissions(db, userId) {
  const user = db.prepare('SELECT campus FROM users WHERE id=?').get(userId);
  const campus = String(user?.campus || '').trim();
  if (!campus) return [];

  const campusKey = campus.toLowerCase();
  const cycle = new Date().toISOString().slice(0, 10);
  const locations = db.prepare(`
    SELECT DISTINCT location
    FROM activities
    WHERE status = 'active' AND generated_key IS NULL AND TRIM(location) <> ''
      AND campus = ?
    ORDER BY location
    LIMIT 20
  `).all(campus);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO activities(
      title, description, location, starts_at, ends_at,
      xp_reward, cash_reward, qr_code, qr_expires_at, status, created_by, generated_key, campus
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const now = Date.now();
  const start = new Date(now);
  const end = new Date(now + 7 * 24 * 60 * 60 * 1000);

  const create = db.transaction(() => {
    for (const [locationIndex, { location }] of locations.entries()) {
      for (const template of dailyTemplates(cycle)) {
        const generatedKey = `${template.key}:${campusKey}:${location.trim().toLowerCase()}:${cycle}`;
        insert.run(
          template.title,
          template.description.replaceAll('{location}', location),
          location,
          start.toISOString(),
          end.toISOString(),
          template.xp + (locationIndex % 2) * 50,
          0,
          `PAL-${crypto.randomBytes(6).toString('hex').toUpperCase()}`,
          end.getTime(),
          'active',
          userId,
          generatedKey,
          campus,
        );
      }
    }
    db.prepare(`
      INSERT INTO mission_generation(campus_key,generated_at) VALUES(?,?)
      ON CONFLICT(campus_key) DO UPDATE SET generated_at=excluded.generated_at
    `).run(campusKey, now);
  });
  create();

  return db.prepare(`
    SELECT a.*, 0 AS participants
    FROM activities a
    WHERE a.generated_key IS NOT NULL AND a.status = 'active'
      AND a.campus = ? AND a.ends_at > ?
    ORDER BY a.id DESC
    LIMIT 60
  `).all(campus, start.toISOString());
}

module.exports = { generateMissions, dailyTemplates, templates };
