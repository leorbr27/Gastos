import { defineConfig } from "@neondatabase/config/v1";

export default defineConfig({
  auth: true,
  functions: {
    api: {
      name: "Gastos API",
      source: "./functions/api"
    }
  }
});
