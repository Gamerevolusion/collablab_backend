const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

function sanitizeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '');
}

const crypto = require('crypto');
const tempExecDir = path.join(__dirname, 'temp_executions');
if (!fs.existsSync(tempExecDir)) fs.mkdirSync(tempExecDir);

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
    cmd: (file) => `gcc ${file} -o out && ./out`
  },
  cpp: {
    image: 'gcc:12',
    ext: '.cpp',
    cmd: (file) => `g++ ${file} -o out && ./out`
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
    cmd: (file) => `javac ${file} && java Main`
  }
};

async function executeViaDocker(language, code, stdin) {
  return new Promise((resolve) => {
    const config = DOCKER_LANGS[language];
    if (!config) return resolve({ output: `Language '${language}' is not supported.` });

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

    const dockerArgs = [
      'run', '--rm', '-i',
      '--net', 'none', // Block internet access
      '--memory', '100m', // Restrict memory
      '-v', `${volumePath}:/app`,
      '-w', '/app',
      config.image,
      'sh', '-c', shellCmd
    ];

    const child = spawn('docker', dockerArgs);
    let outputStr = '';
    let errStr = '';

    child.stdout.on('data', (data) => {
      outputStr += data.toString();
    });

    child.stderr.on('data', (data) => {
      errStr += data.toString();
    });

    child.on('close', (codeStatus) => {
      // Cleanup temp directory
      try { fs.rmSync(execDir, { recursive: true, force: true }); } catch(e){}
      
      // Sometimes Docker prints image pull logs to stderr, filter them out if needed.
      if (errStr.trim() && !errStr.includes('Unable to find image')) {
        resolve({ output: errStr });
      } else {
        resolve({ output: outputStr || 'Program finished with no output.' });
      }
    });

    child.on('error', (err) => {
      try { fs.rmSync(execDir, { recursive: true, force: true }); } catch(e){}
      resolve({ output: `Docker execution error: ${err.message}. Is Docker installed and running?` });
    });
  });
}

function initializeWebSockets(server, admin) {
  const wss = new WebSocketServer({ server });
  const lobbies = {};

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

    ws.on('message', async (message) => {
      try {
        const packet = JSON.parse(message);
        const { type, lobbyCode, payload } = packet;

        if (type === 'JOIN_ROOM') {
          const { rollNumber, role, name } = payload;
          
          if (!lobbies[lobbyCode]) {
            lobbies[lobbyCode] = { professor: null, students: {} };
          }
          currentLobby = lobbyCode;
          const safeRollNumber = role === 'student' ? sanitizeId(rollNumber) : rollNumber;
          userSession = { rollNumber: safeRollNumber, role };

          if (role === 'professor') {
            lobbies[lobbyCode].professor = ws;
            console.log(`Professor joined lobby: ${lobbyCode}`);
            Object.keys(lobbies[lobbyCode].students).forEach(studentRoll => {
              const studentData = lobbies[lobbyCode].students[studentRoll];
              ws.send(JSON.stringify({
                type: 'STUDENT_CONNECTED',
                payload: { rollNumber: studentRoll, name: studentData.name }
              }));
            });
          } else {
            lobbies[lobbyCode].students[safeRollNumber] = { ws, name: name || safeRollNumber };
            console.log(`Student ${safeRollNumber} (${name}) joined lobby: ${lobbyCode}`);
            
            const profSocket = lobbies[lobbyCode].professor;
            if (profSocket && profSocket.readyState === 1) {
              profSocket.send(JSON.stringify({
                type: 'STUDENT_CONNECTED',
                payload: { rollNumber: safeRollNumber, name: name || safeRollNumber }
              }));
            }
          }
        }

        if (type === 'SYNC_UPDATE') {
          if (!currentLobby || userSession.role !== 'student') return;
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
          if (!currentLobby || userSession.role !== 'student') return;
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
            broadcastToStudents(currentLobby, {
              type: 'ANNOUNCEMENT',
              payload: { message: payload.message, timestamp: Date.now() }
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
          if (!currentLobby || userSession.role !== 'student') return;

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

          const resultPacket = JSON.stringify({
            type: 'EXECUTION_RESULT',
            payload: { rollNumber: safeId, output: 'Running...' }
          });
          ws.send(resultPacket);

          if (lobbies[currentLobby]) {
            const profSocket = lobbies[currentLobby].professor;
            if (profSocket && profSocket.readyState === 1) {
              console.log(`Executing ${language} for student ${safeId} in lobby ${currentLobby}`);
              profSocket.send(resultPacket);
            }
          }

          const sendResult = (result) => {
            const resultPacket = JSON.stringify({
              type: 'EXECUTION_RESULT',
              payload: { rollNumber: safeId, output: result.output }
            });
            ws.send(resultPacket);
            if (lobbies[currentLobby]) {
              const profSocket = lobbies[currentLobby].professor;
              if (profSocket && profSocket.readyState === 1) {
                console.log(`Executing ${language} for student ${safeId} in lobby ${currentLobby}`);
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
      if (!currentLobby || !lobbies[currentLobby]) return;

      if (userSession && userSession.role === 'student') {
        delete lobbies[currentLobby].students[userSession.rollNumber];
        if (lobbies[currentLobby].professor && lobbies[currentLobby].professor.readyState === 1) {
          lobbies[currentLobby].professor.send(JSON.stringify({
            type: 'STUDENT_DISCONNECTED',
            payload: { rollNumber: userSession.rollNumber }
          }));
        }
      } else if (userSession && userSession.role === 'professor') {
        console.log(`Professor left lobby: ${currentLobby}`);
        broadcastToStudents(currentLobby, {
          type: 'ERROR',
          payload: 'The professor has ended this session. Please rejoin later.'
        });
        
        // Handle Session End in Firestore
        if (admin.apps.length > 0) {
          try {
            const db = admin.firestore();
            const sessionQuery = await db.collection('sessions')
              .where('lobbyCode', '==', currentLobby)
              .where('endedAt', '==', null)
              .limit(1)
              .get();
              
            if (!sessionQuery.empty) {
              const sessionDoc = sessionQuery.docs[0];
              await sessionDoc.ref.update({
                endedAt: FieldValue.serverTimestamp()
              });
              console.log(`Automatically ended session ${currentLobby} in Firestore.`);
            }
          } catch (err) {
            console.error('Failed to update session endedAt in Firestore:', err);
          }
        }
        
        delete lobbies[currentLobby];
      }
    });
  });
}

module.exports = { initializeWebSockets };
