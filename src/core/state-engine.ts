// Re-export from new engine module for backward compatibility
export {
  createSession,
  getSession,
  incrementCall,
  addRecord,
  resetSession,
  deleteSession,
  listSessions,
  isReadTool,
  markGhostCommitted,
  type KeyState,
  type KeyTracking,
  type SessionState,
  type CallRecord,
} from "../engine/state-machine.js";