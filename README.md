# CollabLab — Backend

WebSocket gateway server for CollabLab. Handles lobby management, real-time code streaming, remote code execution, and hand-raise signaling.

## Features

- **Lobby System** — Professors create lobbies, students join with an ID
- **Code Streaming** — Student keystrokes are streamed to the professor's monitoring grid
- **Code Execution** — Runs student Python/JavaScript code natively via `child_process.exec`
- **Hand Raise** — Relays hand-raise and acknowledgment signals between students and professors
- **Auto Cleanup** — Lobbies are automatically cleaned up when the professor disconnects

## Getting Started

```bash
# Install dependencies
npm install

# Start the server
npm start
```

The server runs on port `4000` by default. Set the `PORT` environment variable to change it.

## Deployment (Render)

This server is deployed on [Render](https://render.com):
- **Start Command**: `npm start`
- **Environment**: Node.js

## WebSocket Protocol

All messages follow the format:
```json
{
  "type": "MESSAGE_TYPE",
  "lobbyCode": "CS101-LAB3",
  "payload": { ... }
}
```

### Message Types

| Type | Direction | Description |
|------|-----------|-------------|
| `JOIN_ROOM` | Client → Server | Join or create a lobby |
| `SYNC_UPDATE` | Student → Server → Professor | Stream code changes |
| `EXECUTE_CODE` | Student → Server | Execute code (Python/JS) |
| `EXECUTION_RESULT` | Server → Client | Code execution output |
| `STUDENT_CONNECTED` | Server → Professor | Student joined notification |
| `STUDENT_DISCONNECTED` | Server → Professor | Student left notification |
| `HAND_RAISE` | Student → Server → Professor | Student requests help |
| `HAND_LOWER` | Either → Server → Other | Hand acknowledged / lowered |
| `ERROR` | Server → Client | Error message |

## Security Notes

> ⚠️ **Local MVP Mode**: Code execution runs natively on the host machine with no sandboxing.
> For production deployment, implement Docker containers or use a service like Judge0.

Student IDs are sanitized to prevent path traversal attacks in temp file creation.
