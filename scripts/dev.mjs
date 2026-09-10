import { spawn } from "node:child_process";

const server = spawn("npm", ["run", "dev:server"], { stdio: "inherit", shell: true });
const client = spawn("npm", ["run", "dev:client"], { stdio: "inherit", shell: true });
const stop = () => { server.kill(); client.kill(); };
process.on("SIGINT", stop); process.on("SIGTERM", stop); process.on("exit", stop);
