import dotenv from "dotenv";
import path from "path";

// Load from root .env in single-package layout.
process.env.DOTENV_CONFIG_SILENT = "true";
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
