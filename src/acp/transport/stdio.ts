import { ndJsonStream, type Stream } from "@agentclientprotocol/sdk";

export function createStdioAcpStream(
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
): Stream {
  return ndJsonStream(output, input);
}