const admin = require('firebase-admin');

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('Firebase Admin SDK initialized successfully.');
  } catch (error) {
    console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT:', error);
    process.exit(1);
  }
} else {
  console.warn('FIREBASE_SERVICE_ACCOUNT environment variable is not set. Admin SDK not initialized.');
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
