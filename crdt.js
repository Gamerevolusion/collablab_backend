const { WebSocketServer } = require('ws');
const { setupWSConnection } = require('y-websocket/bin/utils.js');

// Initialize a standalone WebSocket server for Yjs CRDT sync
const PORT = process.env.CRDT_PORT || 1234;
const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (conn, req) => {
  setupWSConnection(conn, req);
});

console.log(`CollabLab CRDT Sync Engine active on port ${PORT}`);
