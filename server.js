const { WebSocketServer } = require('ws');
const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const server = http.createServer();
const wss = new WebSocketServer({ server });

const lobbies = {};

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

// Sanitize student ID to prevent path traversal
function sanitizeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '');
}

function broadcastToStudents(lobbyCode, message) {
  if (!lobbies[lobbyCode]) return;
  const packet = JSON.stringify(message);
  Object.values(lobbies[lobbyCode].students).forEach(studentWs => {
    if (studentWs.readyState === 1) { // WebSocket.OPEN
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

        if (role === 'student' && !lobbies[lobbyCode]) {
          ws.send(JSON.stringify({ type: 'ERROR', payload: `Lobby ${lobbyCode} does not exist.` }));
          return;
        }

        currentLobby = lobbyCode;
        userSession = { rollNumber: sanitizeId(rollNumber), role };

        if (!lobbies[lobbyCode]) lobbies[lobbyCode] = { professor: null, students: {} };

        if (role === 'professor') {
          lobbies[lobbyCode].professor = ws;
          console.log(`Professor created lobby: ${lobbyCode}`);
        } else {
          lobbies[lobbyCode].students[userSession.rollNumber] = ws;
          if (lobbies[lobbyCode].professor && lobbies[lobbyCode].professor.readyState === 1) {
            lobbies[lobbyCode].professor.send(JSON.stringify({
              type: 'STUDENT_CONNECTED',
              payload: { rollNumber: userSession.rollNumber }
            }));
          }
        }
        return;
      }

      if (type === 'SYNC_UPDATE') {
        if (!currentLobby || !lobbies[currentLobby]) return;
        if (userSession.role === 'student') {
          const profSocket = lobbies[currentLobby].professor;
          if (profSocket && profSocket.readyState === 1) {
            profSocket.send(JSON.stringify({
              type: 'STUDENT_STREAM',
              payload: { rollNumber: userSession.rollNumber, delta: payload }
            }));
          }
        }
      }

      if (type === 'HAND_RAISE') {
        if (!currentLobby || !lobbies[currentLobby]) return;
        if (userSession.role === 'student') {
          const profSocket = lobbies[currentLobby].professor;
          if (profSocket && profSocket.readyState === 1) {
            profSocket.send(JSON.stringify({
              type: 'HAND_RAISE',
              payload: { rollNumber: userSession.rollNumber }
            }));
          }
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

      if (type === 'EXECUTE_CODE') {
        if (!currentLobby || userSession.role !== 'student') return;

        const { language, code } = payload;
        const safeId = userSession.rollNumber;

        let command = '';
        let fileName = '';

        if (language === 'javascript' || language === 'html') {
          fileName = path.join(tempDir, `${safeId}_run.js`);
          command = `node "${fileName}"`;
        } else if (language === 'python') {
          fileName = path.join(tempDir, `${safeId}_run.py`);
          command = `python "${fileName}"`;
        } else {
          ws.send(JSON.stringify({
            type: 'EXECUTION_RESULT',
            payload: { rollNumber: safeId, output: `Language '${language}' is disabled in Local MVP mode. Please use Python or JavaScript.` }
          }));
          return;
        }

        fs.writeFileSync(fileName, code);

        exec(command, { timeout: 5000 }, (error, stdout, stderr) => {
          const output = error ? (stderr || error.message) : stdout;

          const resultPacket = JSON.stringify({
            type: 'EXECUTION_RESULT',
            payload: { rollNumber: safeId, output: output || 'Program finished with no output.' }
          });

          ws.send(resultPacket);

          if (lobbies[currentLobby]) {
            const profSocket = lobbies[currentLobby].professor;
            if (profSocket && profSocket.readyState === 1) {
              profSocket.send(resultPacket);
            }
          }

          fs.unlink(fileName, () => {});
        });
      }

    } catch (err) {
      console.error('Packet Error:', err);
    }
  });

  ws.on('close', () => {
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
      delete lobbies[currentLobby];
    }
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`CollabLab Gateway Server running on port ${PORT}`));