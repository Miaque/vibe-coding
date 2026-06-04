import dotenv from "dotenv";

export function loadProjectEnv(path = ".env") {
  dotenv.config({ path, quiet: true });
}
