// Test only, loaded with --import: makes the real bridge start fake-pi.mjs instead of Pi's program.
// The bridge has no setting for choosing which program to run, and shouldn't get one.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const fakePi = fileURLToPath(new URL("./fake-pi.mjs", import.meta.url));
const realSpawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => realSpawn(command, String(args?.[0]).endsWith("/bundle/cli.js") ? [fakePi, ...args.slice(1)] : args, options);
syncBuiltinESMExports();
