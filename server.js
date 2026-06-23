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

function sanitizeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '');
}

function broadcastToStudents(lobbyCode, message) {
  if (!lobbies[lobbyCode]) return;
  const packet = JSON.stringify(message);
  Object.values(lobbies[lobbyCode].students).forEach(studentWs => {
    if (studentWs.readyState === 1) {
      studentWs.send(packet);
    }
  });
}

const PISTON_URL = 'https://emkc.org/api/v2/piston/execute';

const PISTON_LANGS = {
  c: { language: 'c', version: '10.2.0', filename: 'main.c' },
  cpp: { language: 'c++', version: '10.2.0', filename: 'main.cpp' },
  r: { language: 'r', version: '4.1.1', filename: 'main.r' },
  sql: { language: 'sqlite3', version: '3.36.0', filename: 'main.sql' },
};

async function executeViaPiston(language, code) {
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
    return { output: `Execution service unavailable: ${err.message}. Try Python or JavaScript (runs locally).` };
  }
}

function executeLocally(language, code, safeId, callback) {
  let command = '';
  let fileName = '';

  if (language === 'javascript') {
    fileName = path.join(tempDir, `${safeId}_run.js`);
    command = `node "${fileName}"`;
  } else if (language === 'python') {
    fileName = path.join(tempDir, `${safeId}_run.py`);
    command = `python "${fileName}"`;
  } else {
    callback({ output: `Language '${language}' is not available for local execution.` });
    return;
  }

  fs.writeFileSync(fileName, code);

  exec(command, { timeout: 10000 }, (error, stdout, stderr) => {
    const output = error ? (stderr || error.message) : stdout;
    callback({ output: output || 'Program finished with no output.' });
    fs.unlink(fileName, () => {});
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
              payload: { rollNumber: userSession.rollNumber, delta: payload.code || payload, language: payload.language || '' }
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

        const { language, code } = payload;
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

        if (language === 'python' || language === 'javascript') {
          executeLocally(language, code, safeId, sendResult);
        } else if (PISTON_LANGS[language]) {
          const result = await executeViaPiston(language, code);
          sendResult(result);
        } else {
          sendResult({ output: `Language '${language}' is not supported.` });
        }
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