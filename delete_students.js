const fs = require('fs');
const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

async function deleteAllStudents() {
  console.log('Initializing Firebase Admin...');
  let serviceAccount = null;

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch (error) {
      console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT environment variable:', error);
    }
  } else {
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
      process.exit(1);
    }
  } else {
    console.warn('No Firebase service account provided. Admin SDK not initialized.');
    process.exit(1);
  }

  const db = getFirestore();
  const auth = getAuth();

  console.log('Fetching students from Firestore...');
  try {
    const usersSnapshot = await db.collection('users').where('role', '==', 'student').get();

    if (usersSnapshot.empty) {
      console.log('No students found in the database.');
      process.exit(0);
    }

    console.log(`Found ${usersSnapshot.size} student(s). Deleting...`);

    let deletedCount = 0;

    for (const doc of usersSnapshot.docs) {
      const uid = doc.id;
      const userData = doc.data();

      console.log(`Deleting student: ${userData.email} (UID: ${uid})`);

      try {
        // Delete from Firebase Auth
        await auth.deleteUser(uid);
      } catch (err) {
        if (err.code === 'auth/user-not-found') {
          console.log(`  User ${uid} not found in Auth, skipping auth deletion.`);
        } else {
          console.error(`  Failed to delete from Auth: ${err.message}`);
        }
      }

      // Delete from Firestore
      await db.collection('users').doc(uid).delete();
      deletedCount++;
    }

    console.log(`\nSuccessfully deleted ${deletedCount} student(s).`);
  } catch (error) {
    console.error('Error deleting students:', error);
  }
}

deleteAllStudents();
