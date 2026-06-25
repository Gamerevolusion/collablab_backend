const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

function sanitizeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '');
}

const PISTON_URL = process.env.PISTON_URL || 'http://localhost:2000/api/v2/execute';

const PISTON_LANGS = {
  c: { language: 'c', version: '10.2.0', filename: 'main.c' },
  cpp: { language: 'c++', version: '10.2.0', filename: 'main.cpp' },
  r: { language: 'r', version: '4.1.1', filename: 'main.r' },
  sql: { language: 'sqlite3', version: '3.36.0', filename: 'main.sql' },
  python: { language: 'python', version: '3.10.0', filename: 'main.py' },
  javascript: { language: 'javascript', version: '18.15.0', filename: 'main.js' },
};

async function executeViaPiston(language, code, stdin) {
  const config = PISTON_LANGS[language];
  if (!config) return { output: `Language '${language}' is not supported via Piston.` };

  try {
    const response = await fetch(PISTON_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        language: config.language,
        version: config.version,
        files: [{ name: config.filename, content: code }],
        stdin: stdin || "",
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return { output: `Piston API error (${response.status}): ${text}` };
    }

    const result = await response.json();
    const runOutput = result.run || {};
    if (runOutput.stderr && runOutput.stderr.trim()) {
      return { output: runOutput.stderr };
    }
    return { output: runOutput.stdout || 'Program finished with no output.' };
  } catch (err) {
    return { output: `Execution service unavailable: ${err.message}.` };
  }
}

function initializeWebSockets(server, admin) {
  const wss = new WebSocketServer({ server });
  const lobbies = {};

  function broadcastToStudents(lobbyCode, message) {
    if (!lobbies[lobbyCode]) return;
    const packet = JSON.stringify(message);
    Object.values(lobbies[lobbyCode].students).forEach(studentWs => {
      if (studentWs.readyState === 1) {
        studentWs.send(packet);
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
          const { rollNumber, role } = payload;
          
          if (!lobbies[lobbyCode]) {
            lobbies[lobbyCode] = { professor: null, students: {} };
          }
          currentLobby = lobbyCode;
          userSession = { rollNumber, role };

          if (role === 'professor') {
            lobbies[lobbyCode].professor = ws;
            console.log(`Professor joined lobby: ${lobbyCode}`);
            Object.keys(lobbies[lobbyCode].students).forEach(studentRoll => {
              ws.send(JSON.stringify({
                type: 'STUDENT_CONNECTED',
                payload: { rollNumber: studentRoll }
              }));
            });
          } else {
            const safeRoll = sanitizeId(rollNumber);
            lobbies[lobbyCode].students[safeRoll] = ws;
            console.log(`Student ${safeRoll} joined lobby: ${lobbyCode}`);
            
            const profSocket = lobbies[lobbyCode].professor;
            if (profSocket && profSocket.readyState === 1) {
              profSocket.send(JSON.stringify({
                type: 'STUDENT_CONNECTED',
                payload: { rollNumber: safeRoll }
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
            const studentSocket = lobbies[currentLobby].students[targetRoll];
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
          const safeId = userSession.rollNumber;

          if (language === 'html') {
            const resultPacket = JSON.stringify({
              type: 'EXECUTION_RESULT',
              payload: { rollNumber: safeId, output: 'HTML preview rendered on client.' }
            });
            ws.send(resultPacket);
            return;
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
                profSocket.send(resultPacket);
              }
            }
          };

          const result = await executeViaPiston(language, code, stdin);
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
                endedAt: admin.firestore.FieldValue.serverTimestamp()
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
