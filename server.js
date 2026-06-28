const express = require('express');
const cors = require('cors');
const http = require('http');
const admin = require('firebase-admin');
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
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('Firebase Admin SDK initialized successfully.');
  } catch (error) {
    console.error('Failed to initialize Firebase Admin SDK:', error);
  }
} else {
  console.warn('No Firebase service account provided. Admin SDK not initialized.');
}

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.send('CollabLab Backend API is running.');
});

app.delete('/api/delete-user', async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid) {
      return res.status(400).json({ error: 'UID is required' });
    }
    if (!admin.apps.length) {
      return res.status(500).json({ error: 'Firebase Admin SDK is not configured on the server.' });
    }
    await admin.auth().deleteUser(uid);
    console.log(`Successfully deleted user auth for ${uid}`);
    res.json({ success: true, message: 'User authentication deleted' });
  } catch (error) {
    console.error('Error deleting user auth:', error);
    res.status(500).json({ error: error.message });
  }
});

initializeWebSockets(server, admin);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`CollabLab Gateway Server running on port ${PORT}`));