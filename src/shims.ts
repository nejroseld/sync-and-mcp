// Injected by esbuild so Node-style globals exist on mobile Obsidian (no Node there).
import { Buffer } from "buffer";
import process from "process";
(globalThis as any).Buffer ??= Buffer;
(globalThis as any).process ??= process;
export { Buffer, process };
