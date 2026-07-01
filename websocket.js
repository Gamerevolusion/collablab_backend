const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

const tempExecDir = path.join(__dirname, 'temp_executions');
if (!fs.existsSync(tempExecDir)) fs.mkdirSync(tempExecDir);

function sanitizeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '');
}

// Sanitize text content (strip HTML tags, limit length)
function sanitizeText(text, maxLength = 500) {
  if (typeof text !== 'string') return '';
  return text.replace(/<[^>]*>/g, '').substring(0, maxLength);
}

const MAX_CODE_SIZE = 100 * 1024; // 100KB
const DOCKER_TIMEOUT_MS = 15000; // 15 seconds
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_MESSAGES = 20;
const HEARTBEAT_INTERVAL_MS = 25000; // 25 seconds
const PROFESSOR_GRACE_PERIOD_MS = 30000; // 30 seconds

const DOCKER_LANGS = {
  javascript: {
    image: 'node:18-alpine',
    ext: '.js',
    cmd: (file) => `node ${file}`
  },
  python: {
    image: 'python:3.10-alpine',
    ext: '.py',
    cmd: (file) => `python ${file}`
  },
  c: {
    image: 'gcc:12',
    ext: '.c',
    cmd: (file) => `gcc ${file} -o /tmp/out && /tmp/out`
  },
  cpp: {
    image: 'gcc:12',
    ext: '.cpp',
    cmd: (file) => `g++ ${file} -o /tmp/out && /tmp/out`
  },
  r: {
    image: 'r-base:latest',
    ext: '.R',
    cmd: (file) => `Rscript ${file}`
  },
  sql: {
    image: 'alpine:latest',
    ext: '.sql',
    cmd: (file) => `apk add --no-cache sqlite && sqlite3 < ${file}`
  },
  java: {
    image: 'eclipse-temurin:17-alpine',
    ext: '.java',
    cmd: (file) => `javac -d /tmp ${file} && java -cp /tmp Main`
  }
};

async function executeViaDocker(language, code, stdin) {
  return new Promise((resolve) => {
    const config = DOCKER_LANGS[language];
    if (!config) return resolve({ output: `Language '${language}' is not supported.` });

    // MED-2: Enforce code size limit
    if (code.length > MAX_CODE_SIZE) {
      return resolve({ output: `Error: Code exceeds maximum size (${MAX_CODE_SIZE / 1024}KB).` });
    }

    const execId = crypto.randomUUID();
    const execDir = path.join(tempExecDir, execId);
    fs.mkdirSync(execDir, { recursive: true });

    const codeFile = language === 'java' ? 'Main.java' : `main${config.ext}`;
    const codePath = path.join(execDir, codeFile);
    fs.writeFileSync(codePath, code);

    const inputPath = path.join(execDir, 'input.txt');
    fs.writeFileSync(inputPath, stdin || '');

    // Convert Windows paths correctly if necessary
    let volumePath = path.resolve(execDir);
    if (os.platform() === 'win32') {
      volumePath = volumePath.replace(/\\/g, '/');
      volumePath = '/' + volumePath.replace(':', '');
    }
    
    // Command: cd /app && (cmd) < input.txt
    const shellCmd = `cd /app && ${config.cmd(codeFile)} < input.txt`;

    // CRIT-4: Docker hardening — read-only volume, pids-limit, cpus, tmpfs
    const dockerArgs = [
      'run', '--rm', '-i',
      '--net', 'none',           // Block internet access
      '--memory', '100m',        // Restrict memory
      '--pids-limit', '50',      // Prevent fork bombs
      '--cpus', '0.5',           // Prevent CPU starvation
      '--tmpfs', '/tmp:size=10m', // Writable temp for compilation output
      '-v', `${volumePath}:/app:ro`, // Read-only mount
      '-w', '/app',
      config.image,
      'sh', '-c', shellCmd
    ];

    const child = spawn('docker', dockerArgs);
    let outputStr = '';
    let errStr = '';
    let killed = false;

    // HIGH-3: Server-side execution timeout
    const killTimer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, DOCKER_TIMEOUT_MS);

    child.stdout.on('data', (data) => {
      outputStr += data.toString();
    });

    child.stderr.on('data', (data) => {
      errStr += data.toString();
    });

    child.on('close', (codeStatus) => {
      clearTimeout(killTimer);
      // Cleanup temp directory
      try { fs.rmSync(execDir, { recursive: true, force: true }); } catch(e){}
      
      if (killed) {
        return resolve({ output: `Execution timed out after ${DOCKER_TIMEOUT_MS / 1000}s. Your code may contain an infinite loop.` });
      }

      // Sometimes Docker prints image pull logs to stderr, filter them out if needed.
      if (errStr.trim() && !errStr.includes('Unable to find image')) {
        resolve({ output: errStr });
      } else {
        resolve({ output: outputStr || 'Program finished with no output.' });
      }
    });

    child.on('error', (err) => {
      clearTimeout(killTimer);
      try { fs.rmSync(execDir, { recursive: true, force: true }); } catch(e){}
      resolve({ output: `Docker execution error: ${err.message}. Is Docker installed and running?` });
    });
  });
}

