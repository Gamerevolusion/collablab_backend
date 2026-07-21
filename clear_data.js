const admin = require('firebase-admin');

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
    process.exit(1);
  }
} else {
  console.warn('No Firebase service account provided. Admin SDK not initialized.');
  process.exit(1);
}

const db = admin.firestore();

async function clearCollections() {
  try {
    console.log('Deleting sessions...');
    const sessions = await db.collection('sessions').get();
    const batch1 = db.batch();
    sessions.forEach(doc => {
      batch1.delete(doc.ref);
    });
    if (sessions.size > 0) await batch1.commit();
    console.log(`Deleted ${sessions.size} sessions.`);

    console.log('Deleting sessionParticipants...');
    let totalParticipants = 0;
    // Batch limit is 500
    while (true) {
        const participants = await db.collection('sessionParticipants').limit(500).get();
        if (participants.size === 0) break;
        const batch2 = db.batch();
        participants.forEach(doc => {
            batch2.delete(doc.ref);
        });
        await batch2.commit();
        totalParticipants += participants.size;
    }
    console.log(`Deleted ${totalParticipants} sessionParticipants.`);
    
    console.log('Done clearing previous sessions!');
    process.exit(0);
  } catch (err) {
    console.error('Error clearing data:', err);
    process.exit(1);
  }
}

clearCollections();
