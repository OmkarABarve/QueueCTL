import { runCLI } from './cli/commands';

runCLI(process.argv.slice(2)).catch((e) => {
  console.error(e);
  process.exit(1);
});