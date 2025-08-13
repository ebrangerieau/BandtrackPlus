const path = require('path');
const fs = require('fs');
const https = require('https');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const crypto = require('crypto');
const { promisify } = require('util');
const pbkdf2 = promisify(crypto.pbkdf2);
// Chosen iteration count for PBKDF2. Higher values increase security but
// also add latency during authentication.
const PBKDF2_ITERATIONS = 200000;

// Import database helpers
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 8080;

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
    store: new SQLiteStore({ db: 'bandtrack.db', dir: __dirname, table: 'web_sessions' }),
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
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

/**
 * Helper to send the current user's info (username and id) in responses.
 */
async function currentUser(req) {
  let membershipRole = req.session.membershipRole;
  if (!membershipRole) {
    const membership = await db.getMembership(req.session.userId, req.session.groupId);
    membershipRole = membership ? membership.role : null;
    req.session.membershipRole = membershipRole;
  }
  return {
    id: req.session.userId,
    username: req.session.username,
    role: req.session.role,
    membershipRole,
  };
}

function hasModRights(role) {
  return role === 'admin' || role === 'moderator';
}

async function verifyGroupAccess(req, groupId = req.session.groupId, requiredRole = 'user') {
  const levels = { user: 1, moderator: 2, admin: 3 };
  if (!groupId) return null;
  if (req.session.membershipRole && groupId === req.session.groupId) {
    return levels[req.session.membershipRole] >= levels[requiredRole]
      ? req.session.membershipRole
      : null;
  }
  const membership = await db.getMembership(req.session.userId, groupId);
  if (!membership || membership.active === 0) return null;
  if (levels[membership.role] < levels[requiredRole]) return null;
  if (groupId === req.session.groupId) req.session.membershipRole = membership.role;
  return membership.role;
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
    const salt = crypto.randomBytes(16);
    const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS, 32, 'sha256');
    const count = await db.getUserCount();
    const role = count === 0 ? 'admin' : 'user';
    const userId = await db.createUser(username, hash, salt, role);
    // Add user to default group and initialise session
    await db.addUserToGroup(userId, 1, role);
    req.session.userId = userId;
    req.session.username = username;
    req.session.role = role;
    req.session.groupId = 1;
    req.session.membershipRole = role;
    res.json({ id: userId, username, role, membershipRole: role });
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
    const derived = await pbkdf2(password, user.salt, PBKDF2_ITERATIONS, 32, 'sha256');
    if (
      user.password_hash.length !== derived.length ||
      !crypto.timingSafeEqual(derived, user.password_hash)
    ) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    const groupId = await db.getFirstGroupForUser(user.id);
    if (groupId == null) {
      req.session.groupId = null;
      req.session.membershipRole = null;
      req.session.needsGroup = true;
      await db.logEvent(user.id, 'login', { username: user.username });
      return res.json({ id: user.id, username: user.username, role: user.role, needsGroup: true });
    }
    req.session.groupId = groupId;
    const membership = await db.getMembership(user.id, groupId);
    req.session.membershipRole = membership ? membership.role : null;
    req.session.needsGroup = false;
    await db.logEvent(user.id, 'login', { username: user.username });
    res.json({ id: user.id, username: user.username, role: user.role, membershipRole: membership ? membership.role : null });
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
app.get('/api/me', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (!req.session.groupId) {
    return res.json({
      id: req.session.userId,
      username: req.session.username,
      role: req.session.role,
      needsGroup: true,
    });
  }
  const membershipRole = await verifyGroupAccess(req, req.session.groupId, 'user');
  if (!membershipRole) {
    return res.status(403).json({ error: 'No membership' });
  }
  res.json({
    id: req.session.userId,
    username: req.session.username,
    role: req.session.role,
    membershipRole,
  });
});

