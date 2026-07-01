const express = require('express');
const cors = require('cors');
const http = require('http');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { initializeWebSockets } = require('./websocket');

const app = express();
const server = http.createServer(app);

// Initialize Firebase Admin SDK
let serviceAccount = null;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (error) {
    console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT environment variable:', error);
  }
} else {
  const fs = require('fs');
  const path = require('path');
  const serviceAccountPath = path.join(__dirname, 'service-account.json');
  if (fs.existsSync(serviceAccountPath)) {
    try {
      serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
      console.log('Loaded service account from service-account.json');
    } catch (error) {
      console.error('Failed to read service-account.json:', error);
    }
  }
}

if (serviceAccount) {
  try {
    initializeApp({
      credential: cert(serviceAccount)
    });
    console.log('Firebase Admin SDK initialized successfully.');
  } catch (error) {
    console.error('Failed to initialize Firebase Admin SDK:', error);
  }
} else {
  console.warn('No Firebase service account provided. Admin SDK not initialized.');
}

// HIGH-1: Restrict CORS to known origins
const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'https://collablab-platform.vercel.app',
  // Add your production frontend URL here
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (e.g., mobile apps, Postman, server-to-server)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    // Allow any .trycloudflare.com subdomain (for Cloudflare quick tunnels)
    if (/^https?:\/\/[a-z0-9-]+(-[a-z0-9-]+)*\.trycloudflare\.com$/.test(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  }
}));
app.use(express.json({ limit: '1mb' })); // Limit body size

app.get('/health', (req, res) => {
  res.send('CollabLab Backend API is running.');
});

// CRIT-3 helper: Verify Firebase token from Authorization header and check role
async function authenticateRequest(req, res, requiredRole = null) {
  if (!getApps().length) {
    return { error: 'Firebase Admin SDK is not configured on the server.' };
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { error: 'Authorization header with Bearer token required.' };
  }

  const token = authHeader.split('Bearer ')[1];
  try {
    const decoded = await getAuth().verifyIdToken(token);
    
    if (requiredRole) {
      const db = getFirestore();
      const userDoc = await db.collection('users').doc(decoded.uid).get();
      if (!userDoc.exists || userDoc.data().role !== requiredRole) {
        return { error: `This action requires ${requiredRole} privileges.` };
      }
    }

    return { user: decoded };
  } catch (error) {
    return { error: 'Invalid or expired token.' };
  }
}

// CRIT-2: Authenticated delete-user endpoint (admin only)
app.delete('/api/delete-user', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res, 'admin');
    if (auth.error) {
      return res.status(auth.error.includes('not configured') ? 500 : 403).json({ error: auth.error });
    }

    const { uid } = req.body;
    if (!uid) {
      return res.status(400).json({ error: 'UID is required' });
    }

    await getAuth().deleteUser(uid);
    console.log(`Admin ${auth.user.uid} deleted user ${uid}`);
    res.json({ success: true, message: 'User authentication deleted' });
  } catch (error) {
    console.error('Error deleting user auth:', error);
    res.status(500).json({ error: error.message });
  }
});

// CRIT-1: Server-side admin key validation
const ADMIN_MASTER_KEY = process.env.ADMIN_MASTER_KEY || 'COLLABLAB_MASTER_2025';

app.post('/api/validate-admin-key', (req, res) => {
  const { adminKey } = req.body;
  if (!adminKey) {
    return res.status(400).json({ valid: false, error: 'Admin key is required.' });
  }
  if (adminKey === ADMIN_MASTER_KEY) {
    return res.json({ valid: true });
  }
  return res.status(403).json({ valid: false, error: 'Invalid admin master key.' });
});

initializeWebSockets(server);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`CollabLab Gateway Server running on port ${PORT}`));