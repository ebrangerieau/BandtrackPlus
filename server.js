const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');

// Import database helpers
const db = require('./db');

// Initialize the database on server start
db.init();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// Configure session middleware.  The secret should be stored in an
// environment variable in production.  `resave: false` and
// `saveUninitialized: false` reduce unnecessary session persistence.
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'bandtrack_secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 7, // 1 week
    },
  })
);

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
function currentUser(req) {
  return { id: req.session.userId, username: req.session.username };
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
    // Hash password
    const saltRounds = 10;
    const hash = await bcrypt.hash(password, saltRounds);
    const userId = await db.createUser(username, hash);
    // Set session
    req.session.userId = userId;
    req.session.username = username;
    res.json({ id: userId, username });
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
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ id: user.id, username: user.username });
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
  res.json({ id: req.session.userId, username: req.session.username });
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
  const { title, url } = req.body;
  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }
  try {
    const newId = await db.createSuggestion(title, url || '', req.session.userId);
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
  const { title, url } = req.body;
  if (isNaN(id) || !title) {
    return res.status(400).json({ error: 'Invalid data' });
  }
  try {
    const changes = await db.updateSuggestion(id, title, url || '', req.session.userId);
    if (changes === 0) {
      return res.status(403).json({ error: 'Not permitted to update' });
    }
    const list = await db.getSuggestions();
    const updated = list.find((s) => s.id === id);
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
    const changes = await db.deleteSuggestion(id, req.session.userId);
    if (changes === 0) {
      return res.status(403).json({ error: 'Not permitted to delete' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete suggestion' });
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

// Update the current user's level/notes for a rehearsal
app.put('/api/rehearsals/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { level, note } = req.body;
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
  try {
    await db.updateRehearsalUserData(id, req.session.username, level, note);
    // Return updated rehearsal data
    const rehearsals = await db.getRehearsals();
    const updated = rehearsals.find((r) => r.id === id);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update rehearsal' });
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
  const { name, date, songs } = req.body;
  if (!name || !date) {
    return res.status(400).json({ error: 'Name and date are required' });
  }
  try {
    const newId = await db.createPerformance(name, date, songs || [], req.session.userId);
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
  const { name, date, songs } = req.body;
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
  try {
    const changes = await db.updatePerformance(id, name, date, songs || [], req.session.userId);
    if (changes === 0) {
      return res.status(403).json({ error: 'Not permitted to update' });
    }
    const updated = await db.getPerformance(id);
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
  try {
    const changes = await db.deletePerformance(id, req.session.userId);
    if (changes === 0) {
      return res.status(403).json({ error: 'Not permitted to delete' });
    }
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
  const { groupName, darkMode } = req.body;
  try {
    await db.updateSettings({ groupName: groupName || 'Groupe de musique', darkMode: !!darkMode });
    const updated = await db.getSettings();
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
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

// Start the server
app.listen(PORT, () => {
  console.log(`BandTrack server listening on port ${PORT}`);
});