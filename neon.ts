import { defineConfig } from "@neondatabase/config/v1";

export default defineConfig({
  auth: false,
  functions: {
    api: {
      name: "Contas API",
      source: "./functions/api"
    }
  }
});
