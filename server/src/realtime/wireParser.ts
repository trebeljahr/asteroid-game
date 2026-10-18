import { Encoder } from "socket.io-msgpack-parser";
import { Decoder } from "socket.io-parser";

/**
 * Socket.IO parser of the server: msgpack out, JSON in. The client uses
 * the mirror image (client/src/netcode/wireParser.ts).
 *
 * Snapshots and world events are nearly all the bytes, and msgpack sends
 * them about a third smaller than JSON. What clients send is small and
 * untrusted, so it stays JSON: the msgpack decoder (notepack.io) allocates
 * and fills whatever length a frame declares, so a 6-byte frame could make
 * the server allocate and zero 4 GB before any check runs.
 */
export const wireParser = { Decoder, Encoder };
