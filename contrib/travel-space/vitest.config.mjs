import config from "./vite.config.mjs";
export default { ...config, plugins: [], test: { environment: "node", include: ["src/**/*.test.ts"], maxWorkers: 1 } };
