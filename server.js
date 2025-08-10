const path = require('path');
const fs = require('fs');
const https = require('https');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const crypto = require('crypto');
const { promisify } = require('util');
const pbkdf2 = promisify(crypto.pbkdf2);

const ORIGIN = process.env.ORIGIN || 'https://localhost:3000';

function base64urlToBuffer(str) {
  return Buffer.from(str, 'base64url');
}

function bufferToBase64url(buf) {
  return buf.toString('base64url');
}

// Import database helpers
const db = require('./db');

// Initialize the database on server start
db.init();

const app = express();
const PORT = process.env.PORT || 3000;

// In production the SSL certificate is provided via environment variables so
// that deployments can supply paths to certificates issued by a real CA (e.g.
// Let's Encrypt).  For local development we fall back to the self-signed
// certificates located in `certs/`.
const keyPath = process.env.SSL_KEY || path.join(__dirname, 'certs', 'key.pem');
const certPath = process.env.SSL_CERT || path.join(__dirname, 'certs', 'cert.pem');
const httpsOptions = {
  key: fs.readFileSync(keyPath),
  cert: fs.readFileSync(certPath),
};

// Middleware to parse JSON bodies
app.use(express.json());

// Configure session middleware.  The secret should be stored in an
// environment variable in production.  `resave: false` and
// `saveUninitialized: false` reduce unnecessary session persistence.
app.use(
  session({
    store: new SQLiteStore({ db: 'bandtrack.db', dir: __dirname }),
    secret: process.env.SESSION_SECRET || 'bandtrack_secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 7, // 1 week
    },
  })
);

// In-memory metrics
const metrics = {
  totalRequests: 0,
  totalResponseTime: 0,
  errorCount: 0,
  lastReset: new Date(),
};

// Middleware to collect latency and error statistics
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    metrics.totalRequests += 1;
    metrics.totalResponseTime += durationMs;
    if (res.statusCode >= 400) {
      metrics.errorCount += 1;
    }
  });
  next();
});

/**
 * Middleware to protect routes that require authentication.  If the user is
 * not logged in, respond with HTTP 401.
 */
