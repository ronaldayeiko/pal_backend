const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || 'pal.db');
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, phone TEXT UNIQUE NOT NULL, name TEXT, username TEXT UNIQUE, campus TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS otps(phone TEXT PRIMARY KEY, code TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS posts(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL, location TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS replies(id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL, user_id INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
-- Ledger: balance is ALWAYS derived from completed rows. Only a payment provider webhook may complete a row.
CREATE TABLE IF NOT EXISTS transactions(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, amount INTEGER NOT NULL, kind TEXT NOT NULL, counterparty TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);

const userColumns = new Set(
	db.pragma('table_info(users)').map((column) => column.name)
);
for (const [name, definition] of [
	['email', 'TEXT'],
	['password_hash', 'TEXT'],
	['profile_photo_url', 'TEXT'],
	['pal_qr_code', 'TEXT'],
	['country', 'TEXT'],
	['city', 'TEXT'],
]) {
	if (!userColumns.has(name)) {
		db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
	}
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(email) WHERE email IS NOT NULL');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_pal_qr_code_unique ON users(pal_qr_code) WHERE pal_qr_code IS NOT NULL');

const activityColumns = new Set(
	db.pragma('table_info(activities)').map((column) => column.name)
);
if (!activityColumns.has('generated_key')) {
	db.exec('ALTER TABLE activities ADD COLUMN generated_key TEXT');
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS activities_generated_key_unique ON activities(generated_key) WHERE generated_key IS NOT NULL');

for (const [name, definition] of [
	['campus', 'TEXT'],
	['visibility', "TEXT NOT NULL DEFAULT 'campus'"],
	['qr_expires_at', 'INTEGER'],
]) {
	if (!activityColumns.has(name)) {
		db.exec(`ALTER TABLE activities ADD COLUMN ${name} ${definition}`);
	}
}
db.exec(`
UPDATE activities
SET campus = (SELECT campus FROM users WHERE users.id = activities.created_by)
WHERE campus IS NULL AND created_by IS NOT NULL;
CREATE TABLE IF NOT EXISTS activity_qr_scans(
	id INTEGER PRIMARY KEY,
	activity_id INTEGER NOT NULL,
	user_id INTEGER NOT NULL,
	scanned_at INTEGER NOT NULL,
	used_at INTEGER,
	UNIQUE(activity_id, user_id, scanned_at)
);
CREATE INDEX IF NOT EXISTS activity_qr_scans_recent
	ON activity_qr_scans(activity_id, user_id, used_at, scanned_at);
CREATE TABLE IF NOT EXISTS activity_verifications(
	id INTEGER PRIMARY KEY,
	activity_id INTEGER NOT NULL,
	user_id INTEGER NOT NULL,
	xp_awarded INTEGER NOT NULL DEFAULT 0,
	cash_awarded INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	UNIQUE(activity_id,user_id)
);
CREATE TABLE IF NOT EXISTS activity_evidence(
	id INTEGER PRIMARY KEY,
	activity_id INTEGER NOT NULL,
	user_id INTEGER NOT NULL,
	file_url TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending',
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	reviewed_at TEXT,
	reviewed_by INTEGER,
	UNIQUE(activity_id, user_id, file_url)
);
CREATE TABLE IF NOT EXISTS pal_creatures(
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	description TEXT NOT NULL,
	rarity TEXT NOT NULL,
	availability TEXT NOT NULL,
	color TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_creatures(
	user_id INTEGER NOT NULL,
	creature_id TEXT NOT NULL REFERENCES pal_creatures(id),
	activity_id INTEGER NOT NULL,
	unlocked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY(user_id, creature_id)
);
CREATE TABLE IF NOT EXISTS pal_achievements(
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	description TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_achievements(
	user_id INTEGER NOT NULL,
	achievement_id TEXT NOT NULL REFERENCES pal_achievements(id),
	activity_id INTEGER NOT NULL,
	awarded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY(user_id, achievement_id)
);
CREATE TABLE IF NOT EXISTS mission_generation(
	campus_key TEXT PRIMARY KEY,
	generated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO pal_creatures(id,name,description,rarity,availability,color) VALUES
	('emberfin','Emberfin','A quick-footed guide who appears where campus paths meet.','Common','Campus paths · year-round','#E87952'),
	('mosswhorl','Mosswhorl','A patient listener drawn to quiet gardens and green corners.','Uncommon','Garden spaces · spring term','#50856D'),
	('ripplewisp','Ripplewisp','A bright current-follower found near shared water and busy courtyards.','Rare','Courtyards · event days','#5597A8'),
	('lanternook','Lanternook','A dusk-time companion that remembers every welcoming doorway.','Epic','Community venues · evenings','#CEAB5A'),
	('starlingrove','Starlingrove','A rare pathfinder that gathers stories from across a campus community.','Legendary','Seasonal campus discoveries','#7477A8');
INSERT OR IGNORE INTO pal_achievements(id,name,description) VALUES
	('first_verified','First Field Note','Complete your first activity with a valid PAL QR scan.'),
	('five_verified','Campus Regular','Complete five activities with valid PAL QR scans.');
`);

const verificationColumns = new Set(
	db.pragma('table_info(activity_verifications)').map((column) => column.name)
);
if (!verificationColumns.has('created_at')) {
	db.exec('ALTER TABLE activity_verifications ADD COLUMN created_at TEXT');
	if (verificationColumns.has('verified_at')) {
		db.exec(`
			UPDATE activity_verifications
			SET created_at = COALESCE(verified_at, CURRENT_TIMESTAMP)
			WHERE created_at IS NULL
		`);
	}
}

const postColumns = new Set(db.pragma('table_info(posts)').map((column) => column.name));
for (const [name, definition] of [
	['campus', 'TEXT'],
	['visibility', "TEXT NOT NULL DEFAULT 'campus'"],
]) {
	if (!postColumns.has(name)) {
		db.exec(`ALTER TABLE posts ADD COLUMN ${name} ${definition}`);
	}
}
db.exec(`
UPDATE posts
SET campus = (SELECT campus FROM users WHERE users.id = posts.user_id)
WHERE campus IS NULL;
`);

module.exports = db;
