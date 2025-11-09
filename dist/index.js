"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const commands_1 = require("./cli/commands");
(0, commands_1.runCLI)(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exit(1);
});
//# sourceMappingURL=index.js.map