// CRIT-3: Verify Firebase ID token
async function verifyToken(token) {
  if (!getApps().length) return null;
  try {
    const decoded = await getAuth().verifyIdToken(token);
    // Look up the user's actual role from Firestore
    const db = getFirestore();
    const userDoc = await db.collection('users').doc(decoded.uid).get();
    if (userDoc.exists) {
      const profile = userDoc.data();
      return {
        uid: decoded.uid,
        email: decoded.email,
        role: profile.role || 'student',
        displayName: profile.displayName || '',
        rollNumber: profile.rollNumber || '',
      };
    }
    return { uid: decoded.uid, email: decoded.email, role: 'student', displayName: '', rollNumber: '' };
  } catch (err) {
    console.error('Token verification failed:', err.message);
    return null;
  }
}

function initializeWebSockets(server) {
  const wss = new WebSocketServer({ server });
  const lobbies = {};

  // Track professor grace period timers
  const professorGraceTimers = {};

  // --- Heartbeat: detect and clean up dead connections ---
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws._isAlive === false) {
        // Connection didn't respond to the last ping — terminate it
        return ws.terminate();
      }
      ws._isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL_MS);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  function broadcastToStudents(lobbyCode, message) {
    if (!lobbies[lobbyCode]) return;
    const packet = JSON.stringify(message);
    Object.values(lobbies[lobbyCode].students).forEach(studentData => {
      if (studentData.ws && studentData.ws.readyState === 1) {
        studentData.ws.send(packet);
      }
    });
  }

  wss.on('connection', (ws) => {
    let currentLobby = null;
    let userSession = null;
    let authenticated = false;

    // Mark connection as alive for heartbeat
    ws._isAlive = true;
    ws.on('pong', () => { ws._isAlive = true; });

    // MED-1: Rate limiting per connection
    let messageCount = 0;
    const rateLimitInterval = setInterval(() => { messageCount = 0; }, RATE_LIMIT_WINDOW_MS);

    ws.on('message', async (message) => {
      try {
        // MED-1: Rate limit check
        messageCount++;
        if (messageCount > RATE_LIMIT_MAX_MESSAGES) {
          return; // Silently drop excess messages
        }

        const packet = JSON.parse(message);
        const { type, lobbyCode, payload } = packet;

        // CRIT-3: First message must be AUTH with a Firebase ID token
        if (type === 'AUTH') {
          const token = payload?.token;
          if (!token) {
            ws.send(JSON.stringify({ type: 'AUTH_ERROR', payload: 'Token required.' }));
            return;
          }
          
          // If Firebase Admin SDK is not initialized, allow unauthenticated (dev mode)
          if (!getApps().length) {
            console.warn('Firebase Admin not initialized — allowing unauthenticated connection (dev mode)');
            authenticated = true;
            ws.send(JSON.stringify({ type: 'AUTH_OK', payload: { verified: false } }));
            return;
          }

          const verifiedUser = await verifyToken(token);
          if (!verifiedUser) {
            ws.send(JSON.stringify({ type: 'AUTH_ERROR', payload: 'Invalid or expired token.' }));
            ws.close();
            return;
          }

          authenticated = true;
          // Store verified identity — cannot be overridden by client
          ws._verifiedUser = verifiedUser;
          ws.send(JSON.stringify({ type: 'AUTH_OK', payload: { verified: true, role: verifiedUser.role } }));
          return;
        }

        // All subsequent messages require authentication
        // If Admin SDK is not initialized (dev mode), still allow messages without auth
        if (!authenticated && getApps().length) {
          ws.send(JSON.stringify({ type: 'AUTH_ERROR', payload: 'Please authenticate first.' }));
          return;
        }

        if (type === 'JOIN_ROOM') {
          const { rollNumber, role, name } = payload;
          
          // Use server-verified role if available, otherwise trust client (dev mode)
          const verifiedRole = ws._verifiedUser?.role || role;
          const verifiedName = ws._verifiedUser?.displayName || name;
          const verifiedRollNumber = ws._verifiedUser?.rollNumber || rollNumber;

          // MED-4: Only professors can create lobbies, students must join existing ones
          if (!lobbies[lobbyCode]) {
            if (verifiedRole !== 'professor') {
              ws.send(JSON.stringify({ type: 'ERROR', payload: 'This lobby does not exist. Please check the code.' }));
              return;
            }
            lobbies[lobbyCode] = { professor: null, students: {} };
          }

          currentLobby = lobbyCode;
          const safeRollNumber = verifiedRole === 'student' ? sanitizeId(verifiedRollNumber) : verifiedRollNumber;
          userSession = { rollNumber: safeRollNumber, role: verifiedRole };

          if (verifiedRole === 'professor') {
            // Cancel any pending grace period timer for this lobby
            if (professorGraceTimers[lobbyCode]) {
              clearTimeout(professorGraceTimers[lobbyCode]);
              delete professorGraceTimers[lobbyCode];
              console.log(`Professor reconnected to lobby ${lobbyCode} within grace period.`);
            }

            lobbies[lobbyCode].professor = ws;
            console.log(`Professor joined lobby: ${lobbyCode}`);
            // Send current roster to professor
            Object.keys(lobbies[lobbyCode].students).forEach(studentRoll => {
              const studentData = lobbies[lobbyCode].students[studentRoll];
              ws.send(JSON.stringify({
                type: 'STUDENT_CONNECTED',
                payload: { rollNumber: studentRoll, name: studentData.name }
              }));
            });
          } else {
            // --- Deduplicate: if this rollNumber already has an active connection, close the old one ---
            const existingStudent = lobbies[lobbyCode].students[safeRollNumber];
            if (existingStudent && existingStudent.ws && existingStudent.ws.readyState === 1) {
              console.log(`Replacing stale connection for student ${safeRollNumber} in lobby ${lobbyCode}`);
              // Prevent the old connection's close handler from broadcasting STUDENT_DISCONNECTED
              existingStudent.ws._replaced = true;
              existingStudent.ws.close();
            }

            lobbies[lobbyCode].students[safeRollNumber] = { ws, name: verifiedName || safeRollNumber };
            console.log(`Student ${safeRollNumber} (${verifiedName}) joined lobby: ${lobbyCode}`);
            
            const profSocket = lobbies[lobbyCode].professor;
            if (profSocket && profSocket.readyState === 1) {
              profSocket.send(JSON.stringify({
                type: 'STUDENT_CONNECTED',
                payload: { rollNumber: safeRollNumber, name: verifiedName || safeRollNumber }
              }));
            }
          }
        }

        if (type === 'SYNC_UPDATE') {
          if (!currentLobby || !lobbies[currentLobby] || userSession.role !== 'student') return;
          const profSocket = lobbies[currentLobby].professor;
          if (profSocket && profSocket.readyState === 1) {
            profSocket.send(JSON.stringify({
              type: 'STUDENT_STREAM',
              payload: {
                rollNumber: userSession.rollNumber,
                delta: payload.code,
                language: payload.language,
                fileName: payload.fileName
              }
            }));
          }
        }

        if (type === 'HAND_RAISE') {
          if (!currentLobby || !lobbies[currentLobby] || userSession.role !== 'student') return;
          const profSocket = lobbies[currentLobby].professor;
          if (profSocket && profSocket.readyState === 1) {
            profSocket.send(JSON.stringify({
              type: 'HAND_RAISE',
              payload: { rollNumber: userSession.rollNumber }
            }));
          }
        }

        if (type === 'HAND_LOWER') {
          if (!currentLobby || !lobbies[currentLobby]) return;
          const targetRoll = sanitizeId(payload.rollNumber);

          if (userSession.role === 'professor') {
            const studentSocket = lobbies[currentLobby].students[targetRoll]?.ws;
            if (studentSocket && studentSocket.readyState === 1) {
              studentSocket.send(JSON.stringify({
                type: 'HAND_LOWER',
                payload: { rollNumber: targetRoll }
              }));
            }
          }

          if (userSession.role === 'student') {
            const profSocket = lobbies[currentLobby].professor;
            if (profSocket && profSocket.readyState === 1) {
              profSocket.send(JSON.stringify({
                type: 'HAND_LOWER',
                payload: { rollNumber: userSession.rollNumber }
              }));
            }
          }
        }

        if (type === 'ANNOUNCEMENT') {
          if (!currentLobby || !lobbies[currentLobby]) return;
          if (userSession.role === 'professor') {
            // LOW-2: Sanitize announcement content
            const safeMessage = sanitizeText(payload.message, 1000);
            broadcastToStudents(currentLobby, {
              type: 'ANNOUNCEMENT',
              payload: { message: safeMessage, timestamp: Date.now() }
            });
          }
        }

        if (type === 'PASTE_DETECTED') {
          if (!currentLobby || !lobbies[currentLobby]) return;
          if (userSession.role === 'student') {
            const profSocket = lobbies[currentLobby].professor;
            if (profSocket && profSocket.readyState === 1) {
              profSocket.send(JSON.stringify({
                type: 'PASTE_DETECTED',
                payload: { rollNumber: userSession.rollNumber, charCount: payload.charCount, timestamp: Date.now() }
              }));
            }
          }
        }

        if (type === 'EXECUTE_CODE') {
          if (!currentLobby || !lobbies[currentLobby] || userSession.role !== 'student') return;

          const { language, code, stdin } = payload;
          const safeId = userSession.rollNumber; // already sanitized at join time

          if (language === 'html') {
            const resultPacket = JSON.stringify({
              type: 'EXECUTION_RESULT',
              payload: { rollNumber: safeId, output: 'HTML preview rendered on client.' }
            });
            ws.send(resultPacket);
            return;
          }

          const runningPacket = JSON.stringify({
            type: 'EXECUTION_RESULT',
            payload: { rollNumber: safeId, output: 'Running...' }
          });
          ws.send(runningPacket);

          if (lobbies[currentLobby]) {
            const profSocket = lobbies[currentLobby].professor;
            if (profSocket && profSocket.readyState === 1) {
              console.log(`Executing ${language} for student ${safeId} in lobby ${currentLobby}`);
              profSocket.send(runningPacket);
            }
          }

          const sendResult = (result) => {
            const resultPacket = JSON.stringify({
              type: 'EXECUTION_RESULT',
              payload: { rollNumber: safeId, output: result.output }
            });
            if (ws.readyState === 1) ws.send(resultPacket);
            if (lobbies[currentLobby]) {
              const profSocket = lobbies[currentLobby].professor;
              if (profSocket && profSocket.readyState === 1) {
                profSocket.send(resultPacket);
              }
            }
          };

          const result = await executeViaDocker(language, code, stdin);
          sendResult(result);
        }

      } catch (err) {
        console.error('Packet Error:', err);
      }
    });

    ws.on('close', async () => {
      clearInterval(rateLimitInterval);
      if (!currentLobby || !lobbies[currentLobby]) return;

      if (userSession && userSession.role === 'student') {
        // If this connection was replaced by a newer one, don't broadcast disconnect
        if (ws._replaced) return;

        delete lobbies[currentLobby].students[userSession.rollNumber];
        if (lobbies[currentLobby].professor && lobbies[currentLobby].professor.readyState === 1) {
          lobbies[currentLobby].professor.send(JSON.stringify({
            type: 'STUDENT_DISCONNECTED',
            payload: { rollNumber: userSession.rollNumber }
          }));
        }
      } else if (userSession && userSession.role === 'professor') {
        console.log(`Professor disconnected from lobby: ${currentLobby}. Starting ${PROFESSOR_GRACE_PERIOD_MS / 1000}s grace period...`);
        
        // Remove the professor socket reference but DON'T destroy the lobby yet
        lobbies[currentLobby].professor = null;

        // Start a grace period timer
        const lobbyToClean = currentLobby;
        professorGraceTimers[lobbyToClean] = setTimeout(async () => {
          delete professorGraceTimers[lobbyToClean];

          // Check if a professor has reconnected during the grace period
          if (lobbies[lobbyToClean] && lobbies[lobbyToClean].professor) {
            console.log(`Professor already reconnected to ${lobbyToClean}, skipping cleanup.`);
            return;
          }

          console.log(`Grace period expired for lobby ${lobbyToClean}. Ending session.`);
          
          // Now broadcast the session ended message and clean up
          if (lobbies[lobbyToClean]) {
            broadcastToStudents(lobbyToClean, {
              type: 'ERROR',
              payload: 'The professor has ended this session. Please rejoin later.'
            });
          }

          // Update Firestore
          if (getApps().length > 0) {
            try {
              const db = getFirestore();
              const sessionQuery = await db.collection('sessions')
                .where('lobbyCode', '==', lobbyToClean)
                .where('endedAt', '==', null)
                .limit(1)
                .get();
                
              if (!sessionQuery.empty) {
                const sessionDoc = sessionQuery.docs[0];
                const studentCount = lobbies[lobbyToClean]
                  ? Object.keys(lobbies[lobbyToClean].students).length
                  : 0;
                await sessionDoc.ref.update({
                  endedAt: FieldValue.serverTimestamp(),
                  studentCount: studentCount,
                });
                console.log(`Ended session ${lobbyToClean} in Firestore (${studentCount} students).`);
              }
            } catch (err) {
              console.error('Failed to update session endedAt in Firestore:', err);
            }
          }
          
          delete lobbies[lobbyToClean];
        }, PROFESSOR_GRACE_PERIOD_MS);
      }
    });
  });
}

module.exports = { initializeWebSockets };
