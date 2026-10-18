import { Decoder } from "socket.io-msgpack-parser";
import { Encoder } from "socket.io-parser";

/**
 * Socket.IO parser of the client: JSON out, msgpack in. The mirror image
 * of the server's (server/src/realtime/wireParser.ts), which sends
 * snapshots and world events as msgpack and reads only JSON.
 */
export const wireParser = { Decoder, Encoder };
