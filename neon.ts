import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  functions: {
    api: {
      name: "Gastos API",
      source: "./functions/api"
    }
  }
});
