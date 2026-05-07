import { Readable, Writable } from "node:stream";
import { startAcpServer } from "./acp/server.ts";
import { createStdioAcpStream } from "./acp/transport/stdio.ts";

const stdoutWritable = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
const stdinReadable = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;

const stream = createStdioAcpStream(stdoutWritable, stdinReadable);
const connection = startAcpServer({ stream });

await connection.closed;