// ----- Context management -----
app.get('/api/context', requireAuth, async (req, res) => {
  if (!req.session.groupId) {
    return res.status(404).json({ error: 'No active group' });
  }
  const group = await db.getGroupById(req.session.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  res.json(group);
});

app.put('/api/context', requireAuth, async (req, res) => {
  const { groupId } = req.body;
  if (!groupId) {
    return res.status(400).json({ error: 'groupId required' });
  }
  const membership = await db.getMembership(req.session.userId, groupId);
  if (!membership) {
    return res.status(403).json({ error: 'No membership' });
  }
  req.session.groupId = groupId;
  req.session.membershipRole = membership.role;
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

app.get('/api/groups/:id/members', requireAuth, async (req, res) => {
  const groupId = Number(req.params.id);
  const role = await verifyGroupAccess(req, groupId, 'moderator');
  if (!role) return res.status(403).json({ error: 'Forbidden' });
  try {
    const members = await db.getGroupMembers(groupId);
    res.json(members);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch members' });
  }
});

app.put('/api/groups/:id/members', requireAuth, async (req, res) => {
  const groupId = Number(req.params.id);
  const { userId, role } = req.body;
  if (!userId || !role) return res.status(400).json({ error: 'userId and role required' });
  const access = await verifyGroupAccess(req, groupId, 'admin');
  if (!access) return res.status(403).json({ error: 'Forbidden' });
  try {
    const membership = await db.getMembership(userId, groupId);
    if (!membership) return res.status(404).json({ error: 'Not found' });
    await db.updateMembership(membership.id, role, membership.nickname, membership.active);
    if (userId === req.session.userId && groupId === req.session.groupId) {
      req.session.membershipRole = role;
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update membership' });
  }
});

app.delete('/api/groups/:id/members', requireAuth, async (req, res) => {
  const groupId = Number(req.params.id);
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const access = await verifyGroupAccess(req, groupId, 'admin');
  if (!access) return res.status(403).json({ error: 'Forbidden' });
  try {
    const membership = await db.getMembership(userId, groupId);
    if (!membership) return res.status(404).json({ error: 'Not found' });
    await db.deleteMembership(membership.id);
    if (userId === req.session.userId && groupId === req.session.groupId) {
      req.session.membershipRole = null;
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove membership' });
  }
});

app.get('/api/groups', requireAuth, async (req, res) => {
  const groups = await db.getGroupsForUser(req.session.userId);
  res.json(groups);
});

// ----------------- Suggestion Routes -----------------

// Get all suggestions
app.get('/api/suggestions', requireAuth, async (req, res) => {
  const role = await verifyGroupAccess(req);
  if (!role) return res.status(403).json({ error: 'Forbidden' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  try {
    const suggestions = await db.getSuggestions(req.session.groupId, limit, offset);
    res.json(suggestions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch suggestions' });
  }
});

// Create a new suggestion
app.post('/api/suggestions', requireAuth, async (req, res) => {
  const role = await verifyGroupAccess(req);
  if (!role) return res.status(403).json({ error: 'Forbidden' });
  const { title, author, youtube } = req.body;
  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }
  try {
    const newId = await db.createSuggestion(title, author || '', youtube || '', req.session.userId, req.session.groupId);
    const created = await db.getSuggestionById(newId, req.session.groupId);
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
  const role = await verifyGroupAccess(req);
  if (!role) return res.status(403).json({ error: 'Forbidden' });
  try {
    const changes = await db.updateSuggestion(id, title, author || '', youtube || '', req.session.userId, role, req.session.groupId);
    if (changes === 0) {
      return res.status(403).json({ error: 'Not permitted to update' });
    }
    const updated = await db.getSuggestionById(id, req.session.groupId);
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
  const role = await verifyGroupAccess(req);
  if (!role) return res.status(403).json({ error: 'Forbidden' });
  try {
    const changes = await db.deleteSuggestion(id, req.session.userId, role, req.session.groupId);
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
  const role = await verifyGroupAccess(req);
  if (!role) return res.status(403).json({ error: 'Forbidden' });
  try {
    const ok = await db.incrementSuggestionLikes(id, req.session.userId);
    if (!ok) return res.status(404).json({ error: 'Suggestion not found' });
    await db.logEvent(req.session.userId, 'vote', { suggestionId: id });
    const updated = await db.getSuggestionById(id, req.session.groupId);
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
  const role = await verifyGroupAccess(req);
  if (!role) return res.status(403).json({ error: 'Forbidden' });
  try {
    const ok = await db.decrementUserSuggestionLikes(id, req.session.userId);
    if (!ok) return res.status(400).json({ error: 'No vote to remove' });
    await db.logEvent(req.session.userId, 'unvote', { suggestionId: id });
    const updated = await db.getSuggestionById(id, req.session.groupId);
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
  const role = await verifyGroupAccess(req);
  if (!role) return res.status(403).json({ error: 'Forbidden' });
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
  const role = await verifyGroupAccess(req);
  if (!role) return res.status(403).json({ error: 'Forbidden' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  try {
    const rehearsals = await db.getRehearsals(req.session.groupId, limit, offset);
    res.json(rehearsals);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch rehearsals' });
  }
});

// Create a rehearsal
app.post('/api/rehearsals', requireAuth, async (req, res) => {
  const role = await verifyGroupAccess(req);
  if (!role) return res.status(403).json({ error: 'Forbidden' });
  const { title, author, youtube, spotify } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });
  try {
    const newId = await db.createRehearsal(title, author || '', youtube || '', spotify || '', req.session.userId, req.session.groupId);
    const created = await db.getRehearsalById(newId, req.session.groupId);
    res.status(201).json(created);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create rehearsal' });
  }
});

// Update the current user's level/notes/audio for a rehearsal
app.put('/api/rehearsals/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { level, note, audio, title, author, youtube, spotify } = req.body;
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
  const role = await verifyGroupAccess(req);
  if (!role) return res.status(403).json({ error: 'Forbidden' });
  try {
    if (title !== undefined || author !== undefined || youtube !== undefined || spotify !== undefined) {
      if (!title) return res.status(400).json({ error: 'Title is required' });
      const changes = await db.updateRehearsalDetails(id, title, author || '', youtube || '', spotify || '', req.session.userId, role, req.session.groupId);
      if (changes === 0) {
        return res.status(403).json({ error: 'Not allowed to edit rehearsal details' });
      }
    } else {
      await db.updateRehearsalUserData(id, req.session.username, level, note, audio);
    }
    const updated = await db.getRehearsalById(id, req.session.groupId);
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
  const role = await verifyGroupAccess(req);
  if (!role) return res.status(403).json({ error: 'Forbidden' });
  try {
    const rehearsal = await db.getRehearsalById(id, req.session.groupId);
    if (!rehearsal) return res.status(404).json({ error: 'Rehearsal not found' });
    if (rehearsal.creatorId !== req.session.userId && !hasModRights(role)) {
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
  const role = await verifyGroupAccess(req);
  if (!role) return res.status(403).json({ error: 'Forbidden' });
  try {
    const created = await db.moveRehearsalToSuggestion(id);
    if (!created) return res.status(404).json({ error: 'Rehearsal not found' });
    res.json(created);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to convert rehearsal' });
  }
});

// ----------------- Rehearsal Event Routes -----------------

// Get all rehearsal events for the active group
app.get('/api/rehearsal-events', requireAuth, async (req, res) => {
  const role = await verifyGroupAccess(req);
  if (!role) return res.status(403).json({ error: 'Forbidden' });
  try {
    const events = await db.getRehearsalEvents(req.session.groupId);
    res.json(events);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch rehearsal events' });
  }
});

// Create a rehearsal event
app.post('/api/rehearsal-events', requireAuth, async (req, res) => {
  const role = await verifyGroupAccess(req);
  if (!role) return res.status(403).json({ error: 'Forbidden' });
  const { date, location } = req.body;
  if (!date) return res.status(400).json({ error: 'Date is required' });
  try {
    const newId = await db.createRehearsalEvent(date, location || '', req.session.groupId, req.session.userId);
    const events = await db.getRehearsalEvents(req.session.groupId);
    const created = events.find((e) => e.id === newId);
    res.status(201).json(created);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create rehearsal event' });
  }
});

// Delete a rehearsal event
app.delete('/api/rehearsal-events/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
  const role = await verifyGroupAccess(req);
  if (!role) return res.status(403).json({ error: 'Forbidden' });
  try {
    const changes = await db.deleteRehearsalEvent(id, req.session.userId, role);
    if (changes === 0) return res.status(403).json({ error: 'Not permitted to delete' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete rehearsal event' });
  }
});

// ----------------- Performance Routes -----------------

// Get all performances
app.get('/api/performances', requireAuth, async (req, res) => {
  const role = await verifyGroupAccess(req);
  if (!role) return res.status(403).json({ error: 'Forbidden' });
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
  const role = await verifyGroupAccess(req);
  if (!role) return res.status(403).json({ error: 'Forbidden' });
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
  const role = await verifyGroupAccess(req);
  if (!role) return res.status(403).json({ error: 'Forbidden' });
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
  const role = await verifyGroupAccess(req);
  if (!role) return res.status(403).json({ error: 'Forbidden' });
  try {
    const changes = await db.updatePerformance(id, name, date, location || '', songs || [], req.session.userId, role);
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
app.delete('/api/performances/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
  const role = await verifyGroupAccess(req);
  if (!role) return res.status(403).json({ error: 'Forbidden' });
  try {
    const changes = await db.deletePerformance(id, req.session.userId, role);
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

// ----------------- Agenda Routes -----------------

// Create agenda item (rehearsal or performance)
app.post('/api/agenda', async (req, res) => {
  const role = await verifyGroupAccess(req);
  if (!role) return res.status(403).json({ error: 'Forbidden' });
  const { type } = req.body;
  try {
    if (type === 'rehearsal') {
      const { date, location } = req.body;
      if (!date) return res.status(400).json({ error: 'Date is required' });
      const newId = await db.createRehearsalEvent(
        date,
        location || '',
        req.session.groupId,
        req.session.userId
      );
      const events = await db.getRehearsalEvents(req.session.groupId);
      const created = events.find((e) => e.id === newId);
      res.status(201).json({
        type: 'rehearsal',
        date: created.date,
        id: created.id,
        title: '',
        location: created.location,
      });
    } else if (type === 'performance') {
      const { name, date, location, songs } = req.body;
      if (!name || !date)
        return res.status(400).json({ error: 'Name and date are required' });
      const newId = await db.createPerformance(
        name,
        date,
        location || '',
        songs || [],
        req.session.userId
      );
      const list = await db.getPerformances();
      const created = list.find((p) => p.id === newId);
      res.status(201).json({
        type: 'performance',
        date: created.date,
        id: created.id,
        title: created.name,
        location: created.location,
      });
    } else {
      res.status(400).json({ error: 'Invalid type' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create agenda item' });
  }
});

// Update agenda item
app.put('/api/agenda/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
  const role = await verifyGroupAccess(req);
  if (!role) return res.status(403).json({ error: 'Forbidden' });
  const { type } = req.body;
  try {
    if (type === 'rehearsal') {
      const { date, location } = req.body;
      if (!date) return res.status(400).json({ error: 'Date is required' });
      const changes = await db.updateRehearsalEvent(
        id,
        date,
        location || '',
        req.session.userId,
        role
      );
      if (changes === 0)
        return res.status(403).json({ error: 'Not permitted to update' });
      const events = await db.getRehearsalEvents(req.session.groupId);
      const updated = events.find((e) => e.id === id);
      if (!updated) return res.status(404).json({ error: 'Not found' });
      res.json({
        type: 'rehearsal',
        date: updated.date,
        id: updated.id,
        title: '',
        location: updated.location,
      });
    } else if (type === 'performance') {
      const { name, date, location, songs } = req.body;
      if (!name || !date)
        return res.status(400).json({ error: 'Name and date are required' });
      const changes = await db.updatePerformance(
        id,
        name,
        date,
        location || '',
        songs || [],
        req.session.userId,
        role
      );
      if (changes === 0)
        return res.status(403).json({ error: 'Not permitted to update' });
      const updated = await db.getPerformance(id);
      await db.logEvent(req.session.userId, 'edit', { entity: 'performance', id });
      res.json({
        type: 'performance',
        date: updated.date,
        id: updated.id,
        title: updated.name,
        location: updated.location,
      });
    } else {
      res.status(400).json({ error: 'Invalid type' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update agenda item' });
  }
});

// Delete agenda item
app.delete('/api/agenda/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
  const role = await verifyGroupAccess(req);
  if (!role) return res.status(403).json({ error: 'Forbidden' });
  const type = req.body.type || req.query.type;
  try {
    if (type === 'rehearsal') {
      const changes = await db.deleteRehearsalEvent(
        id,
        req.session.userId,
        role
      );
      if (changes === 0)
        return res.status(403).json({ error: 'Not permitted to delete' });
      res.json({ success: true });
    } else if (type === 'performance') {
      const changes = await db.deletePerformance(id, req.session.userId, role);
      if (changes === 0)
        return res.status(403).json({ error: 'Not permitted to delete' });
      await db.logEvent(req.session.userId, 'delete', { entity: 'performance', id });
      res.json({ success: true });
    } else {
      res.status(400).json({ error: 'Invalid type' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete agenda item' });
  }
});

// Get agenda combining rehearsals and performances
app.get('/api/agenda', async (req, res) => {
  const role = await verifyGroupAccess(req);
  if (!role) return res.status(403).json({ error: 'Forbidden' });
  try {
    const startParam = req.query.start;
    const endParam = req.query.end;
    const start = startParam
      ? startParam + (startParam.includes('T') ? '' : 'T00:00')
      : null;
    const end = endParam
      ? endParam + (endParam.includes('T') ? '' : 'T23:59')
      : null;
    const [rehearsals, performances] = await Promise.all([
      db.getRehearsalEvents(req.session.groupId),
      db.getPerformances(),
    ]);
    let items = [
      ...rehearsals.map((r) => ({
        type: 'rehearsal',
        date: r.date,
        id: r.id,
        title: '',
        location: r.location,
      })),
      ...performances.map((p) => ({
        type: 'performance',
        date: p.date,
        id: p.id,
        title: p.name,
        location: p.location,
      })),
    ];
    if (start) items = items.filter((i) => i.date >= start);
    if (end) items = items.filter((i) => i.date <= end);
    items.sort((a, b) => a.date.localeCompare(b.date));
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch agenda' });
  }
});

// ----------------- Settings Routes -----------------

// Get settings
app.get('/api/settings', requireAuth, async (req, res) => {
  const role = await verifyGroupAccess(req);
  if (!role) return res.status(403).json({ error: 'Forbidden' });
  try {
    const settings = await db.getSettingsForGroup(req.session.groupId);
    res.json(settings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

// Update settings
app.put('/api/settings', requireAuth, async (req, res) => {
  const role = await verifyGroupAccess(req, req.session.groupId, 'admin');
  if (!role) return res.status(403).json({ error: 'Forbidden' });
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

app.put('/api/users/:id', requireAuth, async (req, res) => {
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
    if (id === req.session.userId) {
      req.session.role = role;
    }
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

// Serve static files for the front‑end.  The new React SPA lives in the
// `frontend` directory while legacy assets remain in `public`.
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/', express.static(path.join(__dirname, 'frontend')));

// For any unknown route (e.g. /suggestions) that isn’t an API route,
// return index.html so that the SPA can handle routing on the client side.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

// Start the HTTPS server once the database is initialized
;(async () => {
  await db.init();
  https.createServer(httpsOptions, app).listen(PORT, () => {
    console.log(`BandTrack server listening on port ${PORT}`);
  });
})();