function requireAuth(req, res, next) {
  if (!req.session.userId || !req.session.groupId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

/**
 * Helper to send the current user's info (username and id) in responses.
 */
function currentUser(req) {
  return { id: req.session.userId, username: req.session.username, role: req.session.role };
}

function hasModRights(req) {
  return req.session.role === 'admin' || req.session.role === 'moderator';
}

// Middleware ensuring recent biometric verification
function requireBiometric(req, res, next) {
  if (!req.session.webauthn) {
    return res.status(403).json({ error: 'Biometric verification required' });
  }
  next();
}

// ----------------- Authentication Routes -----------------

// Register a new user
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  try {
    // Check if username already exists
    const existing = await db.getUserByUsername(username);
    if (existing) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    // Hash password using PBKDF2 with a per-user salt
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = await pbkdf2(password, salt, 310000, 32, 'sha256');
    const hash = derived.toString('hex');
    const count = await db.getUserCount();
    const role = count === 0 ? 'admin' : 'user';
    const userId = await db.createUser(username, hash, salt, role);
    // Add user to default group and initialise session
    await db.addUserToGroup(userId, 1, role);
    req.session.userId = userId;
    req.session.username = username;
    req.session.role = role;
    req.session.webauthn = false;
    req.session.groupId = 1;
    res.json({ id: userId, username, role });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  try {
    const user = await db.getUserByUsername(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const derived = await pbkdf2(password, user.salt, 310000, 32, 'sha256');
    const hash = derived.toString('hex');
    if (hash !== user.password_hash) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    req.session.webauthn = false;
    const groupId = await db.getFirstGroupForUser(user.id);
    req.session.groupId = groupId;
    await db.logEvent(user.id, 'login', { username: user.username });
    res.json({ id: user.id, username: user.username, role: user.role });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// Return current authenticated user
app.get('/api/me', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.json({ id: req.session.userId, username: req.session.username, role: req.session.role });
});

// ----- Context management -----
app.get('/api/context', requireAuth, async (req, res) => {
  const group = await db.getGroupById(req.session.groupId);
  res.json(group);
});

app.put('/api/context', requireAuth, async (req, res) => {
  const { groupId } = req.body;
  if (!groupId) {
    return res.status(400).json({ error: 'groupId required' });
  }
  const hasMembership = await db.userHasGroup(req.session.userId, groupId);
  if (!hasMembership) {
    return res.status(403).json({ error: 'No membership' });
  }
  req.session.groupId = groupId;
  const group = await db.getGroupById(groupId);
  res.json(group);
});

// --------- Group management ---------
app.post('/api/groups', requireAuth, async (req, res) => {
  const { name, description, logoUrl } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const code = await db.generateInvitationCode();
    const groupId = await db.createGroup(name, code, description, logoUrl, req.session.userId);
    await db.createMembership(req.session.userId, groupId, 'admin', null);
    res.status(201).json({ id: groupId, invitationCode: code });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create group' });
  }
});

app.post('/api/groups/join', requireAuth, async (req, res) => {
  const { code, nickname } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });
  try {
    const group = await db.getGroupByCode(code);
    if (!group) return res.status(404).json({ error: 'Invalid code' });
    const existing = await db.getMembership(req.session.userId, group.id);
    if (existing) return res.status(409).json({ error: 'Already a member' });
    await db.createMembership(req.session.userId, group.id, 'user', nickname);
    res.status(201).json({ groupId: group.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to join group' });
  }
});

app.post('/api/groups/renew-code', requireAuth, async (req, res) => {
  try {
    const membership = await db.getMembership(req.session.userId, req.session.groupId);
    if (!membership || membership.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const newCode = await db.generateInvitationCode();
    await db.updateGroupCode(req.session.groupId, newCode);
    res.json({ invitationCode: newCode });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to renew code' });
  }
});

// ---------- WebAuthn Routes ----------

// Generate registration challenge
app.post('/api/webauthn/register', requireAuth, async (req, res) => {
  const challenge = bufferToBase64url(crypto.randomBytes(32));
  req.session.currentChallenge = challenge;
  const userId = bufferToBase64url(Buffer.from(String(req.session.userId)));
  const options = {
    challenge,
    rp: { name: 'BandTrack' },
    user: { id: userId, name: req.session.username },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  };
  res.json(options);
});

// Verify registration and store credential id
app.post('/api/webauthn/verify-register', requireAuth, async (req, res) => {
  try {
    const expected = req.session.currentChallenge;
    const clientData = JSON.parse(Buffer.from(req.body.response.clientDataJSON, 'base64url').toString());
    if (clientData.challenge !== expected || clientData.type !== 'webauthn.create') {
      return res.status(400).json({ error: 'Invalid challenge' });
    }
    await db.addWebAuthnCredential(req.session.userId, req.body.id);
    req.session.webauthn = true;
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'Registration verification failed' });
  }
});

// WebAuthn login / biometric verification
app.post('/api/webauthn/login', async (req, res) => {
  const { username } = req.body;
  // Start authentication
  if (username && !req.body.response) {
    const user = await db.getUserByUsername(username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const creds = await db.getWebAuthnCredentials(user.id);
    const challenge = bufferToBase64url(crypto.randomBytes(32));
    req.session.currentChallenge = challenge;
    req.session.authUserId = user.id;
    const options = {
      challenge,
      allowCredentials: creds.map((c) => ({ id: c.credential_id, type: 'public-key' })),
    };
    return res.json(options);
  }

  // Verify authentication
  try {
    const expected = req.session.currentChallenge;
    const clientData = JSON.parse(Buffer.from(req.body.response.clientDataJSON, 'base64url').toString());
    if (clientData.challenge !== expected || clientData.type !== 'webauthn.get') {
      return res.status(400).json({ error: 'Invalid challenge' });
    }
    const cred = await db.getWebAuthnCredentialById(req.body.id);
    if (!cred) return res.status(400).json({ error: 'Unknown credential' });
    const user = await db.getUserById(cred.user_id);
    if (!user) return res.status(400).json({ error: 'User not found' });
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    req.session.webauthn = true;
    res.json({ id: user.id, username: user.username, role: user.role });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'Authentication failed' });
  }
});

// ----------------- Suggestion Routes -----------------

// Get all suggestions
app.get('/api/suggestions', requireAuth, async (req, res) => {
  try {
    const suggestions = await db.getSuggestions();
    res.json(suggestions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch suggestions' });
  }
});

// Create a new suggestion
app.post('/api/suggestions', requireAuth, async (req, res) => {
  const { title, author, youtube } = req.body;
  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }
  try {
    const newId = await db.createSuggestion(title, author || '', youtube || '', req.session.userId);
    const [created] = await Promise.all([
      db.getSuggestions().then((list) => list.find((s) => s.id === newId)),
    ]);
    res.status(201).json(created);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create suggestion' });
  }
});

// Update an existing suggestion
app.put('/api/suggestions/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { title, author, youtube } = req.body;
  if (isNaN(id) || !title) {
    return res.status(400).json({ error: 'Invalid data' });
  }
  try {
    const changes = await db.updateSuggestion(id, title, author || '', youtube || '', req.session.userId, req.session.role);
    if (changes === 0) {
      return res.status(403).json({ error: 'Not permitted to update' });
    }
    const list = await db.getSuggestions();
    const updated = list.find((s) => s.id === id);
    await db.logEvent(req.session.userId, 'edit', { entity: 'suggestion', id });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update suggestion' });
  }
});

