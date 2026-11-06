// Over stdio, stdout is the MCP channel: a line any module prints there
// would corrupt it. Imported first by the server's entry, so everything the
// console would print goes to stderr instead, where the agent's log keeps it.

console.log = console.error;
console.info = console.error;
console.debug = console.error;
