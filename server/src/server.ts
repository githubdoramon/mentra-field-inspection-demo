import { createServer } from "node:http";
import { serve } from "./app.js";
import { config } from "./config.js";
import { ensureDataDirs } from "./storage.js";

await ensureDataDirs();
const server = createServer((req, res) => {
  void serve(req, res);
});
server.listen(config.port, config.host, () =>
  console.log(`Mentra inspection server listening on http://${config.host}:${config.port}`),
);