// Delete a suggestion
app.delete('/api/suggestions/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
  try {
    const changes = await db.deleteSuggestion(id, req.session.userId, req.session.role);
    if (changes === 0) {
      return res.status(403).json({ error: 'Not permitted to delete' });
    }
    await db.logEvent(req.session.userId, 'delete', { entity: 'suggestion', id });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete suggestion' });
  }
});

// Upvote a suggestion
app.post('/api/suggestions/:id/vote', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
  try {
    const ok = await db.incrementSuggestionLikes(id, req.session.userId);
    if (!ok) return res.status(404).json({ error: 'Suggestion not found' });
    await db.logEvent(req.session.userId, 'vote', { suggestionId: id });
    const list = await db.getSuggestions();
    const updated = list.find((s) => s.id === id);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to vote' });
  }
});

// Remove a vote from a suggestion by the current user
app.delete('/api/suggestions/:id/vote', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
  try {
    const ok = await db.decrementUserSuggestionLikes(id, req.session.userId);
    if (!ok) return res.status(400).json({ error: 'No vote to remove' });
    await db.logEvent(req.session.userId, 'unvote', { suggestionId: id });
    const list = await db.getSuggestions();
    const updated = list.find((s) => s.id === id);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove vote' });
  }
});

// Convert a suggestion into a rehearsal
app.post('/api/suggestions/:id/to-rehearsal', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
  try {
    const created = await db.moveSuggestionToRehearsal(id);
    if (!created) return res.status(404).json({ error: 'Suggestion not found' });
    res.json(created);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to convert suggestion' });
  }
});

// ----------------- Rehearsal Routes -----------------

// Get all rehearsals
app.get('/api/rehearsals', requireAuth, async (req, res) => {
  try {
    const rehearsals = await db.getRehearsals();
    res.json(rehearsals);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch rehearsals' });
  }
});

// Create a rehearsal
app.post('/api/rehearsals', requireAuth, async (req, res) => {
  const { title, youtube, spotify } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });
  try {
    const newId = await db.createRehearsal(title, youtube || '', spotify || '', req.session.userId);
    // Return the created rehearsal
    const rehearsalList = await db.getRehearsals();
    const created = rehearsalList.find((r) => r.id === newId);
    res.status(201).json(created);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create rehearsal' });
  }
});

// Update the current user's level/notes/audio for a rehearsal
app.put('/api/rehearsals/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { level, note, audio } = req.body;
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
  try {
    await db.updateRehearsalUserData(id, req.session.username, level, note, audio);
    // Return updated rehearsal data
    const rehearsals = await db.getRehearsals();
    const updated = rehearsals.find((r) => r.id === id);
    await db.logEvent(req.session.userId, 'edit', { entity: 'rehearsal', id });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update rehearsal' });
  }
});

// Toggle mastered flag on a rehearsal
app.put('/api/rehearsals/:id/mastered', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
  try {
    const rehearsals = await db.getRehearsals();
    const rehearsal = rehearsals.find((r) => r.id === id);
    if (!rehearsal) return res.status(404).json({ error: 'Rehearsal not found' });
    if (rehearsal.creatorId !== req.session.userId && !hasModRights(req)) {
      return res.status(403).json({ error: 'Not permitted to toggle' });
    }
    const updated = await db.toggleRehearsalMastered(id);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to toggle mastered' });
  }
});

// Convert a rehearsal back to a suggestion
app.post('/api/rehearsals/:id/to-suggestion', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
  try {
    const created = await db.moveRehearsalToSuggestion(id);
    if (!created) return res.status(404).json({ error: 'Rehearsal not found' });
    res.json(created);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to convert rehearsal' });
  }
});

// ----------------- Performance Routes -----------------

// Get all performances
app.get('/api/performances', requireAuth, async (req, res) => {
  try {
    const performances = await db.getPerformances();
    res.json(performances);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch performances' });
  }
});

