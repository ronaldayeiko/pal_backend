const crypto = require('crypto');

const templates = [
  {
    key: 'visit-challenge',
    title: 'Campus location challenge',
    description: 'Visit {location} and complete the PAL challenge.',
    xp: 150,
  },
  {
    key: 'discover-place',
    title: 'Discover a campus spot',
    description: 'Explore {location} and share what makes it worth finding.',
    xp: 200,
  },
  {
    key: 'pal-check-in',
    title: 'PAL campus check-in',
    description: 'Bring a PAL to {location} and take on the campus challenge together.',
    xp: 250,
  },
];

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
  const lastGeneration = db.prepare(
    'SELECT generated_at FROM mission_generation WHERE campus_key=?'
  ).get(campusKey);
  const refreshDue = !lastGeneration || now - lastGeneration.generated_at >= 24 * 60 * 60 * 1000;
  const start = new Date(now);
  const end = new Date(now + 7 * 24 * 60 * 60 * 1000);

  const create = db.transaction(() => {
    if (!refreshDue) return;
    for (const [locationIndex, { location }] of locations.entries()) {
      for (const template of templates) {
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

module.exports = { generateMissions, templates };