// Create a performance
app.post('/api/performances', requireAuth, async (req, res) => {
  const { name, date, location, songs } = req.body;
  if (!name || !date) {
    return res.status(400).json({ error: 'Name and date are required' });
  }
  try {
    const newId = await db.createPerformance(name, date, location || '', songs || [], req.session.userId);
    const list = await db.getPerformances();
    const created = list.find((p) => p.id === newId);
    res.status(201).json(created);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create performance' });
  }
});

// Get performance details
app.get('/api/performances/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
  try {
    const perf = await db.getPerformance(id);
    if (!perf) return res.status(404).json({ error: 'Not found' });
    res.json(perf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch performance' });
  }
});

// Update performance
app.put('/api/performances/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, date, location, songs } = req.body;
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
  try {
    const changes = await db.updatePerformance(id, name, date, location || '', songs || [], req.session.userId, req.session.role);
    if (changes === 0) {
      return res.status(403).json({ error: 'Not permitted to update' });
    }
    const updated = await db.getPerformance(id);
    await db.logEvent(req.session.userId, 'edit', { entity: 'performance', id });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update performance' });
  }
});

// Delete performance
app.delete('/api/performances/:id', requireAuth, requireBiometric, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
  try {
    const changes = await db.deletePerformance(id, req.session.userId, req.session.role);
    if (changes === 0) {
      return res.status(403).json({ error: 'Not permitted to delete' });
    }
    await db.logEvent(req.session.userId, 'delete', { entity: 'performance', id });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete performance' });
  }
});

// ----------------- Settings Routes -----------------

// Get settings
app.get('/api/settings', requireAuth, async (req, res) => {
  try {
    const settings = await db.getSettings();
    res.json(settings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

// Update settings
app.put('/api/settings', requireAuth, async (req, res) => {
  const { groupName, darkMode, nextRehearsalDate, nextRehearsalLocation } = req.body;
  try {
    await db.updateSettings({
      groupName: groupName || 'Groupe de musique',
      darkMode: !!darkMode,
      nextRehearsalDate: nextRehearsalDate || '',
      nextRehearsalLocation: nextRehearsalLocation || '',
    });
    const updated = await db.getSettings();
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ----------------- User Management (Admin only) -----------------

app.get('/api/users', requireAuth, async (req, res) => {
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const users = await db.getUsers();
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.put('/api/users/:id', requireAuth, requireBiometric, async (req, res) => {
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const id = parseInt(req.params.id, 10);
  const { role } = req.body;
  if (isNaN(id) || !['user', 'moderator', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Invalid data' });
  }
  if (id === req.session.userId && role !== 'admin') {
    return res.status(400).json({ error: 'Cannot change your own admin role' });
  }
  try {
    const changes = await db.updateUserRole(id, role);
    if (changes === 0) return res.status(404).json({ error: 'User not found' });
    await db.logEvent(req.session.userId, 'role_change', { targetUserId: id, newRole: role });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Retrieve audit logs (admin only)
app.get('/api/logs', requireAuth, async (req, res) => {
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const logs = await db.getLogs();
    res.json(logs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

// ----------------- Metrics (Admin only) -----------------
app.get('/api/metrics', requireAuth, (req, res) => {
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const avgLatency = metrics.totalRequests
    ? metrics.totalResponseTime / metrics.totalRequests
    : 0;
  const errorRate = metrics.totalRequests
    ? metrics.errorCount / metrics.totalRequests
    : 0;
  res.json({
    totalRequests: metrics.totalRequests,
    averageLatency: avgLatency,
    errorRate,
    lastReset: metrics.lastReset,
  });
});

// Reset metrics
app.delete('/api/metrics', requireAuth, (req, res) => {
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  metrics.totalRequests = 0;
  metrics.totalResponseTime = 0;
  metrics.errorCount = 0;
  metrics.lastReset = new Date();
  res.json({ success: true });
});

// ----------------- Static Files -----------------

// Serve static files for the front‑end.  This allows the SPA to be served
// directly from the same domain as the API, avoiding CORS issues.  Files
// live in the `public` directory next to this server file.
app.use('/', express.static(path.join(__dirname, 'public')));

// For any unknown route (e.g. /suggestions) that isn’t an API route,
// return index.html so that the SPA can handle routing on the client side.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the HTTPS server
https.createServer(httpsOptions, app).listen(PORT, () => {
  console.log(`BandTrack server listening on port ${PORT}`);
});